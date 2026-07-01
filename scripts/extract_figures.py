#!/usr/bin/env python3
"""
Extract figures from a PDF using PyMuPDF.
Install: pip install pymupdf
Usage:   python3 extract_figures.py <pdf_path> <output_json_path>
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

# Matches the start of a figure caption, capturing figure number and optional sub-figure letter.
# Examples: "Figure 1.", "Fig. 2a:", "Figure S3 |"
CAPTION_START_RE = re.compile(
    r'^(?:fig(?:ure)?\.?\s*)(\d+)\s*([a-z])?\s*[.:\|–—]',
    re.IGNORECASE
)

# Maximum y-gap (in points) between blocks that are still part of the same caption
CAPTION_CONTINUATION_GAP = 16


def clean_text(text):
    text = re.sub(r'-\n', '-', text)   # rejoin hyphenated line breaks
    text = re.sub(r'\n', ' ', text)    # replace remaining newlines with spaces
    text = re.sub(r' {2,}', ' ', text) # collapse multiple spaces
    return text.strip()


def extract_figures(pdf_path):
    doc = fitz.open(pdf_path)
    figures = []

    for page_num, page in enumerate(doc, start=1):
        blocks = page.get_text("blocks", sort=True)
        width = page.rect.width

        # --- Pass 1: find caption groups ---
        # Each group: { figure_num, label, caption, y_top, y_bottom }
        caption_groups = []
        i = 0
        while i < len(blocks):
            x0, y0, x1, y1, text, _, block_type = blocks[i]
            if block_type != 0:
                i += 1
                continue
            stripped = text.strip()
            m = CAPTION_START_RE.match(stripped)
            if not m:
                i += 1
                continue

            figure_num = int(m.group(1))
            sub_letter = (m.group(2) or "").lower()
            label = f"Figure {figure_num}{sub_letter}"

            # Collect continuation blocks for the full caption
            full_caption = clean_text(stripped)
            last_y1 = y1
            j = i + 1
            while j < len(blocks):
                nx0, ny0, nx1, ny1, ntext, _, ntype = blocks[j]
                if ntype != 0:
                    j += 1
                    continue
                nstripped = ntext.strip()
                # Stop at another caption or a large vertical gap
                if CAPTION_START_RE.match(nstripped):
                    break
                if ny0 - last_y1 > CAPTION_CONTINUATION_GAP:
                    break
                # Stop at very short blocks — sub-figure labels like "A", "B", "(a)"
                if len(nstripped) <= 3:
                    break
                # Stop if the caption already ends a sentence and there is any gap
                if full_caption.rstrip().endswith(('.', '!', '?')) and ny0 > last_y1:
                    break
                full_caption += ' ' + clean_text(nstripped)
                last_y1 = ny1
                j += 1

            caption_groups.append({
                'figure_num': figure_num,
                'sub_letter': sub_letter,
                'label': label,
                'caption': full_caption,
                'y_top': y0,
                'y_bottom': last_y1,
            })
            i = j

        if not caption_groups:
            continue

        # --- Pass 2: merge sub-figures (same figure_num, different letters) ---
        # Keep only the first occurrence per figure_num; merge the caption text.
        merged = {}
        for cap in caption_groups:
            fn = cap['figure_num']
            if fn not in merged:
                merged[fn] = cap.copy()
            else:
                # Append sub-figure caption
                merged[fn]['caption'] += '  ' + cap['caption']
                # Extend y_bottom if sub-figure caption is lower
                merged[fn]['y_bottom'] = max(merged[fn]['y_bottom'], cap['y_bottom'])

        caption_groups = sorted(merged.values(), key=lambda c: c['y_top'])

        # --- Pass 3: crop the region above each caption as the figure image ---
        prev_y = 0.0
        for cap in caption_groups:
            y_top = cap['y_top']
            if y_top - prev_y < 20:
                prev_y = cap['y_bottom']
                continue

            clip = fitz.Rect(0, prev_y, width, y_top)
            pix = page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5), clip=clip)
            img_b64 = base64.b64encode(pix.tobytes('jpeg', jpg_quality=85)).decode()

            figures.append({
                'page_num': page_num,
                'figure_num': cap['figure_num'],
                'label': cap['label'],
                'caption': cap['caption'],
                'image_data': f'data:image/jpeg;base64,{img_b64}',
            })
            prev_y = cap['y_bottom']

    doc.close()
    return figures


if __name__ == '__main__':
    if len(sys.argv) != 3:
        print('Usage: extract_figures.py <pdf_path> <output_json_path>', file=sys.stderr)
        sys.exit(1)

    try:
        figures = extract_figures(sys.argv[1])
        with open(sys.argv[2], 'w') as f:
            json.dump(figures, f)
        print(f'Extracted {len(figures)} figures', file=sys.stderr)
    except Exception as e:
        print(f'Error: {e}', file=sys.stderr)
        sys.exit(1)
