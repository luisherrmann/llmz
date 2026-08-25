// Shared geometric caption-matching toolkit, factored out of
// extract-tables-sdt.js so extract-figures-sdt.js can reuse the exact same
// pairing algorithm against `type: 'image'` SDT blocks instead of
// `type: 'table'` ones -- the matching problem (pair a body block with its
// nearest caption, merge split bodies, fall back to a nearest-heading label
// for anything still unmatched) is identical for both, only the block type
// filter and caption-prefix regex differ per caller. Nothing in this module
// is table- or figure-specific; see each call site's own comments for that
// part.

import { createRequire } from 'module';

// core/geometry.js is a plain CommonJS module (module.exports, no
// import/export syntax) -- require()'d via Node's ESM-to-CommonJS bridge
// rather than imported. Re-exported below so this module's own existing
// importers (extract-tables-sdt.js, extract-figures-sdt.js,
// extract-preformatted-sdt.js) don't need to know unionRect actually lives
// in core/geometry.js.
const require = createRequire(import.meta.url);
const { unionRect } = require('../core/geometry.js');
export { unionRect };

// See shared-patterns.js's own header comment for why this is require()'d
// (via Node's ESM-to-CommonJS bridge) rather than imported -- same as
// extract-equations.js's own use of splitSentences.
const { splitSentences } = require('./shared-patterns.js');

// A body region with NO caption of its own is very often not a distinct
// element at all, but a CONTINUATION of a neighbouring captioned one --
// one logical listing or table that a page break (or, for listings,
// PyMuPDF's own background-fill detection) happened to split into several
// separate regions. This decides whether two ADJACENT regions (in
// document/block order) are safe to merge back into one, by checking
// whether any block strictly BETWEEN their own block-index range contains
// a real sentence -- reuses LLMPatterns.splitSentences (shared-patterns.js,
// the SAME sentence-boundary split core/citation.js's own
// splitIntoSentences applies its own 20-500 char length filter on top of
// -- applied here too, so "genuine sentence" means the same thing here it
// already does everywhere else in this plugin) rather than a bespoke
// check.
//
// Only 'paragraph'/'list' blocks can qualify, as an ALLOWLIST rather than
// skipping a handful of known labels. Every other type is structurally
// incapable of being the explanatory body text this is looking for:
// 'heading'/'caption' are labels (the element's own caption, or an
// unrelated section heading the two fragments happen to straddle), 'image'
// has no prose at all, and -- the case that matters most here --
// 'preformatted' and 'table' are the element's OWN CONTENT.
//
// That last one is why a denylist was wrong. An element's own rows are
// typed 'preformatted' and 'table' (SDT routinely classifies code rows as
// 'table' -- exactly where this plugin's phantom "Unlabelled Table N"
// duplicates come from, see core/document/preformatted.js's
// deduplicatePreformatted), so when one region ends mid-element, the very
// next block is the SAME element continuing, not prose separating two of
// them. A long table's continuation rows on the next page are the same
// case (see extract-tables-sdt.js's own merge pass).
//
// Confirmed on this plugin's own test paper. Listing 7 is a single JSON
// object spanning blocks 172-176 (types table/preformatted/table/
// preformatted/table) that PyMuPDF split into two regions -- one covering
// blocks 172-174, one starting at 176. That leaves exactly one block
// strictly between them: 175, typed 'preformatted', and nothing but more
// of the same JSON. The old denylist counted it as a genuine sentence, so
// the two halves never merged and the first surfaced as its own
// uncaptioned "Preformatted 3" entry alongside the captioned "Listing 7".
// True when the block a region STARTS on is ordinary prose -- i.e. this
// region opens with its own description and is therefore a new element, not
// the previous one continuing.
//
// Companion to hasInterveningProse above, and needed because that test can
// only see blocks strictly BETWEEN two regions. A region routinely absorbs
// the descriptive line printed directly above its body (PyMuPDF draws the
// region from that line down through the code, since they sit in the same
// visual block), which makes the separator the LATER region's own first
// block rather than something between the two -- so the gap test finds
// nothing and the two merge. Observed on OSWorld's appendix, whose whole
// structure is "task description, code, task description, code": four
// listings of six regions each collapsed into one entry spanning three
// pages, with every "Agent > Human Task: ..." separator invisible to the
// gap test for exactly this reason.
//
// Deliberately narrower than hasInterveningProse, which counts 'paragraph'
// AND 'list': only 'paragraph' counts here. A region that BEGINS on a
// numbered 'list' block is almost always code continuing -- the numbering
// is why SDT typed it a list at all. Confirmed on ANS, whose pseudocode
// listing spans pages 6-8 with continuations starting "17 // EndpointRecord:
// {data, signature,Cert}18 ..." and "30 4. certChainValid = VerifyCertChain
// (...)31 ...": both are 'list' blocks whose text clears the sentence-length
// bar, so counting lists here would split a genuine three-page listing into
// three. The two questions really are different -- "what separates two
// regions" versus "what a region begins with" -- so the asymmetry is
// intended, not an oversight.
export function startsWithProse(content, blockIndex) {
	let block = content[blockIndex];
	if (!block || block.type !== 'paragraph') return false;
	let text = flattenText(block).replace(/\s+/g, ' ').trim();
	if (!text) return false;
	return splitSentences(text).some(s => s.length >= 20 && s.length <= 500);
}

