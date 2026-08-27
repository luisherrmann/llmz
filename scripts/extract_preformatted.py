#!/usr/bin/env python3
"""
Detects preformatted/code-listing regions directly from the PDF's own
rendering -- background-shaded boxes with a font different from the
document's own body text -- rather than relying on SDT's own 'preformatted'
block classification (see core/citation.js's own comment on
_buildTextElementsFromStructure): confirmed concretely (this plugin's own
test paper) that SDT's layout classifier alternates between 'preformatted'
and 'table' for pieces of the SAME code listing (a table-looking key: value
indentation pattern apparently confuses it), silently dropping whichever
pieces land as 'table' from citation.js's own preformatted-only collection --
and separately, that a preformatted block's own per-character text sometimes
comes out with missing inter-word spaces ("agent.hasCapability(c)ANDagent."),
which this script's own page.get_text() extraction doesn't reproduce.

Two-signal detection, deliberately NOT hardcoded to this paper's own specific
background color or font name (that would overfit to one paper's styling):
  1. A background FILL color that differs from the document's own default
     background (see _find_document_background) -- most PDFs never
     explicitly fill their own blank page canvas at all (implicitly white),
     so "differs from default" usually just means "any fill exists here at
     all", but a PDF that DOES paint an intentional (e.g. off-white) page
     background is still handled correctly by measuring that instead of
     assuming white outright.
  2. Text inside that fill region using a font that differs from the
     document's own dominant BODY font (see _find_document_body_font) --
     confirms the region is genuinely a distinct-content block (a listing),
     not some other decorative same-font shading (e.g. a table's own
     zebra-striped row background, still typeset in the ordinary body font).

Both signals are needed together: color alone would also flag non-listing
shaded elements (table row striping, callout boxes); font alone (checked
across the WHOLE page) would also flag inline monospace snippets inside
ordinary prose paragraphs that were never meant to be their own block.

Usage: python3 extract_preformatted.py <pdf_path> <output_json_path>
Output: JSON array of { page_num, bbox, text }, one entry per detected
  region. page_num is 1-indexed. bbox is [x0,y0,x1,y1] in PDF-native
  (bottom-left origin, y-up) space -- the same convention
  list_page_images.py/render_crops.py already use, so a caller can merge
  this with SDT's own preformatted blocks or pair it with a caption using
  the same coordinate space as everywhere else in this plugin. `text` is
  page.get_text()'s own raw extraction for that region (real line breaks/
  indentation intact, same "whitespace-significant" treatment
  core/citation.js's own _buildTextElementsFromStructure gives a
  'preformatted' block).
"""

import sys
import json

try:
    import fitz  # PyMuPDF
except ImportError:
    print(f'PyMuPDF not installed for {sys.executable}. Run: {sys.executable} -m pip install pymupdf', file=sys.stderr)
    sys.exit(2)

# Two fill colors are "the same" if every channel is within this much of each
# other (0-1 scale) -- small enough to not merge genuinely distinct colors,
# large enough to absorb minor anti-aliasing/rounding noise between what's
# visually one flat fill.
COLOR_MATCH_TOLERANCE = 0.02

# A fill counts as "different from the document background" once any channel
# differs by more than this -- comfortably above COLOR_MATCH_TOLERANCE so
# the two thresholds don't fight each other, small enough to catch a subtle
# off-white/cream listing background, not just a strongly-contrasting one.
BACKGROUND_DIFF_THRESHOLD = 0.03

# A candidate background fill covering at least this fraction of the page's
# own area is treated as an intentional PAGE background (see
# _find_document_background), not a listing box -- no real code listing
# spans an entire page.
FULL_PAGE_AREA_RATIO = 0.9

# Gap (points) between two same-color fills for _merge_fill_rects to still
# treat them as pieces of the same region -- mirrors
# list_page_images.py's own TILE_GAP_TOLERANCE, same reasoning: some PDF
# generators draw a listing's shaded background as many thin per-line strips
# rather than one rect.
MERGE_GAP_TOLERANCE = 3.0
# Horizontal tolerance for the same merge -- two strips belong to the same
# region only if their LEFT edges (not just some overlap) are close, so a
# two-column layout's independently-drawn left/right boxes never merge into
# one spanning both columns.
MERGE_X_TOLERANCE = 5.0

# A confirmed region's own text must differ from the document's body font
# for at least this fraction of its (non-whitespace) characters -- not
# 100%, since a listing's own leading line-number column is often typeset
# in the BODY font even though the code next to it isn't (observed
# concretely: SDT's own preformatted blocks show this same split). Low
# enough to tolerate that, high enough that a same-font decorative box
# (table striping, callout using body text) doesn't pass by accident.
FONT_DIFF_RATIO_THRESHOLD = 0.5

# Minimum non-whitespace character count inside a candidate region before
# its font is even judged -- an empty or near-empty shaded box (a rule,
# a spacer) has nothing meaningful to compare fonts over.
MIN_TEXT_CHARS = 5


def _page_area(page):
    r = page.rect
    return r.width * r.height


def _colors_match(a, b, tolerance=COLOR_MATCH_TOLERANCE):
    return all(abs(x - y) <= tolerance for x, y in zip(a, b))


def _find_document_background(doc):
    """
    The color of an intentional full-page background fill, if any page in
    the document draws one -- otherwise plain white, the color of an
    untouched PDF canvas (most PDFs never explicitly fill their own blank
    page background at all). Checked ONCE for the whole document, not
    per-page, on the assumption a single document uses one consistent page
    background throughout.
    """
    for page in doc:
        page_area = _page_area(page)
        for d in page.get_drawings():
            if d['type'] not in ('f', 'fs') or not d.get('fill'):
                continue
            r = d['rect']
            area = max(0, r.x1 - r.x0) * max(0, r.y1 - r.y0)
            if area >= page_area * FULL_PAGE_AREA_RATIO:
                return tuple(d['fill'])
    return (1.0, 1.0, 1.0)


