// Extracts figures using Zotero's document-worker structure pipeline
// (ML-based PDF layout classification, vendored under ../sdt/document-worker/)
// for DETECTION -- CAPTION-finding is SDT-only, no PyMuPDF/Python involved
// (see scripts/render_crops.py for the separate, still-PyMuPDF-based
// image-rendering step this plugin calls right after this script -- see
// document/figures.js's own comment for why that can't be deferred the way
// table images can). IMAGE-body candidates, though, optionally also draw on
// scripts/list_page_images.py's PyMuPDF-sourced ground truth (see its own
// header comment, and step 2 below) -- SDT is much better at finding
// captions (recognizing "Fig. 3." even when misclassified as a heading or
// plain paragraph -- see step 2's own comment -- and understanding section
// structure for uncaptioned-figure fallback labels) than at reliably
// classifying every genuine image region as `type: 'image'` in the first
// place (observed on Pairoh et al.: a photo dominated by a small watermark
// stamp came back type: 'paragraph', invisible to this script's own
// `type: 'image'` collection no matter how well the CAPTION side is
// generalized, since an image has no distinctive text to pattern-match
// against the way a caption does). Mirrors extract_tables_sdt.js's
// approach (see its own module comment for the fuller rationale) applied
// to `type: 'image'` SDT blocks instead of `type: 'table'` ones, sharing
// the same caption-pairing algorithm via match_captions.js -- replaces the
// old caption-anchored PyMuPDF pipeline (extract_figures.py, since
// removed), which structurally could not find a figure with no caption at
// all, or an appendix-lettered one ("Figure D.1").
//
// Pipeline (mirrors extract_tables_sdt.js, see its own comment, plus three
// figures-only steps):
//   1. Collect every `type: 'image'` block (body) and `type: 'caption'` block
//      whose text starts with "Figure"/"Fig" (page + bbox for both) -- for
//      a caption, also walk forward absorbing any immediately-following
//      blocks that are really just the rest of the SAME caption (see
//      match_captions.js's extendCaptionText for the full rationale: SDT
//      only reliably types a multi-panel caption's OPENING sentence as its
//      own block, dropping the "(a) ... (b) ..." panel breakdown that
//      follows into separate blocks otherwise invisible to this step).
//   2. Consolidate step 1's raw image blocks, per page, into one candidate
//      per contiguous run bounded by the same nearest non-image neighbors
//      above/below (see match_captions.js's groupImagesByBoundary for the
//      full rationale) -- handles a badly fragmented multi-panel figure
//      (chemical structures, plot tick labels, legend swatches, observed on
//      Penner et al.'s Figure 2: 109 tiny image blocks on one page alone)
//      that neither block-index adjacency nor a fixed-margin bbox merge
//      (step 5 below) can group correctly. The area/aspect-ratio filter
//      from this file's own header comment is applied to each MERGED group
//      here, not to individual raw fragments.
//   3. If a PyMuPDF-sourced image list was passed in (see Usage below),
//      merge its bboxes into the body candidates from step 2 too --
//      but ONLY the ones that DON'T substantially overlap an SDT-
//      classified image already found on the same page, so this only
//      ever contributes a genuinely NEW candidate SDT missed, not a
//      near-duplicate of one it already found (a duplicate candidate
//      changes that page's body count, which can spuriously satisfy
//      the equal-count fast path in step 4 together with an unrelated
//      false-positive "caption" -- observed on Lu et al., where this
//      combination produced a bogus duplicate figure).
//   4. Greedily pair each caption with its nearest image block on the same
//      page (rect distance -- see match_captions.js's pairWithCaptions).
//   5. Greedily pair whatever's still unmatched across an ADJACENT page
//      boundary instead, for a figure whose caption spilled onto the next
//      page (e.g. a full-page figure with no room left for its own
//      caption, observed on Scutteri et al.'s page 7/8 boundary) -- by
//      block-index proximity in structure.content's own page-spanning
//      reading order, not bbox distance (a body's and a caption's bboxes
//      on two different pages aren't in a shared coordinate space to begin
//      with -- see pairWithCaptions's own comment for why this doesn't
//      need page-geometry fusion to handle).
//   6. Any image block STILL left unpaired gets checked against
//      already-paired figures on the same page: if extending its bbox by a
//      small margin overlaps one, merge it in rather than treating it as a
//      separate figure (a single misclassified non-image block in the
//      middle of a real figure can still split step 2's own grouping in
//      two, or step 3 above contributed a duplicate/overlapping
//      PyMuPDF-sourced candidate for a figure SDT itself already found).
//   7. Any STILL-unpaired image block (genuinely no caption anywhere
//      nearby in the source PDF) gets a synthetic label from its nearest
//      preceding section heading (via structure.catalog.outline), numbered
//      in block order per section.
//
// Usage: node --import ../sdt/document-worker/scripts/pdfjs-setup.js extract_figures_sdt.js <pdf_path> <output_json_path> [pymupdf_images_json_path] [structure_cache_path]
//   pymupdf_images_json_path (optional): output of scripts/list_page_images.py
//   for this same PDF -- see step 2 above.
// Output: JSON array of { figure_id, page_num, figure_num, figure_extra_num,
//   label, caption, image_data, position }. figure_num is a plain integer
//   only for plainly-numbered captions ("Figure 3:"); figure_extra_num is a
//   separate 1..K counter for anything else (lettered-appendix or
//   synthetic-from-heading), mirroring extract_tables_sdt.js's own
//   table_num/table_extra_num split -- avoids the two ever colliding under
//   the same key downstream (buildLinkIndex, citation-link resolution).
// figure_id is a THIRD, distinct numbering: a plain 1..N sequential id, in
// document (block) order, assigned to EVERY figure regardless of whether it
// has a real printed number at all -- see extract_tables_sdt.js's own
// header comment for the fuller rationale (same one applies here: an LLM
// asked to pick a figure needs a small, always-unambiguous integer to
// answer with, not its own possibly long/comma-containing label text). See
// llm-prompt.js's selectFiguresWithLLM for where figure_id is actually used;
// this script only assigns it.
// image_data is always null here -- no PyMuPDF, so no image rendering; see
// document/figures.js's own comment for why (unlike tables) this plugin
// renders every figure's image EAGERLY right after this script runs, rather
// than lazily on demand.

