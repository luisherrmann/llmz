#!/usr/bin/env python3
"""
Extract tables from a PDF using PyMuPDF.
Install: pip install pymupdf
Usage:   python3 extract_tables.py <pdf_path> <output_json_path>

Output: JSON array of { page_num, table_num, label, caption, data, image_data, position }
  data      — list of rows; each row is a list of cell strings
  image_data — base64 JPEG crop of the table region (caption + table body)
  position  — { pageIndex, rects: [[x0,y0,x1,y1]] } in native (bottom-up) PDF
              space, navigable via the reader's `navigate({ position })`. Omitted
              for tables found via rotation-normalization (see below), where a
              real-page position can't be reliably computed.

Strategy: each table caption defines a region (caption bottom → next caption top
or page bottom) within which find_tables(strategy="text") is run. This works for
both horizontal-ruled and vertical-ruled tables without needing explicit line detection.

Rotated tables (text drawn sideways within an otherwise-portrait page, as opposed to
a page-level /Rotate flag) are handled separately: get_text()/find_tables() both
assume horizontal reading order and produce garbage on rotated text no matter how
tightly the search region is bounded. Instead, regions of non-horizontal text are
found via get_text('dict')'s per-line direction vector, re-drawn onto a synthetic
single-page document with a compensating rotation via Page.show_pdf_page(rotate=...)
(a genuine content-stream transform, not just a display flag), and the normal
caption/table pipeline above is re-run on that normalized page.
"""

import sys
import json
import base64
import re
import math

try:
    import fitz  # PyMuPDF
except ImportError:
    print(f'PyMuPDF not installed for {sys.executable}. Run: {sys.executable} -m pip install pymupdf', file=sys.stderr)
    sys.exit(2)

CAPTION_START_RE = re.compile(
    r'^(?:tab(?:le)?\.?\s*)(\d+)\s*[.:\|–—]',
    re.IGNORECASE
)

CAPTION_CONTINUATION_GAP = 16


def clean_text(text):
    text = re.sub(r'-\n', '-', text)
    text = re.sub(r'\n', ' ', text)
    text = re.sub(r' {2,}', ' ', text)
    return text.strip()


def find_table_bottom_rule(page, top_bound, bottom_bound):
    """
    Finds the bottommost horizontal-rule-line drawing (e.g. LaTeX booktabs'
    \\bottomrule) within [top_bound, bottom_bound], to use as a more precise
    table-bottom boundary than find_tables()'s own bbox estimate -- which can
    overshoot into whatever text follows the table (a section heading, the
    next paragraph). Returns None if no such line is found in range, so the
    caller can fall back to the bbox estimate (e.g. for borderless tables).
    """
    lines = [d['rect'].y0 for d in page.get_drawings()
             if d['rect'].width > 200 and d['rect'].height < 3
             and top_bound <= d['rect'].y0 <= bottom_bound]
    return max(lines) if lines else None


def find_table_top_rule(page, top_bound, bottom_bound):
    """
    Mirror of find_table_bottom_rule() for the topmost horizontal-rule-line
    (e.g. \\toprule) within [top_bound, bottom_bound] -- used when the caption
    sits below the table (Nature/Scientific-Reports convention) so the crop's
    top edge doesn't overshoot upward into whatever precedes the table.
    """
    lines = [d['rect'].y0 for d in page.get_drawings()
             if d['rect'].width > 200 and d['rect'].height < 3
             and top_bound <= d['rect'].y0 <= bottom_bound]
    return min(lines) if lines else None


def find_captions(blocks):
    """
    Scan text blocks for table captions and collect continuation lines.
    Returns a list sorted by y_top: { table_num, label, caption, y_top, y_bottom }
    """
    captions = []
    i = 0
    while i < len(blocks):
        x0, y0, x1, y1, text, _, btype = blocks[i]
        if btype != 0:
            i += 1
            continue
        stripped = text.strip()
        m = CAPTION_START_RE.match(stripped)
        if not m:
            i += 1
            continue

        table_num = int(m.group(1))
        full_caption = clean_text(stripped)
        last_y1 = y1
        j = i + 1
        while j < len(blocks):
            nx0, ny0, nx1, ny1, ntext, _, ntype = blocks[j]
            if ntype != 0:
                j += 1
                continue
            nstripped = ntext.strip()
            if CAPTION_START_RE.match(nstripped):
                break
            if ny0 - last_y1 > CAPTION_CONTINUATION_GAP:
                break
            if len(nstripped) <= 3:
                break
            if full_caption.rstrip().endswith(('.', '!', '?')) and ny0 > last_y1:
                break
            full_caption += ' ' + clean_text(nstripped)
            last_y1 = ny1
            j += 1

        captions.append({
            'table_num': table_num,
            'label': f'Table {table_num}',
            'caption': full_caption,
            'y_top': y0,
            'y_bottom': last_y1,
        })
        i = j

    return sorted(captions, key=lambda c: c['y_top'])