def _find_document_body_font(doc):
    """
    The document's own dominant text font, by TOTAL CHARACTER COUNT across
    every page (not just occurrence count -- a font used briefly in many
    short spans shouldn't outweigh the font the bulk of actual prose is
    set in). Returns None if the document has no extractable text at all.
    """
    char_counts = {}
    for page in doc:
        for block in page.get_text('dict')['blocks']:
            if block.get('type') != 0:
                continue
            for line in block['lines']:
                for span in line['spans']:
                    char_counts[span['font']] = char_counts.get(span['font'], 0) + len(span['text'])
    if not char_counts:
        return None
    return max(char_counts, key=char_counts.get)


def _merge_fill_rects(rects, gap_tolerance=MERGE_GAP_TOLERANCE, x_tolerance=MERGE_X_TOLERANCE):
    """
    Merges same-color fill rects (already pre-filtered to one color's own
    list by the caller) into groups of vertically stacked, near-touching
    rects -- same "many thin strips make up one real region" shape
    list_page_images.py's own _merge_touching_rects handles for tiled
    images.

    Buckets by LEFT EDGE (column) FIRST, then merges vertically WITHIN each
    column bucket -- merging by y0 alone across the whole page first (tried
    initially) breaks as soon as a two-column layout's left/right strips
    interleave in y: sorting purely by y0 means the rect immediately BEFORE
    a given left-column strip in that sort can be a right-column strip
    instead of the left-column strip actually above it, so an x-only
    adjacency check on "the previous rect in y-sorted order" ends up
    splitting one real column-spanning region into many single-line
    fragments the moment the other column's strips interrupt the sequence
    -- confirmed concretely (this plugin's own test paper): a two-column
    page merged into 30+ single-line slivers instead of ~2 real regions
    until this was column-bucketed first.
    """
    if not rects:
        return []
    sorted_by_x = sorted(rects, key=lambda r: r.x0)
    columns = [[sorted_by_x[0]]]
    for r in sorted_by_x[1:]:
        if abs(r.x0 - columns[-1][-1].x0) <= x_tolerance:
            columns[-1].append(r)
        else:
            columns.append([r])

    merged = []
    for column_rects in columns:
        column_rects.sort(key=lambda r: r.y0)
        groups = [[column_rects[0]]]
        for r in column_rects[1:]:
            last = groups[-1][-1]
            if r.y0 - last.y1 <= gap_tolerance:
                groups[-1].append(r)
            else:
                groups.append([r])
        for group in groups:
            merged.append(fitz.Rect(
                min(g.x0 for g in group),
                min(g.y0 for g in group),
                max(g.x1 for g in group),
                max(g.y1 for g in group),
            ))
    return merged


def _region_font_diff_ratio(page, rect, body_font):
    """
    Fraction of `rect`'s own non-whitespace characters set in a font OTHER
    than `body_font`, and the total non-whitespace character count (so the
    caller can also enforce MIN_TEXT_CHARS). Returns (0.0, 0) for a region
    with no extractable text at all.
    """
    total = 0
    differing = 0
    for block in page.get_text('dict', clip=rect)['blocks']:
        if block.get('type') != 0:
            continue
        for line in block['lines']:
            for span in line['spans']:
                n = len(span['text'].strip())
                if n == 0:
                    continue
                total += n
                if span['font'] != body_font:
                    differing += n
    return (differing / total if total else 0.0), total


def extract_preformatted(pdf_path):
    doc = fitz.open(pdf_path)
    try:
        background = _find_document_background(doc)
        body_font = _find_document_body_font(doc)

        output = []
        for page_num, page in enumerate(doc, start=1):
            page_area = _page_area(page)
            by_color = {}
            for d in page.get_drawings():
                if d['type'] not in ('f', 'fs') or not d.get('fill'):
                    continue
                color = tuple(d['fill'])
                if _colors_match(color, background):
                    continue
                r = d['rect']
                if (r.x1 - r.x0) * (r.y1 - r.y0) >= page_area * FULL_PAGE_AREA_RATIO:
                    continue
                # Bucket by rounded color -- same reasoning as
                # COLOR_MATCH_TOLERANCE, groups near-identical colors
                # together before merging their rects.
                key = tuple(round(c, 2) for c in color)
                by_color.setdefault(key, []).append(r)

            for rects in by_color.values():
                for region in _merge_fill_rects(rects):
                    diff_ratio, char_count = _region_font_diff_ratio(page, region, body_font)
                    if char_count < MIN_TEXT_CHARS or diff_ratio <= FONT_DIFF_RATIO_THRESHOLD:
                        continue
                    text = page.get_text('text', clip=region)
                    if not text.strip():
                        continue
                    height = page.rect.height
                    # Top-left-origin (PyMuPDF) -> native bottom-left-origin,
                    # y-up -- same transform list_page_images.py/
                    # render_crops.py already use.
                    native_bbox = [region.x0, height - region.y1, region.x1, height - region.y0]
                    output.append({'page_num': page_num, 'bbox': native_bbox, 'text': text})
        return output
    finally:
        doc.close()


if __name__ == '__main__':
    if len(sys.argv) != 3:
        print('Usage: extract_preformatted.py <pdf_path> <output_json_path>', file=sys.stderr)
        sys.exit(1)

    try:
        output = extract_preformatted(sys.argv[1])
        with open(sys.argv[2], 'w') as f:
            json.dump(output, f)
        print(f'Detected {len(output)} preformatted region(s)', file=sys.stderr)
    except Exception as e:
        print(f'Error: {e}', file=sys.stderr)
        sys.exit(1)