import fs from 'fs';
import { flattenText, pairWithCaptions, flattenOutline, nearestSection, iou, groupImagesByBoundary, extendCaptionText } from './match_captions.js';
import { loadOrComputeStructure } from './structure_sdt.js';

// How much IoU overlap (with an SDT-classified `type: 'image'` block on the
// SAME page) a PyMuPDF-sourced candidate needs before it's treated as a
// duplicate of something SDT already found, rather than a genuinely new
// region SDT missed -- see the merge step below for why this matters.
const PYMUPDF_DUPLICATE_IOU = 0.5;

// Minimum bbox AREA (square points) and maximum long/short-side ratio an
// SDT-classified `type: 'image'` block must have to be collected as a body
// candidate at all -- mirrors list_page_images.py's own MIN_IMAGE_AREA/
// MAX_IMAGE_ASPECT_RATIO (see its header comment for the fuller rationale;
// same thresholds, same reasoning, just applied to SDT's OWN image blocks
// here instead of PyMuPDF's). Needed for a failure mode PyMuPDF-side
// filtering can't reach at all: on a dense multi-panel figure (chemical
// structures, plot tick labels, legend swatches -- observed on Penner et
// al.'s Figure 2, a 9-panel plot on page 9), SDT's block classifier doesn't
// just mistype a real image as something else (the Pairoh-watermark case
// this script's own module comment already covers) -- it does the OPPOSITE,
// splitting what a reader sees as ONE figure into scores of tiny type:
// 'image' blocks, one per glyph-like sub-element ("NH2", "+", a single axis
// tick number, a legend color swatch). Observed directly: 109 image blocks
// on Penner et al.'s page 9 alone (vs. 2 real captions), 128 on page 16, 75
// on page 19 -- almost all under a few hundred sq pt. Left unfiltered, each
// leftover fragment that pairWithCaptions can't absorb into an
// already-captioned figure becomes its own spurious "Unlabelled Figure"
// entry (154 total figures extracted from this paper, only 6 with a real
// caption) -- and since document/figures.js renders every figure's image
// EAGERLY, not lazily, that's 148 wasted renders too. Filtering here, before
// candidates ever reach pairWithCaptions, cuts those same three pages'
// candidate counts to 3/2/6 in testing -- without affecting any real
// figure's own body block, which are 85,000+ sq pt same as the PyMuPDF-side
// comment already established.
const MIN_IMAGE_AREA = 10000;
const MAX_IMAGE_ASPECT_RATIO = 5.0;