export function hasInterveningProse(content, afterBlockIndex, beforeBlockIndex) {
	for (let i = afterBlockIndex + 1; i < beforeBlockIndex; i++) {
		let block = content[i];
		if (!block || (block.type !== 'paragraph' && block.type !== 'list')) continue;
		let text = flattenText(block).replace(/\s+/g, ' ').trim();
		if (!text) continue;
		let sentences = splitSentences(text).filter(s => s.length >= 20 && s.length <= 500);
		if (sentences.length) return true;
	}
	return false;
}

// Flattens a structure node's nested `content` array (text spans, possibly
// nested inside further content-bearing nodes) into a single plain string.
export function flattenText(node) {
	if (!node || !Array.isArray(node.content)) return '';
	return node.content.map(child => (
		typeof child.text === 'string' ? child.text : flattenText(child)
	)).join('');
}

// How much of the LAST line's own height (see getLastLineHeight below) the
// gap to a following block may be for extendCaptionText below to still treat
// it as a wrapped continuation of the same caption, not a real paragraph
// break. A FIXED point value can't work across papers -- observed true
// continuation gaps ranged 1.6-2.1pt in one paper (Penner et al.) and
// 8.7-8.9pt in another (Scutteri et al.), tracking each paper's own font
// size/leading, not some universal constant; a threshold tight enough for
// the first paper would miss every continuation in the second. Scaling by
// the caption's OWN last-line height instead adapts automatically: verified
// against every figure caption in 5 test papers (Penner, Scutteri, Pairoh,
// Bozkurt, Lu), 0.9x correctly matched all 7 genuine continuations and
// rejected every genuine non-continuation (the closest false-positive risk
// observed was Bozkurt's Figure 4, an unrelated body paragraph landing 1.5x
// line-height below the caption -- well outside this ratio).
export const CAPTION_CONTINUATION_LINE_HEIGHT_RATIO = 0.9;

// Extracts the height (maxY - minY, PDF points) of a text block's own LAST
// physical line, from the raw per-line run data SDT's text-extraction layer
// already records on each text span's anchor.textMap (see
// sdt/document-worker/structured-document-text/src/pdf/decode.js's
// buildRunData/reconstructCharPositions for the format this parses: each
// run is `[header, pageIndex, minX, minY, maxX, maxY, ...charWidths]`, one
// run per physical line -- minY/maxY there are the actual glyph bbox for
// THAT line, not a document-wide constant, so this reflects the real
// rendered font size/leading at the point being measured, however it varies
// paper to paper or even block to block. Returns null if the block has no
// text span with a parseable textMap (e.g. an empty or non-text block) --
// callers should treat that as "can't judge, don't merge".
export function getLastLineHeight(block) {
	let spans = [];
	function collect(node) {
		if (!node || !Array.isArray(node.content)) return;
		for (let child of node.content) {
			if (typeof child.text === 'string' && child.anchor?.textMap) spans.push(child);
			else collect(child);
		}
	}
	collect(block);
	if (!spans.length) return null;
	let lastSpan = spans[spans.length - 1];
	try {
		let runs = JSON.parse(lastSpan.anchor.textMap);
		if (!Array.isArray(runs) || !runs.length) return null;
		let [, , , minY, , maxY] = runs[runs.length - 1];
		if (!Number.isFinite(minY) || !Number.isFinite(maxY)) return null;
		return maxY - minY;
	}
	catch {
		return null;
	}
}

