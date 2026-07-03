#!/usr/bin/env python3
"""
Extract tables from a PDF using PyMuPDF.
Install: pip install pymupdf
Usage:   python3 extract_tables.py <pdf_path> <output_json_path>

Output: JSON array of { page_num, table_num, label, caption, data, image_data }
  data      — list of rows; each row is a list of cell strings
  image_data — base64 JPEG crop of the table region (caption + table body)

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


def process_page(page, page_num, tables):
    """
    Runs the caption/table-region detection pipeline against a single page
    (which may be an original source page, or a synthetic page holding a
    rotation-normalized crop of one) and appends any tables found to `tables`.
    Assumes the page's text is in normal horizontal reading order.
    """
    blocks = page.get_text('blocks', sort=True)
    width = page.rect.width
    height = page.rect.height

    captions = find_captions(blocks)
    if not captions:
        return

    print(f'  Page {page_num}: {len(captions)} caption(s)', file=sys.stderr)

    for i, cap in enumerate(captions):
        # Primary search: below the caption (most common — caption above table)
        region_top = cap['y_bottom'] + 2
        region_bottom = captions[i + 1]['y_top'] - 2 if i + 1 < len(captions) else height
        clip = fitz.Rect(0, region_top, width, region_bottom)
        found = page.find_tables(strategy="text", clip=clip)

        # Fallback: above the caption (caption below table)
        if not found.tables or region_bottom - region_top < 30:
            region_top_above = captions[i - 1]['y_bottom'] + 2 if i > 0 else 0
            region_bottom_above = cap['y_top'] - 2
            if region_bottom_above - region_top_above >= 30:
                clip = fitz.Rect(0, region_top_above, width, region_bottom_above)
                found = page.find_tables(strategy="text", clip=clip)
                if found.tables:
                    print(f'    {cap["label"]}: found above caption', file=sys.stderr)

        if not found.tables:
            print(f'    {cap["label"]}: no table detected', file=sys.stderr)
            continue

        # Take the table with the most non-empty rows
        tab = max(found.tables, key=lambda t: sum(
            1 for row in t.extract() if any(c for c in row if c)
        ))
        data = tab.extract()
        data = [['' if cell is None else cell.strip() for cell in row] for row in data]

        # Skip degenerate tables
        if len(data) <= 1 or not data[0] or len(data[0]) <= 1:
            print(f'    {cap["label"]}: degenerate ({len(data)}r x {len(data[0]) if data else 0}c), skipping', file=sys.stderr)
            continue
        if all(all(c == '' for c in row) for row in data):
            print(f'    {cap["label"]}: all empty, skipping', file=sys.stderr)
            continue
        # Skip tables that look like rotated/watermark text:
        # - too many columns (>10) relative to content, OR
        # - first few rows contain URL/preprint watermark fragments
        watermark_pattern = re.compile(r'doi\.org|preprint|certified by peer|biorxiv', re.IGNORECASE)
        all_text = ' '.join(c for row in data[:3] for c in row)
        if watermark_pattern.search(all_text):
            print(f'    {cap["label"]}: watermark text detected, skipping', file=sys.stderr)
            continue
        first_data_row = next((r for r in data if any(c for c in r)), [])
        non_empty = [c for c in first_data_row if c]
        if len(non_empty) > 10 and non_empty and sum(len(c) for c in non_empty) / len(non_empty) < 6:
            print(f'    {cap["label"]}: looks like fragmented text, skipping', file=sys.stderr)
            continue

        print(f'    {cap["label"]}: {len(data)}r x {len(data[0])}c', file=sys.stderr)

        clip_img = fitz.Rect(0, max(0, cap['y_top'] - 4), width, min(height, tab.bbox[3] + 4))
        pix = page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5), clip=clip_img)
        img_b64 = base64.b64encode(pix.tobytes('jpeg', jpg_quality=85)).decode()

        tables.append({
            'page_num': page_num,
            'table_num': cap['table_num'],
            'label': cap['label'],
            'caption': cap['caption'],
            'data': data,
            'image_data': f'data:image/jpeg;base64,{img_b64}',
        })


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
            process_page(newpage, page_num, tables)
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