async function main() {
	let [, , pdfPath, outputPath, pymupdfImagesPath, structureCachePath] = process.argv;
	if (!pdfPath || !outputPath) {
		console.error('Usage: extract_figures_sdt.js <pdf_path> <output_json_path> [pymupdf_images_json_path] [structure_cache_path]');
		process.exit(1);
	}
	let structure = await loadOrComputeStructure(pdfPath, structureCachePath);

	let rawImages = [];
	let captions = [];
	// Every block on the page, any type -- fed to groupImagesByBoundary below
	// so it can find each raw image fragment's nearest NON-image neighbor
	// above/below (see that function's own comment for why this beats both
	// block-index adjacency and a fixed-margin bbox merge for a badly
	// fragmented multi-panel figure).
	let allBlocksByPage = new Map(); // page_num -> [{ blockIndex, bbox }]
	// Tracks each page's own blockIndex range as SDT blocks are visited
	// below -- used to place the PyMuPDF-sourced image candidates (added
	// further down) at a REASONABLE position in reading order, even though
	// they have no real blockIndex of their own (they're not SDT blocks at
	// all). Exact precision doesn't matter here: pairWithCaptions's actual
	// MATCHING for these candidates happens via same-page bbox distance
	// (pass 2) or the post-pairing bbox-overlap merge, neither of which
	// reads blockIndex at all -- it's only consulted by pass 1's same-page
	// equal-count fast path and pass 3's cross-page window, both narrow
	// enough that a rough placement here doesn't meaningfully risk a wrong
	// match.
	let pageBlockIndexRange = new Map(); // page_num -> [min, max]
	for (let i = 0; i < structure.content.length; i++) {
		let block = structure.content[i];
		let pageRect = block.anchor?.pageRects?.[0];
		if (!pageRect) continue;
		let pageNum = pageRect[0] + 1;
		let bbox = pageRect.slice(1);
		let range = pageBlockIndexRange.get(pageNum);
		if (!range) pageBlockIndexRange.set(pageNum, [i, i]);
		else {
			range[0] = Math.min(range[0], i);
			range[1] = Math.max(range[1], i);
		}
		if (!allBlocksByPage.has(pageNum)) allBlocksByPage.set(pageNum, []);
		allBlocksByPage.get(pageNum).push({ blockIndex: i, bbox });
		if (block.type === 'image') {
			rawImages.push({ blockIndex: i, page_num: pageNum, bbox, content: block.content });
		}
		// Checked regardless of block type (not just SDT's own 'caption'
		// classification) -- SDT's block classifier can misclassify a
		// genuine caption as something else entirely (observed on Scutteri
		// et al.: "Fig. 2. Structural analysis of de novo designed dynamic
		// protein switches" came back type: 'heading', likely because it
		// reads like a short, sentence-opening, topic-introducing line --
		// structurally similar to what makes something look like a
		// heading; other captions on the same paper came back as plain
		// 'paragraph' blocks). A caption misclassified as ANY other type is
		// invisible to the pairing algorithm entirely -- it never even
		// reaches the `captions` list -- regardless of how good the
		// pairing logic itself is, so this only trusts SDT for WHERE the
		// text blocks are, not what it thinks each one IS. The `^` anchor
		// keeps this safe against false positives from an ordinary
		// paragraph that merely MENTIONS a figure mid-sentence (e.g. "As
		// shown in Figure 2, ...") -- only a block whose text literally
		// STARTS with "Figure"/"Fig" matches at all, which is already a
		// strong caption-like signal on its own regardless of the source
		// block's classified type.
		let text = flattenText(block).replace(/\s+/g, ' ').trim();
		if (/^(figure|fig)\b/i.test(text)) {
			// SDT only reliably classifies a multi-panel caption's OPENING
			// sentence as its own block -- the "(a) ... (b) ... (c) ..."
			// panel-by-panel breakdown that follows routinely lands in one or
			// more separate `paragraph`/`heading` blocks instead (see
			// extendCaptionText's own comment for the full rationale and the
			// Penner et al. Figure 2 case that surfaced this: using only
			// `text` here would silently drop the entire panel breakdown,
			// leaving the caption cut off mid-thought). Its returned `bbox`
			// (union of every absorbed block's own rect) is used here too,
			// not just `pageRect.slice(1)` -- otherwise a caller
			// highlighting/navigating to "the caption" would only ever see
			// the opening `caption`-typed block's own small rect, never the
			// full region the extended text actually covers.
			let { text: extendedText, bbox: extendedBbox } = extendCaptionText(structure.content, i);
			captions.push({ blockIndex: i, page_num: pageNum, bbox: extendedBbox || pageRect.slice(1), text: extendedText });
		}
	}

	// Consolidate raw `type: 'image'` fragments into one candidate per
	// contiguous run bounded by the same non-image neighbors (see
	// groupImagesByBoundary's own comment for the full rationale -- handles
	// a badly fragmented multi-panel figure that block-index adjacency and a
	// fixed-margin bbox merge both miss). Runs PER PAGE, since bounding
	// blocks from different pages are never comparable. The area/aspect
	// filter (see this file's own header comment) is applied to the MERGED
	// group, not each raw fragment -- a genuine figure's own fragments are
	// often individually tiny (a single axis-tick number, a chemical-bond
	// label), only the consolidated region should be judged against a
	// real-figure-sized threshold; a truly isolated tiny artifact (a lone
	// watermark/icon with no other fragment sharing its bounding pair) stays
	// its own one-fragment group and gets filtered out same as before.
	let images = [];
	for (let [pageNum, pageBlocks] of allBlocksByPage) {
		let pageRawImages = rawImages.filter(im => im.page_num === pageNum);
		if (!pageRawImages.length) continue;
		let merged = groupImagesByBoundary(pageBlocks, pageRawImages);
		for (let m of merged) {
			let area = (m.bbox[2] - m.bbox[0]) * (m.bbox[3] - m.bbox[1]);
			let aspectRatio = Math.max(m.bbox[2] - m.bbox[0], m.bbox[3] - m.bbox[1])
				/ Math.max(1e-6, Math.min(m.bbox[2] - m.bbox[0], m.bbox[3] - m.bbox[1]));
			if (area >= MIN_IMAGE_AREA && aspectRatio <= MAX_IMAGE_ASPECT_RATIO) {
				images.push({ blockIndex: m.blockIndex, page_num: pageNum, bbox: m.bbox, content: m.content });
			}
		}
	}

	// Ground-truth image regions from PyMuPDF (see list_page_images.py's own
	// comment for the full rationale) -- merged in as ADDITIONAL body
	// candidates, alongside whatever SDT itself classified as type: 'image'
	// above, rather than replacing them. Covers a real image SDT's block
	// classifier mistyped as something else entirely (observed on Pairoh et
	// al.: a photo dominated by a small watermark stamp came back type:
	// 'paragraph', with almost no extractable text to catch via the
	// caption-style regex generalization above -- that trick works for
	// captions because they have distinctive TEXT to match against; a
	// misclassified IMAGE has no comparable content-based signal, so this
	// asks PyMuPDF what images genuinely exist instead of guessing from
	// block size/text-density).
	//
	// Only added when it DOESN'T substantially overlap an SDT-classified
	// image already on the same page -- a near-duplicate candidate for a
	// figure SDT already found correctly turned out NOT to be harmless
	// (tried that first): it changes that page's body COUNT, which can
	// spuriously satisfy pass 1's same-page equal-count fast path together
	// with an unrelated false-positive "caption" (a paragraph that happens
	// to start with "Figure N" while actually just mentioning it, e.g.
	// "Figure 7A demonstrates reconstruction results..." -- the `^` anchor
	// guards against a MID-sentence mention, but not a paragraph whose
	// OWN first sentence happens to open this way) -- observed on Lu et
	// al., where this combination produced a bogus duplicate "figure" out
	// of that in-text mention, paired with a second copy of Figure 7's own
	// image. Skipping duplicate candidates upstream, rather than
	// relying on downstream merging to clean them up, avoids that
	// interaction entirely.
	if (pymupdfImagesPath) {
		try {
			let pymupdfPages = JSON.parse(fs.readFileSync(pymupdfImagesPath, 'utf8'));
			for (let { page_num, bboxes } of pymupdfPages) {
				let range = pageBlockIndexRange.get(page_num);
				// No SDT blocks landed on this page at all -- vanishingly
				// rare (a page can't be entirely blank if it has an image
				// PyMuPDF found), but falls back to 0 rather than crashing;
				// pass 2's distance-based matching (the path that actually
				// applies here, see comment above) doesn't consult
				// blockIndex anyway.
				let syntheticBlockIndex = range ? (range[0] + range[1]) / 2 : 0;
				let sdtImagesOnPage = images.filter(im => im.page_num === page_num);
				for (let bbox of bboxes) {
					let isDuplicate = sdtImagesOnPage.some(im => iou(im.bbox, bbox) >= PYMUPDF_DUPLICATE_IOU);
					if (isDuplicate) continue;
					images.push({ blockIndex: syntheticBlockIndex, page_num, bbox, content: [] });
				}
			}
		}
		catch (e) {
			console.error(`Failed to load PyMuPDF image list: ${e.message}`);
		}
	}

	let sections = flattenOutline(structure.catalog?.outline || [], structure);
	let { matched, unmatchedBodies: unmatchedImages } = pairWithCaptions(images, captions);

	// Plain numeric caption ("Figure 3: ...") -> figure_num; anything else
	// (lettered-appendix caption, or no caption at all) -> figure_extra_num,
	// a separate counter -- mirrors extract_tables_sdt.js's table_num/
	// table_extra_num split, avoiding a lettered "Figure D.1" ever colliding
	// with a plain "Figure 1" under the same numeric key downstream.
	const PLAIN_NUMBER_RE = /^fig(?:ure)?\.?\s*(\d+)\s*[.:|–—]/i;
	// Terse label prefix only (e.g. "Figure D.1", not the whole caption
	// sentence) -- matches the "Table D.1"/"Formula 8"-style terse labels
	// used everywhere else, for a lettered-appendix caption. Plain-numbered
	// ones don't need this (they get a synthesized `Figure ${figure_num}`
	// below).
	const LABEL_PREFIX_RE = /^((?:figure|fig)\.?\s*(?:[a-z]\.)?\d+)/i;
	let output = [];
	let extraCounter = 0;

	for (let m of matched) {
		let numMatch = PLAIN_NUMBER_RE.exec(m.label);
		let figure_num = numMatch ? parseInt(numMatch[1], 10) : null;
		let figure_extra_num = figure_num === null ? ++extraCounter : null;
		let label;
		if (figure_num !== null) {
			label = `Figure ${figure_num}`;
		}
		else {
			let prefixMatch = LABEL_PREFIX_RE.exec(m.label);
			label = prefixMatch ? prefixMatch[1] : m.label;
		}
		output.push({
			blockIndex: m.blockIndex,
			page_num: m.page_num,
			figure_num,
			figure_extra_num,
			label,
			caption: m.caption,
			image_data: null,
			position: { pageIndex: m.page_num - 1, rects: [m.bbox] },
		});
	}

	// Group unmatched (uncaptioned) images by nearest preceding section, in
	// block order within each section, numbering them "Unlabelled Figure i".
	let bySection = new Map();
	for (let im of unmatchedImages.sort((a, b) => a.blockIndex - b.blockIndex)) {
		let section = nearestSection(sections, im.blockIndex);
		let key = section ? section.title : '(no preceding section)';
		if (!bySection.has(key)) bySection.set(key, []);
		bySection.get(key).push(im);
	}
	for (let [sectionTitle, list] of bySection) {
		list.forEach((im, i) => {
			let label = `${sectionTitle}, Unlabelled Figure ${i + 1}`;
			output.push({
				blockIndex: im.blockIndex,
				page_num: im.page_num,
				figure_num: null,
				figure_extra_num: ++extraCounter,
				label,
				caption: label,
				image_data: null,
				position: { pageIndex: im.page_num - 1, rects: [im.bbox] },
			});
		});
	}

	// figure_id: a plain 1..N sequential id in document (block) order,
	// assigned to EVERY figure regardless of numbering -- see this file's
	// own header comment for why this is separate from figure_num/
	// figure_extra_num. Sorted/assigned here (once, across BOTH groups
	// above) rather than incrementally in either loop, since the two loops
	// don't interleave in block order on their own (all captioned figures
	// are pushed first, then all uncaptioned ones, regardless of where each
	// actually falls in the document).
	output.sort((a, b) => a.blockIndex - b.blockIndex);
	output.forEach((f, i) => {
		f.figure_id = i + 1;
		delete f.blockIndex;
	});

	fs.writeFileSync(outputPath, JSON.stringify(output));
	console.error(`Extracted ${output.length} figures (${matched.length} captioned, ${output.length - matched.length} unlabelled)`);
}

main().catch((e) => {
	console.error(`Error: ${e.stack || e.message}`);
	process.exit(1);
});