// Walks forward from `content[startIndex]` (a caption block, already
// confirmed to start with "Figure"/"Table" etc. by the caller) absorbing
// immediately-following blocks that are really just the REST of the same
// caption -- SDT's own per-block classification only recognizes the
// caption's OPENING line reliably; a multi-panel figure's full caption
// (the "(a) ... (b) ... (c) ..." breakdown that follows the topic sentence)
// routinely comes back as one or more separate `paragraph` blocks instead
// (observed on Penner et al.'s Figure 2: the real caption is 3 blocks --
// `caption` then two `paragraph` blocks -- with everything after the first
// silently dropped if only the `caption`-typed block's own text is used).
//
// A candidate block is absorbed only if ALL of:
//  - same page as the block just absorbed (or the caption itself, for the
//    first hop);
//  - type is `paragraph` or `heading` (SDT sometimes misclassifies a real
//    caption's own opening line as `heading` too -- see extract-figures-sdt.js's
//    own comment on this -- so a continuation immediately after one of
//    those needs the same allowance) -- never `image`/`table`/etc., so a
//    figure's own BODY (sitting right after a caption-above-figure layout)
//    can never be mistaken for more caption text regardless of how close it
//    sits;
//  - the vertical gap to the block just absorbed is between 0 (inclusive --
//    a negative "gap" means the two bboxes overlap or are out of true
//    top-to-bottom order, which happens for reading-order edge cases like a
//    page footer landing right after a caption in block-index order despite
//    sitting nowhere near it visually; never a real wrapped-line adjacency)
//    and CAPTION_CONTINUATION_LINE_HEIGHT_RATIO times the last-absorbed
//    block's own last-line height (see getLastLineHeight -- returns null,
//    treated as "stop", for a block with no measurable text line);
//  - the two blocks' bboxes overlap horizontally by at least half the
//    narrower one's width, so a same-page but different-COLUMN block at a
//    coincidentally small vertical gap (two-column layout) doesn't get
//    absorbed just because nothing else ruled it out yet.
// Stops at the first block that fails any check, or at a page boundary.
//
// `content`: structure.content, the full flat document array (random
// access by index, already fully built before this ever runs -- unlike the
// single forward loop callers collect `images`/`captions` in, this needs to
// look AHEAD of the caption's own index).
// `startIndex`: index of the caption block itself.
// Returns `{ text, bbox }`: the caption's own text plus every absorbed
// block's text (space-joined), and the union of the caption's own bbox with
// every absorbed block's bbox -- so a caller highlighting/navigating to
// "the caption" gets the full region actually covered by the extended text,
// not just the opening `caption`-typed block's own (often much smaller) rect.
export function extendCaptionText(content, startIndex) {
	let block = content[startIndex];
	let pageRect = block.anchor?.pageRects?.[0];
	if (!pageRect) return { text: flattenText(block).replace(/\s+/g, ' ').trim(), bbox: null };
	let page = pageRect[0];
	let text = flattenText(block).replace(/\s+/g, ' ').trim();
	let lastBbox = pageRect.slice(1);
	let bbox = lastBbox;
	let lastBlock = block;

	for (let j = startIndex + 1; j < content.length; j++) {
		let next = content[j];
		let npr = next.anchor?.pageRects?.[0];
		if (!npr || npr[0] !== page) break;
		if (next.type !== 'paragraph' && next.type !== 'heading') break;

		let nbbox = npr.slice(1);
		let lineHeight = getLastLineHeight(lastBlock);
		if (lineHeight === null) break;
		let gap = lastBbox[1] - nbbox[3];
		if (gap < 0 || gap > CAPTION_CONTINUATION_LINE_HEIGHT_RATIO * lineHeight) break;

		let xOverlap = Math.min(lastBbox[2], nbbox[2]) - Math.max(lastBbox[0], nbbox[0]);
		let minWidth = Math.min(lastBbox[2] - lastBbox[0], nbbox[2] - nbbox[0]);
		if (xOverlap < 0.5 * minWidth) break;

		text += ' ' + flattenText(next).replace(/\s+/g, ' ').trim();
		bbox = unionRect(bbox, nbbox);
		lastBbox = nbbox;
		lastBlock = next;
	}
	return { text, bbox };
}

