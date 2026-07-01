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
"""

import sys
import json
import base64
import re

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


def extract_tables(pdf_path):
    doc = fitz.open(pdf_path)
    tables = []

    for page_num, page in enumerate(doc, start=1):
        blocks = page.get_text('blocks', sort=True)
        width = page.rect.width
        height = page.rect.height

        captions = find_captions(blocks)
        if not captions:
            continue

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
