#!/usr/bin/env python3
"""
Renders a cropped JPEG for each of the given (page_num, bbox) regions -- the
image-rendering half of what extract_tables.py used to do in one pass, split
out so it can be invoked lazily (only when an actual image is needed, e.g.
at table-export time) against the SDT-only detection pipeline's cached
bounding boxes (see extract_tables_sdt.js), rather than unconditionally for
every table on every chat message.

A Node/pdf.js equivalent (using Zotero's own document-worker rendering
pipeline) was also prototyped, but measured consistently ~2.5-3x slower than
this PyMuPDF version even after matching render scale and JPEG output format
-- the gap is Node/ESM/canvas startup overhead, not encode work, so it
doesn't shrink with tuning. Kept as PyMuPDF since this plugin already
requires the Python venv for figure extraction/embedding regardless
(document/figures.js's extract_figures.py/embed_figures.py), so this doesn't
add a new dependency either way.

A multiprocessing.Pool variant (concurrency 8, PyMuPDF explicitly does not
support threading) was also tried, since table exports can request several
tables at once. Measured slower than this plain sequential version for the
realistic case (a handful of tables -- e.g. 4 regions: ~0.3-0.5s pooled vs.
~0.15-0.23s sequential, pool-startup cost dominating at that scale) and only
modestly faster (~15-20%) once well past what a real export batch looks like
(32 regions). Not worth the added complexity for the common case, so kept
plain sequential.

Usage: python3 render_table_crops.py <pdf_path> <regions_json_path> <output_json_path>
Input (regions_json_path): JSON array of { index, page_num, bbox }.
  page_num is 1-indexed. bbox is [x0,y0,x1,y1] in PDF-native (bottom-left
  origin, y-up) space -- the same convention document/tables.js's `position`
  field already uses everywhere else, so callers can pass position.rects[0]
  and position.pageIndex+1 directly with no conversion of their own.
Output: JSON array of { index, image_data }, `index` carried through
  unchanged so callers can match results back to their own table list.
"""

import sys
import json
import base64

try:
    import fitz  # PyMuPDF
except ImportError:
    print(f'PyMuPDF not installed for {sys.executable}. Run: {sys.executable} -m pip install pymupdf', file=sys.stderr)
    sys.exit(2)

PAD = 4


def render_crops(pdf_path, regions):
    doc = fitz.open(pdf_path)
    output = []
    try:
        for region in regions:
            page_num = region.get('page_num')
            bbox = region.get('bbox')
            index = region.get('index')
            if not page_num or not bbox or page_num < 1 or page_num > len(doc):
                print(f'  index={index}: invalid page_num/bbox, skipping', file=sys.stderr)
                continue

            page = doc[page_num - 1]
            width, height = page.rect.width, page.rect.height

            # Native (bottom-left origin, y-up) -> PyMuPDF page.rect
            # (top-left origin, y-down): flip each y coordinate and swap
            # y0/y1 -- same transform extract_tables.py/extract_tables_sdt.js
            # already use throughout.
            x0, y0n, x1, y1n = bbox
            clip = fitz.Rect(x0, height - y1n, x1, height - y0n)
            clip = fitz.Rect(
                max(0, clip.x0 - PAD), max(0, clip.y0 - PAD),
                min(width, clip.x1 + PAD), min(height, clip.y1 + PAD),
            )

            pix = page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5), clip=clip)
            img_b64 = base64.b64encode(pix.tobytes('jpeg', jpg_quality=85)).decode()
            output.append({'index': index, 'image_data': f'data:image/jpeg;base64,{img_b64}'})
    finally:
        doc.close()
    return output


if __name__ == '__main__':
    if len(sys.argv) != 4:
        print('Usage: render_table_crops.py <pdf_path> <regions_json_path> <output_json_path>', file=sys.stderr)
        sys.exit(1)

    try:
        with open(sys.argv[2]) as f:
            regions = json.load(f)
        output = render_crops(sys.argv[1], regions)
        with open(sys.argv[3], 'w') as f:
            json.dump(output, f)
        print(f'Rendered {len(output)} table image(s)', file=sys.stderr)
    except Exception as e:
        print(f'Error: {e}', file=sys.stderr)
        sys.exit(1)