def _validate_table(found, label):
    """
    Given a find_tables() result, picks the candidate with the most non-empty
    rows and rejects it if it looks degenerate, empty, watermark text, or
    fragmented prose that find_tables() misread as tabular. Returns
    (tab, data) or (None, None), logging the rejection reason.
    """
    if not found.tables:
        return None, None

    tab = max(found.tables, key=lambda t: sum(
        1 for row in t.extract() if any(c for c in row if c)
    ))
    data = tab.extract()
    data = [['' if cell is None else cell.strip() for cell in row] for row in data]

    if len(data) <= 1 or not data[0] or len(data[0]) <= 1:
        print(f'    {label}: degenerate ({len(data)}r x {len(data[0]) if data else 0}c), skipping', file=sys.stderr)
        return None, None
    if all(all(c == '' for c in row) for row in data):
        print(f'    {label}: all empty, skipping', file=sys.stderr)
        return None, None
    # Skip tables that look like rotated/watermark text:
    # - too many columns (>10) relative to content, OR
    # - first few rows contain URL/preprint watermark fragments
    watermark_pattern = re.compile(r'doi\.org|preprint|certified by peer|biorxiv', re.IGNORECASE)
    all_text = ' '.join(c for row in data[:3] for c in row)
    if watermark_pattern.search(all_text):
        print(f'    {label}: watermark text detected, skipping', file=sys.stderr)
        return None, None
    first_data_row = next((r for r in data if any(c for c in r)), [])
    non_empty = [c for c in first_data_row if c]
    if len(non_empty) > 10 and non_empty and sum(len(c) for c in non_empty) / len(non_empty) < 6:
        print(f'    {label}: looks like fragmented text, skipping', file=sys.stderr)
        return None, None

    return tab, data


def process_page(page, page_num, tables, real_page=True):
    """
    Runs the caption/table-region detection pipeline against a single page
    (which may be an original source page, or a synthetic page holding a
    rotation-normalized crop of one) and appends any tables found to `tables`.
    Assumes the page's text is in normal horizontal reading order.

    real_page: True if `page` is the actual source page, so a navigable
    `position` rect can be computed directly from its coordinates. False when
    `page` is a synthetic rotation-normalized copy with different dimensions/
    orientation than the real page -- position is skipped in that case rather
    than computed wrong; navigation falls back to caption text-search instead.
    """
    blocks = page.get_text('blocks', sort=True)
    width = page.rect.width
    height = page.rect.height

    captions = find_captions(blocks)
    if not captions:
        return

    print(f'  Page {page_num}: {len(captions)} caption(s)', file=sys.stderr)

    for i, cap in enumerate(captions):
        # Search below the caption (caption above table -- LaTeX convention)...
        region_top = cap['y_bottom'] + 2
        region_bottom = captions[i + 1]['y_top'] - 2 if i + 1 < len(captions) else height
        below_tab = below_data = None
        if region_bottom - region_top >= 30:
            found = page.find_tables(strategy="text", clip=fitz.Rect(0, region_top, width, region_bottom))
            below_tab, below_data = _validate_table(found, cap['label'])

        # ...and above the caption (caption below table -- Nature/Sci-Reports
        # convention), always, rather than only as a fallback: on some pages
        # the "below" region contains no real table but find_tables() still
        # misreads ordinary wrapped body-text prose there as a bogus table,
        # so we can't rely on "found nothing below" to decide which side the
        # real table is on -- both candidates need to be validated and compared.
        region_top_above = captions[i - 1]['y_bottom'] + 2 if i > 0 else 0
        region_bottom_above = cap['y_top'] - 2
        # Tighten the region to the nearest rule line above the caption, if
        # any -- otherwise, with no preceding table caption on the page, this
        # region defaults to the whole page above and can sweep in unrelated
        # content (e.g. a figure) that find_tables() then misreads as a table.
        nearest_rule_above = find_table_bottom_rule(page, region_top_above, region_bottom_above)
        if nearest_rule_above is not None:
            region_top_above = max(region_top_above, nearest_rule_above - 5)
        above_tab = above_data = None
        if region_bottom_above - region_top_above >= 30:
            found = page.find_tables(strategy="text", clip=fitz.Rect(0, region_top_above, width, region_bottom_above))
            above_tab, above_data = _validate_table(found, cap['label'])

        if below_tab is None and above_tab is None:
            print(f'    {cap["label"]}: no table detected', file=sys.stderr)
            continue

        # Prefer whichever valid candidate sits closer to the caption -- a
        # genuine table is adjacent to its caption, while a false-positive
        # match picked up elsewhere on the page (e.g. prose find_tables()
        # misread as tabular) sits much further away.
        below_gap = (below_tab.bbox[1] - cap['y_bottom']) if below_tab is not None else None
        above_gap = (cap['y_top'] - above_tab.bbox[3]) if above_tab is not None else None
        if below_tab is not None and (above_tab is None or below_gap <= above_gap):
            tab, data, caption_below_table = below_tab, below_data, False
        else:
            tab, data, caption_below_table = above_tab, above_data, True
            print(f'    {cap["label"]}: found above caption', file=sys.stderr)

        print(f'    {cap["label"]}: {len(data)}r x {len(data[0])}c', file=sys.stderr)

        if caption_below_table:
            # Table body precedes the caption -- crop from the table's own top
            # rule (mirrors the bottom-rule fix, but upward) down through the
            # caption's bottom edge. Using cap['y_top'] here (as in the normal
            # branch below) would put the crop's top BELOW its bottom.
            top_rule = find_table_top_rule(page, tab.bbox[1] - 5, tab.bbox[3])
            table_top = top_rule if top_rule is not None else tab.bbox[1]
            clip_img = fitz.Rect(0, max(0, table_top - 4), width, min(height, cap['y_bottom'] + 4))
        else:
            # Prefer the actual bottommost rule line over find_tables()'s own
            # bbox estimate, which has been observed to overshoot into the
            # section/paragraph that follows the table.
            bottom_rule = find_table_bottom_rule(page, tab.bbox[1], tab.bbox[3] + 5)
            table_bottom = bottom_rule if bottom_rule is not None else tab.bbox[3]
            clip_img = fitz.Rect(0, max(0, cap['y_top'] - 4), width, min(height, table_bottom + 4))
        pix = page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5), clip=clip_img)
        img_b64 = base64.b64encode(pix.tobytes('jpeg', jpg_quality=85)).decode()

        entry = {
            'page_num': page_num,
            'table_num': cap['table_num'],
            'label': cap['label'],
            'caption': cap['caption'],
            'data': data,
            'image_data': f'data:image/jpeg;base64,{img_b64}',
        }
        if real_page:
            # Reader's position.rects are in native PDF space (origin bottom-left,
            # y increasing upward) -- clip_img is top-left-origin, y increasing
            # downward, so flip each y coordinate and swap y0/y1.
            position_rect = [clip_img.x0, height - clip_img.y1, clip_img.x1, height - clip_img.y0]
            entry['position'] = {'pageIndex': page_num - 1, 'rects': [position_rect]}
        tables.append(entry)


