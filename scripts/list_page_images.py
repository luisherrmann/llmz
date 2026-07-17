#!/usr/bin/env python3
"""
Lists every embedded raster image's bounding box, per page, using PyMuPDF's
own page.get_image_info() -- ground truth read directly from the PDF's real
image XObjects, not inferred from SDT's block classification (see
scripts/extract-figures-sdt.js's own comment on why this exists: SDT's
block-seg classifier occasionally mistypes a genuine image region as
'paragraph' -- observed on Pairoh et al., where a photo dominated by a tiny
watermark stamp came back type: 'paragraph' with almost no extractable text
-- making it invisible to extract-figures-sdt.js's own `type: 'image'`
collection no matter how the caption-pairing logic is generalized). Rather
than guessing from block size/text-density or rendering+analyzing pixels,
this just asks PyMuPDF what images genuinely exist -- the same ground-truth
API extract_figures.py/render_crops.py already rely on elsewhere in this
codebase.

extract-figures-sdt.js merges this script's output into its own `images`
candidate list (alongside whatever SDT itself classified as type: 'image')
before pairing captions to bodies -- SDT still owns caption-finding (it's
much better at that: recognizing "Fig. 3." as a caption even when
misclassified as a heading/paragraph, understanding section structure for
uncaptioned-figure fallback labels, etc.), PyMuPDF just supplies more
reliable image geometry to pair those captions against.

Also merges vertically-touching/overlapping image bboxes into one combined
region first -- some PDF generators tile one large raster figure into many
thin strip-shaped image XObjects rather than a single embedded image
(observed on Scutteri et al.'s Figure 3, which came back as 15 separate
~44pt-tall horizontal strips) -- so a caller pairing captions against these
bboxes sees one sensible region per real figure, not many slivers.

Usage: python3 list_page_images.py <pdf_path> <output_json_path>
Output: JSON array of { page_num, bboxes }, one entry per page that has at
  least one image, page_num 1-indexed. Each bbox is [x0,y0,x1,y1] in
  PDF-native (bottom-left origin, y-up) space -- the same convention
  extract-figures-sdt.js's own SDT-derived bboxes already use, so its own
  candidate-merging code can treat both sources uniformly with no
  conversion of its own.
"""

import sys
import json

try:
    import fitz  # PyMuPDF
except ImportError:
    print(f'PyMuPDF not installed for {sys.executable}. Run: {sys.executable} -m pip install pymupdf', file=sys.stderr)
    sys.exit(2)

# Max vertical gap (points) between two image bboxes for _merge_touching_
# rects below to still treat them as pieces of the same tiled figure.
TILE_GAP_TOLERANCE = 2.0

# Minimum bbox AREA (square points) a merged image region must have to be
# reported at all -- excludes small logos/icons/watermark stamps (observed
# on Pairoh et al.: a ~72x14pt journal logo and a ~132x11pt inline icon,
# both ~1000-1400 sq pt) that get picked up by get_image_info() just like a
# real figure would, but aren't one -- surfacing them as candidate figure
# bodies in extract-figures-sdt.js produced spurious "figures" with no real
# caption anywhere nearby. Real figures observed so far run 85,000+ sq pt
# (roughly 250x340pt, a bit under half a page), so this threshold has wide
# margin on both sides -- generous enough not to exclude a genuinely small
# figure/inset, strict enough to exclude anything decorative.
MIN_IMAGE_AREA = 10000

# Maximum ratio between a merged region's longer and shorter side -- excludes
# decorative horizontal/vertical rules and divider lines (observed on
# Scutteri et al.: a section-divider strip came back as an 983x75 PIXEL,
# ~472x36 POINT image -- a ~13:1 aspect ratio -- comfortably above
# MIN_IMAGE_AREA, so the area filter alone let it through as a spurious
# "figure" with no real caption anywhere nearby). Every real figure
# observed so far runs under 1.5:1 (mostly close to square or portrait), so
# this threshold has wide margin against genuine multi-panel figures too.
MAX_IMAGE_ASPECT_RATIO = 5.0