export function rectDistance(a, b) {
	let dx = Math.max(a[0] - b[2], b[0] - a[2], 0);
	let dy = Math.max(a[1] - b[3], b[1] - a[3], 0);
	return Math.sqrt(dx * dx + dy * dy);
}

export function extendRect(a, m) {
	return [a[0] - m, a[1] - m, a[2] + m, a[3] + m];
}

export function iou(a, b) {
	let ix0 = Math.max(a[0], b[0]), iy0 = Math.max(a[1], b[1]);
	let ix1 = Math.min(a[2], b[2]), iy1 = Math.min(a[3], b[3]);
	if (ix1 <= ix0 || iy1 <= iy0) return 0;
	let inter = (ix1 - ix0) * (iy1 - iy0);
	let areaA = (a[2] - a[0]) * (a[3] - a[1]);
	let areaB = (b[2] - b[0]) * (b[3] - b[1]);
	return inter / (areaA + areaB - inter);
}

// Default reach for pairWithCaptions' own final step, which absorbs a
// leftover UNCAPTIONED body into the captioned one it belongs to (see that
// loop below). A body is extended by this much and tested for overlap
// against each already-matched body on the page, so it bounds how far a
// stray fragment may sit from the element it is part of.
//
// 10pt suits a body whose fragments are essentially touching -- a listing
// split by a column break, a table continued on the next page. A caller
// whose bodies are legitimately spread out passes its own value instead
// (see extract-figures-sdt.js: a multi-panel figure prints a label line
// under every row, so its panels sit tens of points apart). It is NOT
// raised globally: at 30 the listings on this plugin's own test paper
// balloon across the page gutter -- Listing 6 goes from 55k to 240k sq pt
// -- because a column-width body that grows sideways is simply wrong,
// whereas a figure genuinely spans the page.
export const EXTEND_MARGIN = 10;