def get_rotated_regions(page):
    """
    Groups all non-horizontal-direction text lines on the page by their
    (rounded) direction vector. Text drawn sideways (e.g. a landscape table
    embedded in a portrait page without a page-level /Rotate) shows up here
    as its own group, distinct from the page's normal horizontal prose.
    Returns { (dx, dy): fitz.Rect } — union bbox of each rotated direction's lines.
    """
    groups = {}
    text_dict = page.get_text('dict')
    for block in text_dict.get('blocks', []):
        if block.get('type') != 0:
            continue
        for line in block.get('lines', []):
            dx, dy = line.get('dir', (1.0, 0.0))
            dirv = (round(dx), round(dy))
            if dirv == (1, 0):
                continue
            rect = fitz.Rect(line['bbox'])
            groups[dirv] = (groups[dirv] | rect) if dirv in groups else rect
    return groups


def rotation_angle_for_dir(dirv):
    """Degrees needed to rotate a line with this direction vector back to horizontal."""
    return round(math.degrees(math.atan2(dirv[1], dirv[0])))


def process_rotated_regions(doc, page, page_num, tables):
    """
    Finds rotated-text regions on `page`, redraws each one onto a synthetic
    page with a compensating rotation applied to the actual content stream
    (Page.show_pdf_page(rotate=...), not just a /Rotate display flag), and
    runs the normal detection pipeline on that normalized copy.
    """
    for dirv, rect in get_rotated_regions(page).items():
        angle = rotation_angle_for_dir(dirv)
        if angle == 0:
            continue

        pad = 4
        region = fitz.Rect(rect.x0 - pad, rect.y0 - pad, rect.x1 + pad, rect.y1 + pad) & page.rect
        if region.is_empty or region.width < 10 or region.height < 10:
            continue

        tmp_doc = fitz.open()
        try:
            if angle % 180 == 90:
                w, h = region.height, region.width
            else:
                w, h = region.width, region.height
            newpage = tmp_doc.new_page(width=w, height=h)
            newpage.show_pdf_page(newpage.rect, doc, page_num - 1, clip=region, rotate=angle)
            print(f'  Page {page_num}: normalized rotated region (dir={dirv}, angle={angle})', file=sys.stderr)
            process_page(newpage, page_num, tables, real_page=False)
        finally:
            tmp_doc.close()


def extract_tables(pdf_path):
    doc = fitz.open(pdf_path)
    tables = []

    for page_num, page in enumerate(doc, start=1):
        process_page(page, page_num, tables)
        process_rotated_regions(doc, page, page_num, tables)

    doc.close()
    return tables


if __name__ == '__main__':
    if len(sys.argv) != 3:
        print('Usage: extract_tables.py <pdf_path> <output_json_path>', file=sys.stderr)
        sys.exit(1)

    try:
        tables = extract_tables(sys.argv[1])
        with open(sys.argv[2], 'w') as f:
            json.dump(tables, f)
        print(f'Extracted {len(tables)} tables', file=sys.stderr)
    except Exception as e:
        print(f'Error: {e}', file=sys.stderr)
        sys.exit(1)
