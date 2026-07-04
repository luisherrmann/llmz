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


# Max gap (points) between a vector-drawing union and a nearby text block for
# that block to be absorbed as part of the same figure (axis label, legend).
VECTOR_LABEL_ABSORB_GAP = 20
# Text blocks longer than this are treated as paragraph prose, not a label.
VECTOR_LABEL_MAX_LEN = 80


def get_vector_figure_bbox(page, blocks, top_bound, bottom_bound, caption_y_top):
    """
    Bounding box for a vector-drawn figure (a chart/diagram made of lines,
    curves and fills -- e.g. matplotlib/R/TikZ PDF output -- rather than a
    single embedded raster image). Unions:
      1. All vector drawing paths (page.get_drawings()) within [top_bound, bottom_bound]
      2. Short, non-caption text blocks close to that union (axis labels,
         legends) -- these PDF-export tools typically draw such labels as real
         text objects, not vector paths, so get_drawings() alone misses them.
    Returns None if no vector drawings are found in the region at all, so the
    caller can fall back to a heuristic instead of returning a meaningless box.
    """
    drawings = [d['rect'] for d in page.get_drawings()
                if top_bound <= d['rect'].y0 and d['rect'].y1 <= bottom_bound]
    if not drawings:
        return None

    union = fitz.Rect()
    for r in drawings:
        union |= r

    for x0, y0, x1, y1, text, _, block_type in blocks:
        if block_type != 0:
            continue
        stripped = text.strip()
        if not stripped or len(stripped) > VECTOR_LABEL_MAX_LEN:
            continue  # skip long blocks -- likely paragraph text, not a label
        if CAPTION_START_RE.match(stripped):
            continue  # caption is unioned in separately by the caller
        if y0 >= caption_y_top:
            continue  # never reach past the caption
        if y0 >= union.y1 and y0 - union.y1 <= VECTOR_LABEL_ABSORB_GAP:
            union |= fitz.Rect(x0, y0, x1, y1)
        elif y1 <= union.y0 and union.y0 - y1 <= VECTOR_LABEL_ABSORB_GAP:
            union |= fitz.Rect(x0, y0, x1, y1)

    return union


def extract_figures(pdf_path):
    doc = fitz.open(pdf_path)
    figures = []

    for page_num, page in enumerate(doc, start=1):
        blocks = page.get_text("blocks", sort=True)
        width = page.rect.width
        height = page.rect.height

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

        # --- Pass 3: crop each figure's region (its content + caption) ---
        # Match priority, from most to least precise:
        #   1. Embedded raster image bbox (page.get_image_info()) just above
        #      the caption -- exact bounds for screenshot/photo-style figures.
        #   2. Vector-drawing union (get_vector_figure_bbox) -- for figures made
        #      of lines/curves/fills (matplotlib/R/TikZ-style plots) rather than
        #      a single raster image, which get_image_info() can't see at all.
        #   3. The old "everything since the last stopping point" heuristic, for
        #      pages where neither of the above finds anything.
        # Without (1)/(2), the old heuristic alone could both extend the crop
        # well above the real figure (into unrelated content, e.g. a page
        # header) and stop at the caption's own top edge instead of its bottom,
        # cutting the caption text off entirely.
        image_bboxes = [info['bbox'] for info in page.get_image_info()]
        prev_y = 0.0
        for cap in caption_groups:
            y_top = cap['y_top']
            y_bottom = cap['y_bottom']

            # Candidate images: end before this caption starts, and start at or
            # after wherever the previous figure's crop left off (so a page with
            # multiple figures matches each caption to its own preceding image,
            # not an already-claimed one).
            candidates = [b for b in image_bboxes if b[3] <= y_top + 10 and b[1] >= prev_y - 10]
            if candidates:
                # Closest preceding image (largest bottom edge not past the caption)
                img_bbox = max(candidates, key=lambda b: b[3])
                crop_top = min(img_bbox[1], y_top)
            else:
                vector_bbox = get_vector_figure_bbox(page, blocks, prev_y, y_top, y_top)
                if vector_bbox is not None:
                    crop_top = min(vector_bbox.y0, y_top)
                elif y_top - prev_y < 20:
                    prev_y = y_bottom
                    continue
                else:
                    crop_top = prev_y

            clip = fitz.Rect(0, crop_top, width, min(height, y_bottom + 4))
            pix = page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5), clip=clip)
            img_b64 = base64.b64encode(pix.tobytes('jpeg', jpg_quality=85)).decode()

            # Reader's position.rects are in native PDF space (origin bottom-left,
            # y increasing upward) -- PyMuPDF's clip rect above is top-left-origin,
            # y increasing downward, so flip each y coordinate and swap y0/y1.
            position_rect = [clip.x0, height - clip.y1, clip.x1, height - clip.y0]

            figures.append({
                'page_num': page_num,
                'figure_num': cap['figure_num'],
                'label': cap['label'],
                'caption': cap['caption'],
                'image_data': f'data:image/jpeg;base64,{img_b64}',
                'position': {'pageIndex': page_num - 1, 'rects': [position_rect]},
            })
            prev_y = y_bottom

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