// Groups `images` (a page's `type: 'image'` SDT blocks) into clusters using
// each image's nearest NON-image neighbor above and below it on the page
// (by vertical center, scanning `allBlocks` -- every block on the page,
// any type), rather than block-index adjacency or a fixed distance margin.
// Two images that share the exact same (nearest-above, nearest-below) pair
// of non-image blocks are, by construction, part of the same unbroken run
// of image blocks bounded by real content on both sides -- i.e. pieces of
// one visual figure -- regardless of how far apart they sit geometrically
// or how their own block indices happen to be ordered.
//
// Needed for a case block-index proximity and small-margin bbox merging
// (the existing pairWithCaptions post-pass, see its own comment) both miss
// entirely: a complex multi-panel figure (chemical structures, plot tick
// labels, legend swatches) can come back from SDT as a hundred-plus tiny
// image blocks scattered across most of a page, with gaps between
// individual fragments far wider than any margin that's safe to use
// page-wide -- AND, observed on Penner et al.'s Figure 2, with SDT's own
// reading-order block indices for that whole cluster of fragments landing
// entirely AFTER the figure's own caption, even though the fragments sit
// visually ABOVE it on the page -- so block-index proximity to the caption
// doesn't work as a grouping signal either. What's reliable is that the
// ENTIRE run of fragments making up one figure is bounded above and below
// by the same two pieces of real surrounding content (e.g. a heading above
// and the figure's own caption below) with no non-image block breaking up
// the run in between -- exactly what this groups on.
//
// A single misclassified non-image block sitting in the middle of a real
// figure (e.g. an axis-label paragraph SDT mistyped as a caption) will
// still split that figure into two groups here -- this only fixes the
// block-index/margin blind spots above, not every possible misclassification
// -- but each half remains large enough to survive the caller's own
// size-based candidate filtering and can still be reunited by the existing
// pairWithCaptions post-pass (its own bbox-overlap merge, or same-page
// nearest-distance matching if both halves end up unmatched).
//
// `allBlocks`: [{ blockIndex, bbox }] -- every block on ONE page, any type.
// `images`: [{ blockIndex, bbox, content }] -- the SAME page's `type: 'image'`
//   blocks only (a subset of `allBlocks`).
// Returns one merged candidate per group: { blockIndex, bbox, content },
// `blockIndex` is the group's lowest member index (for reading-order
// placement downstream, same convention as everywhere else in this module).
export function groupImagesByBoundary(allBlocks, images) {
	let sorted = [...allBlocks].sort((a, b) => {
		let aCenter = (a.bbox[1] + a.bbox[3]) / 2;
		let bCenter = (b.bbox[1] + b.bbox[3]) / 2;
		return bCenter - aCenter; // descending y-center: top of page first
	});
	let imageIndexSet = new Set(images.map(im => im.blockIndex));
	let positionByBlockIndex = new Map(sorted.map((b, pos) => [b.blockIndex, pos]));

	let groups = new Map(); // "aboveIndex|belowIndex" -> images[]
	for (let im of images) {
		let pos = positionByBlockIndex.get(im.blockIndex);
		let above = null, below = null;
		for (let k = pos - 1; k >= 0; k--) {
			if (!imageIndexSet.has(sorted[k].blockIndex)) { above = sorted[k].blockIndex; break; }
		}
		for (let k = pos + 1; k < sorted.length; k++) {
			if (!imageIndexSet.has(sorted[k].blockIndex)) { below = sorted[k].blockIndex; break; }
		}
		let key = `${above}|${below}`;
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(im);
	}

	let merged = [];
	for (let group of groups.values()) {
		let bbox = group.reduce((acc, im) => acc ? unionRect(acc, im.bbox) : im.bbox, null);
		let blockIndex = Math.min(...group.map(im => im.blockIndex));
		let content = group.flatMap(im => im.content || []);
		merged.push({ blockIndex, bbox, content });
	}
	return merged;
}

// How many blocks apart (in structure.content's own flat, page-spanning
// order) a body and caption may be for the cross-page pairing pass below to
// still consider them a match. See that pass's own comment for why this is
// a block-count window rather than a distance/margin in PDF points -- there
// is no shared coordinate space to measure a margin in across two different
// pages' bboxes.
export const CROSS_PAGE_BLOCK_WINDOW = 3;

// "above"/"below" describes where the caption sits relative to the body
// block, in reading-order terms (native/bottom-up y: larger y = higher on
// the page) -- "above" means the caption's center sits higher on the page
// than the body's (LaTeX \caption-before-\begin{...} convention), "below"
// the opposite (Nature/Scientific-Reports convention).
export function captionArrangement(bodyBbox, captionBbox) {
	let bodyCenterY = (bodyBbox[1] + bodyBbox[3]) / 2;
	let captionCenterY = (captionBbox[1] + captionBbox[3]) / 2;
	return captionCenterY > bodyCenterY ? "above" : "below";
}