def _merge_touching_rects(rects, gap_tolerance=TILE_GAP_TOLERANCE):
    """
    Merges a list of (x0,y0,x1,y1) bboxes (PyMuPDF top-left-origin space,
    called BEFORE the native-space flip below) into groups of vertically
    stacked, horizontally overlapping, near-touching rects, returning one
    combined bbox per group. Groups, rather than unioning every rect passed
    in indiscriminately, so genuinely distinct images on a busy page (a
    real gap between them) still stay separate. Returns groups in no
    particular order.
    """
    if not rects:
        return []
    sorted_rects = sorted(rects, key=lambda b: b[1])  # by y0 ascending
    groups = [[sorted_rects[0]]]
    for b in sorted_rects[1:]:
        last = groups[-1][-1]
        horiz_overlap = min(b[2], last[2]) - max(b[0], last[0]) > 0
        vert_gap = b[1] - last[3]
        if horiz_overlap and vert_gap <= gap_tolerance:
            groups[-1].append(b)
        else:
            groups.append([b])
    merged = []
    for group in groups:
        merged.append((
            min(g[0] for g in group),
            min(g[1] for g in group),
            max(g[2] for g in group),
            max(g[3] for g in group),
        ))
    return merged


# How much of a smaller rect's own area must fall inside a larger one for
# _dedupe_contained_rects below to drop it as redundant.
CONTAINMENT_RATIO = 0.9


def _dedupe_contained_rects(rects):
    """
    Drops any rect that's almost entirely contained within a LARGER rect in
    the same list -- PyMuPDF's get_image_info() can return several nested/
    layered image XObjects for what's visually ONE figure (e.g. a handful
    of inset panel images embedded alongside a background image spanning
    the whole region), not just tiled side-by-side pieces (handled by
    _merge_touching_rects above, which only merges rects that are
    vertically STACKED and touching -- nested/overlapping rects don't fit
    that shape at all, so they pass through it untouched). Observed on
    Scutteri et al.'s page 7: one image spanning nearly the whole page
    (area ~310,000 sq pt) plus four smaller images (16,000-92,000 sq pt
    each) fully inside its bounds -- all five otherwise survive as five
    separate candidate figures instead of the one real one. Runs AFTER
    _merge_touching_rects, so a legitimately tiled group is already
    combined into one bbox by the time this only has to reason about
    genuine containment, not tiling.
    """
    def area(b):
        return max(0, b[2] - b[0]) * max(0, b[3] - b[1])

    def contained_ratio(inner, outer):
        ix0, iy0 = max(inner[0], outer[0]), max(inner[1], outer[1])
        ix1, iy1 = min(inner[2], outer[2]), min(inner[3], outer[3])
        inter = max(0, ix1 - ix0) * max(0, iy1 - iy0)
        inner_area = area(inner)
        return inter / inner_area if inner_area > 0 else 0

    # Largest first, so a rect is only ever dropped in favor of something
    # BIGGER than it, never the other way around.
    sorted_rects = sorted(rects, key=area, reverse=True)
    kept = []
    for r in sorted_rects:
        if any(contained_ratio(r, k) >= CONTAINMENT_RATIO for k in kept):
            continue
        kept.append(r)
    return kept


def list_page_images(pdf_path):
    doc = fitz.open(pdf_path)
    output = []
    try:
        for page_num, page in enumerate(doc, start=1):
            raw_bboxes = [info['bbox'] for info in page.get_image_info()]
            if not raw_bboxes:
                continue
            merged = _merge_touching_rects(raw_bboxes)
            merged = _dedupe_contained_rects(merged)
            merged = [b for b in merged if (b[2] - b[0]) * (b[3] - b[1]) >= MIN_IMAGE_AREA]
            merged = [
                b for b in merged
                if max(b[2] - b[0], b[3] - b[1]) / max(1e-6, min(b[2] - b[0], b[3] - b[1])) <= MAX_IMAGE_ASPECT_RATIO
            ]
            if not merged:
                continue
            height = page.rect.height
            # Top-left-origin (PyMuPDF) -> native bottom-left-origin, y-up --
            # same transform used throughout this plugin's own PyMuPDF-based
            # scripts (see e.g. render_crops.py's own comment).
            native_bboxes = [
                [b[0], height - b[3], b[2], height - b[1]]
                for b in merged
            ]
            output.append({'page_num': page_num, 'bboxes': native_bboxes})
    finally:
        doc.close()
    return output


if __name__ == '__main__':
    if len(sys.argv) != 3:
        print('Usage: list_page_images.py <pdf_path> <output_json_path>', file=sys.stderr)
        sys.exit(1)

    try:
        output = list_page_images(sys.argv[1])
        with open(sys.argv[2], 'w') as f:
            json.dump(output, f)
        total_bboxes = sum(len(p['bboxes']) for p in output)
        print(f'Listed {total_bboxes} image region(s) across {len(output)} page(s)', file=sys.stderr)
    except Exception as e:
        print(f'Error: {e}', file=sys.stderr)
        sys.exit(1)