// Matches captions to body blocks (table bodies, or figure/image blocks),
// unions their bboxes, then merges any still-unmatched body into an
// already-paired one on the same page if extending its bbox overlaps one at
// all (handles SDT splitting one real table/figure into multiple blocks).
//
// `bodies`: [{ blockIndex, page_num, bbox, content }]
// `captions`: [{ blockIndex, page_num, bbox, text }] -- already filtered by
//   the caller to whatever caption-prefix regex applies (e.g. "Table"/"Tbl"
//   or "Figure"/"Fig").
//
// Pairing happens in three passes:
//  1. Per-page equal-count fast path: when a page has exactly as many body
//     blocks as captions, pair them by READING ORDER (block index), not
//     distance -- two items stacked closely together can have a caption
//     sitting geometrically CLOSER to the wrong item's body than to its own
//     (observed on Bozkurt et al.'s page 11: Table 3's body ended up nearer
//     to Table 4's caption than to Table 3's own caption, mismatching them
//     under pure nearest-distance matching). A page's own item/caption
//     sequence is essentially never out of reading order, unlike raw
//     geometric distance, so this is the more reliable signal whenever the
//     counts line up 1:1.
//  2. Nearest-distance greedy matching (the original approach) for
//     whatever's left afterward -- pages where the counts didn't match, so
//     there's no clean 1:1 correspondence to exploit.
//  3. Cross-page block-adjacency matching, for whatever's STILL unmatched --
//     covers a body and caption split across a page break (e.g. a full-page
//     figure whose caption spills onto the next page, observed on Scutteri
//     et al.'s page 7/8 boundary). Passes 1-2 both compare bboxes, which
//     only makes sense within a single page's own coordinate space -- a
//     body on page 7 and a caption on page 8 aren't geometrically
//     comparable at all without fusing the two pages' coordinate systems
//     (page height/rotation/scale), which this deliberately avoids. Instead
//     it uses `blockIndex` proximity within CROSS_PAGE_BLOCK_WINDOW blocks:
//     structure.content is already one flat, page-spanning sequence in true
//     document reading order, so a caption that spills onto the next page
//     is, BY CONSTRUCTION, one of the very next blocks after its figure (or
//     one of the very last before it, for a caption-above convention) --
//     not something that needs geometry to locate at all. The window
//     tolerates a stray intervening block or two (a sentence of body text,
//     a footnote); it does NOT need to account for running headers/footers/
//     page numbers specifically, since SDT already excludes those upstream
//     via its own flowClass: 'excluded' classification (see
//     sdt/document-worker/src/pdf/structure/page-label.js) -- they never
//     reach structure.content in the first place.
//
// Returns { matched: [{ blockIndex, page_num, bbox, label, caption, content }],
//   unmatchedBodies: [...] } -- `label`/`caption` both hold the matched
// caption's own text (kept as two separate fields since callers currently
// use `label` as the parseable-for-a-number source and `caption` as the
// full caption text verbatim, even though they start out identical here).
// For a cross-page pair specifically, `bbox` is the body's OWN bbox alone
// (not unioned with the caption's, which lives on a different page and
// isn't a meaningful union target) -- see the final mapping step below.
export function pairWithCaptions(bodies, captions, { absorbMargin = EXTEND_MARGIN } = {}) {
	let unmatchedBodies = bodies.map((b, i) => ({ ...b, _i: i }));
	let unmatchedCaptions = captions.map((c, i) => ({ ...c, _i: i }));
	let takenB = new Set(), takenC = new Set();
	let pairs = [];

	let pages = new Set([...unmatchedBodies.map(b => b.page_num), ...unmatchedCaptions.map(c => c.page_num)]);
	for (let page of pages) {
		let pageBodies = unmatchedBodies.filter(b => b.page_num === page);
		let pageCaptions = unmatchedCaptions.filter(c => c.page_num === page);
		if (!pageBodies.length || pageBodies.length !== pageCaptions.length) continue;
		let sortedBodies = [...pageBodies].sort((a, b) => a.blockIndex - b.blockIndex);
		let sortedCaptions = [...pageCaptions].sort((a, b) => a.blockIndex - b.blockIndex);
		for (let i = 0; i < sortedBodies.length; i++) {
			takenB.add(sortedBodies[i]._i);
			takenC.add(sortedCaptions[i]._i);
			pairs.push({ body: sortedBodies[i], caption: sortedCaptions[i] });
		}
	}

	// A paper is essentially always internally consistent about whether
	// captions sit above or below their body (LaTeX vs. Nature/Sci-Reports
	// style) -- establish that convention from pass 1's confident
	// (reading-order) matches, then deprioritize pass 2 candidates that
	// would violate it: a candidate pairing that puts the caption on the
	// "wrong" side is unlikely to be the real match even when it happens to
	// be geometrically closer. No preference is applied if pass 1 itself
	// didn't produce a clear majority (including no pass-1 matches at all).
	let arrangementCounts = { above: 0, below: 0 };
	for (let p of pairs) {
		arrangementCounts[captionArrangement(p.body.bbox, p.caption.bbox)]++;
	}
	let dominantArrangement = null;
	if (arrangementCounts.above !== arrangementCounts.below) {
		dominantArrangement = arrangementCounts.above > arrangementCounts.below ? "above" : "below";
	}

	let candidates = [];
	for (let b of unmatchedBodies) {
		if (takenB.has(b._i)) continue;
		for (let c of unmatchedCaptions) {
			if (takenC.has(c._i)) continue;
			if (b.page_num !== c.page_num) continue;
			let dist = rectDistance(b.bbox, c.bbox);
			if (dominantArrangement && captionArrangement(b.bbox, c.bbox) !== dominantArrangement) {
				dist = Infinity;
			}
			candidates.push({ b, c, dist });
		}
	}
	candidates.sort((a, b) => a.dist - b.dist);
	for (let { b, c } of candidates) {
		if (takenB.has(b._i) || takenC.has(c._i)) continue;
		takenB.add(b._i);
		takenC.add(c._i);
		pairs.push({ body: b, caption: c });
	}

	// Pass 3: cross-page block-adjacency (see this function's own comment
	// above for the full rationale). Greedy nearest-blockIndex-distance,
	// same shape as pass 2's own candidate-sort-and-assign loop, just
	// keyed on block-count distance instead of rectDistance since there's
	// no shared coordinate space here to measure a geometric distance in.
	let crossPageCandidates = [];
	for (let b of unmatchedBodies) {
		if (takenB.has(b._i)) continue;
		for (let c of unmatchedCaptions) {
			if (takenC.has(c._i)) continue;
			if (Math.abs(b.page_num - c.page_num) !== 1) continue;
			let blockDist = Math.abs(b.blockIndex - c.blockIndex);
			if (blockDist > CROSS_PAGE_BLOCK_WINDOW) continue;
			crossPageCandidates.push({ b, c, blockDist });
		}
	}
	crossPageCandidates.sort((a, b) => a.blockDist - b.blockDist);
	for (let { b, c } of crossPageCandidates) {
		if (takenB.has(b._i) || takenC.has(c._i)) continue;
		takenB.add(b._i);
		takenC.add(c._i);
		pairs.push({ body: b, caption: c });
	}

	let matched = pairs.map(p => ({
		blockIndex: p.body.blockIndex,
		page_num: p.body.page_num,
		// Same-page pair: union both bboxes, capturing body + caption
		// together (existing behavior). Cross-page pair: the body's own
		// bbox alone -- its caption lives on a DIFFERENT page, in a
		// DIFFERENT coordinate space, so unioning the two rects would
		// produce a meaningless, garbled box rather than a real region on
		// either page. The caption's TEXT is still attached below via
		// label/caption either way; only the navigable/highlightable
		// region is scoped to the body's own page for a cross-page pair.
		bbox: p.body.page_num === p.caption.page_num
			? unionRect(p.body.bbox, p.caption.bbox)
			: p.body.bbox,
		label: p.caption.text,
		caption: p.caption.text,
		// The matched caption's OWN block index, alongside the body's
		// `blockIndex` above -- lets a caller tell whether this paper puts
		// captions BEFORE or AFTER what they caption, which the bboxes
		// alone can no longer answer here (they've been unioned together by
		// this point). Purely additive: extract-tables-sdt.js/
		// extract-figures-sdt.js ignore it; extract-preformatted-sdt.js
		// uses it to pick a merge direction for split listings.
		captionBlockIndex: p.caption.blockIndex,
		content: p.body.content,
	}));
	let leftoverBodies = unmatchedBodies.filter(b => !takenB.has(b._i));

	let stillUnmatched = [];
	for (let b of leftoverBodies) {
		let ext = extendRect(b.bbox, absorbMargin);
		let best = null, bestIoU = 0;
		for (let m of matched) {
			if (m.page_num !== b.page_num) continue;
			let score = iou(ext, m.bbox);
			if (score > bestIoU) {
				bestIoU = score;
				best = m;
			}
		}
		if (best) {
			best.bbox = unionRect(best.bbox, b.bbox);
		}
		else {
			stillUnmatched.push(b);
		}
	}

	return { matched, unmatchedBodies: stillUnmatched };
}

// Flattens structure.catalog.outline (title/ref/children tree) into a flat
// list ordered by block index, each resolved to its own page/bbox via the
// referenced block's own anchor.
export function flattenOutline(outline, structure, out = []) {
	for (let entry of outline) {
		let blockIndex = entry.ref?.[0];
		let block = blockIndex != null ? structure.content[blockIndex] : null;
		let pageRect = block?.anchor?.pageRects?.[0];
		if (pageRect) {
			out.push({ blockIndex, title: entry.title, page_num: pageRect[0] + 1, bbox: pageRect.slice(1) });
		}
		if (entry.children?.length) flattenOutline(entry.children, structure, out);
	}
	return out.sort((a, b) => a.blockIndex - b.blockIndex);
}

// Nearest preceding section for a block at `blockIndex` -- the outline
// entry with the largest blockIndex that's still less than the target's own.
export function nearestSection(sections, blockIndex) {
	let best = null;
	for (let s of sections) {
		if (s.blockIndex < blockIndex && (!best || s.blockIndex > best.blockIndex)) {
			best = s;
		}
	}
	return best;
}

// Builds the "terse label prefix" regex for a caption keyword family --
// `keywords` are the accepted spellings, longest first (e.g. ['table',
// 'tbl', 'tab'] or ['figure', 'fig']). Matches the leading label token of
// a caption ("Table 3", "Fig. D.1", "TABLE IV", "Table vii", "Table A")
// and nothing after it, so a caption's descriptive sentence never ends up
// in the label. Shared by extract-tables-sdt.js and extract-figures-sdt.js,
// which previously each carried their own `\d+`-only copy.
//
// The enumerator accepts four forms, tried longest-first:
//   1. an optional appendix letter + digits ("D.1", "3")
//   2. an UPPERCASE roman numeral
//   3. a lowercase roman numeral
//   4. a single letter ("A", "b")
//
// Digits alone used to be the only accepted form, which meant every
// roman-numbered caption fell through to the caller's "use the whole
// caption as the label" fallback. That's the IEEE house style (TABLE I,
// TABLE II, ...), so on such a paper EVERY table/figure got its entire
// caption sentence as its label -- observed on Huang et al.'s ANS paper,
// where one label reached 637 characters because SDT had additionally
// fused that table's caption, body, and the following paragraph into a
// single block, and the fallback copied all of it.
//
// Three separate guards keep the roman branches from eating an ordinary
// word that merely happens to be spelled out of roman letters:
//
//   Single-case. The branches are written without the /i flag (hence the
//   explicit per-character classes for the keyword itself), so a
//   mixed-case word can't match: "Table Mix of methods" is rejected
//   because M-i-x is neither all-upper nor all-lower.
//
//   Canonical form. The token must be a WELL-FORMED numeral, not merely
//   letters drawn from the roman set -- this is what rejects "XML",
//   "LCD", "MID" and "CIVIL". Necessary because case-consistency alone
//   proves nothing in an ALL-CAPS caption, which is exactly the style
//   roman numerals appear in.
//
//   I/V/X/L only. Dropping C/D/M caps the numeral at LXXXIX (89) -- far
//   beyond any real table/figure count -- and removes the last realistic
//   false positives, which were the canonical-but-absurd readings of
//   "MIX" (1009), "DIV" (504) and "CIV" (104).
//
// The trailing lookahead requires the token to END at a delimiter or at
// end-of-string, so "Table Illustrating..." and "Tabular data" can't
// match a leading fragment of their own first word.
export function buildLabelPrefixRe(keywords) {
	// Case-insensitive without /i, which would defeat the single-case rule
	// the roman branches depend on.
	let kw = keywords
		.map(w => [...w].map(c => `[${c.toUpperCase()}${c.toLowerCase()}]`).join(''))
		.join('|');
	let romanUpper = '(?=[LXVI])(?:XL|L?X{0,3})(?:IX|IV|V?I{0,3})';
	let romanLower = '(?=[lxvi])(?:xl|l?x{0,3})(?:ix|iv|v?i{0,3})';
	let enumerator = `(?:[A-Za-z]\\.)?\\d+|${romanUpper}|${romanLower}|[A-Za-z]`;
	return new RegExp(`^((?:${kw})\\.?\\s*(?:${enumerator}))(?=[\\s.:|)\\u2013\\u2014,]|$)`);
}
