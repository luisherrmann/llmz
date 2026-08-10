// Detects preformatted/code-listing regions by combining TWO independent
// sources, then recovering their full text from SDT's own structure --
// neither source alone is enough (see extract_preformatted.py's own header
// comment, and this plugin's own investigation notes, for the concrete
// failures that motivated this):
//   1. extract_preformatted.py (PyMuPDF): detects a listing's own shaded
//      BACKGROUND BOX plus a body-font mismatch, directly from the PDF's
//      rendering -- gives an accurate, uniform bounding box per listing
//      regardless of how SDT's own layout classifier happened to carve up
//      the blocks inside it.
//   2. SDT's own `type: 'preformatted'` blocks -- confirmed concretely (this
//      plugin's own test paper) that SDT's classifier ALTERNATES between
//      'preformatted' and 'table' for pieces of the SAME code listing (a
//      table-looking `"key": value` indentation pattern apparently confuses
//      it), so relying on SDT's OWN type alone silently drops whichever
//      pieces land as 'table' -- a real listing's own tail
//      (`"rateLimit": {...}`) went missing entirely this way.
//
// Pipeline:
//   1. Run extract_preformatted.py, read its {page_num, bbox, text}[] (its
//      OWN `text` is only used as a FALLBACK signal for step 2 below --
//      see step 3's own comment for why the FINAL text comes from SDT
//      instead).
//   2. Collect SDT's own `type: 'preformatted'` blocks' bboxes (from
//      anchor.pageRects), per page.
//   3. Union-merge every rect from BOTH sources (per page) into consolidated
//      regions -- a PyMuPDF box and an SDT preformatted block describing the
//      same listing collapse into one region; a listing PyMuPDF found that
//      SDT missed (or vice versa) still gets its own.
//   4. For each merged region, scan EVERY block in structure.content
//      (regardless of type -- 'table', 'paragraph', whatever SDT happened to
//      classify it as) for one whose OWN pageRects overlap that region on
//      the same page. This is the step that actually recovers the
//      misclassified 'table' fragments -- membership is decided by
//      GEOMETRY (does this block's own rect fall inside the listing's real
//      visual extent?), not by trusting SDT's per-block type judgment.
//   5. Merge those blocks' own text, in their original document (block)
//      order, into one string per region -- using SDT's own per-block text
//      (via flattenText), not PyMuPDF's raw page.get_text() extraction,
//      so this stays a single source of truth for TEXT CONTENT (SDT) with
//      PyMuPDF used PURELY for geometry/region detection.
//
// Usage: node --import ../sdt/document-worker/scripts/pdfjs-setup.js
//   extract-preformatted-sdt.js <pdf_path> <output_json_path> <python_path>
//   <extract_preformatted_script_path> [structure_cache_path]
// `python_path`/`extract_preformatted_script_path` are passed in (not
// resolved here) since this is a plain Node script with no access to
// LLMPythonSetup's own venv-resolution logic -- the Zotero-side caller
// already has to resolve those anyway to invoke ANY of this plugin's other
// Python scripts, so it costs that caller nothing extra to pass them
// through here too.
// Output: JSON array of
//   { preformatted_id, blockIndex, page_num, bbox, text, caption, position }.
// preformatted_id is a sequential id in document (block) order, same
// "always-unambiguous integer identifier" convention table_id/figure_id
// already use (see extract-tables-sdt.js's own comment on why) -- EXCEPT
// it's not necessarily unique per entry: several array entries can share
// the SAME id when a single logical listing was detected as multiple
// separate regions (most commonly because it spans a page break -- see
// the grouping pass in main() below), one entry per page/fragment, each
// keeping its OWN text/bbox/position. A caller that wants one logical
// listing's full combined text/position groups entries by shared
// preformatted_id and reads them in ARRAY order (already sorted by
// blockIndex, which doubles as within-group ordering); one that just
// wants "what's on this page" already has everything per-entry. blockIndex
// is the region's own minimum constituent block index (see step 5 below),
// kept (unlike table_id/figure_id) since core/document/preformatted.js needs
// it for document-order interleaving against paragraphs/headings. caption is
// a best-effort matched label's text, or '' if none was found (see
// pairWithCaptions below, the SAME shared caption-matching toolkit
// extract-tables-sdt.js/extract-figures-sdt.js use, via match-captions.js) --
// only ever set on the ONE entry (per group) it was actually matched
// against, never propagated to its groupmates. When matched on the same
// page, `bbox`/`position` already reflect the union of the region's own
// extent with the caption's, same convention those two scripts already
// apply. position is { pageIndex: page_num - 1, rects: [bbox] }, matching
// every other extraction script's own convention.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import { flattenText, unionRect, pairWithCaptions } from './match-captions.js';
import { loadOrComputeStructure } from './structure-sdt.js';

// See shared-patterns.js's own header comment for why this is require()'d
// (via Node's ESM-to-CommonJS bridge) rather than imported -- same as
// extract-equations.js's own use of splitSentences.
const require = createRequire(import.meta.url);
const { splitSentences } = require('./shared-patterns.js');

// Two rects are merged (unioned) whenever extending EACH by this many points
// on every side would make them overlap -- absorbs tiny sub-point gaps
// between a PyMuPDF-detected box and SDT's own block-level rect describing
// the same physical region (independently measured, so never pixel-exact),
// without merging two genuinely different, merely nearby regions.
const OVERLAP_MARGIN = 2.0;

// A rect wider than this is rejected outright, whether it's a raw INPUT
// (an SDT block's own anchor.pageRects) or the OUTCOME of a merge -- two
// real, independently confirmed failure modes on this plugin's own test
// paper, both producing a ~524pt-wide rect (this paper's two columns
// combined) against every genuine single-column listing measuring
// 251-261pt:
//   1. An input rect can itself be corrupted at the SOURCE -- confirmed
//      concretely: one SDT 'preformatted' block's own anchor.pageRects
//      spanned nearly the ENTIRE two-column page (both columns, most of
//      the height) instead of its own small snippet, poisoning every
//      region it got merged into.
//   2. A merge OUTCOME can be spuriously cross-column even when both
//      INPUTS were individually plausible -- two same-height rects sitting
//      in the left and right column respectively, at just the right
//      horizontal spacing, can satisfy the overlap test's margin and
//      union into one bogus page-spanning region.
// 300 sits comfortably above every genuine single-column width observed
// (max 261pt) and comfortably below a two-column span (524pt) -- wide
// margin on both sides, not a tuned-to-the-edge threshold.
const MAX_REGION_WIDTH = 300;

function isRectPlausible(rect) {
	return (rect[2] - rect[0]) <= MAX_REGION_WIDTH;
}

function rectsOverlap(a, b, margin = OVERLAP_MARGIN) {
	return (a[0] - margin) < (b[2] + margin) && (a[2] + margin) > (b[0] - margin)
		&& (a[1] - margin) < (b[3] + margin) && (a[3] + margin) > (b[1] - margin);
}

// Iteratively merges any two OVERLAPPING rects in `rects` into their union,
// restarting the scan after each merge so a chain (A overlaps B, B overlaps
// C, but A doesn't directly overlap C) still collapses into ONE region
// rather than stopping at the first pairwise merge -- a plain single pass
// would miss that transitive case. A candidate union that would come out
// wider than MAX_REGION_WIDTH is rejected (the two rects are left
// unmerged) rather than performed -- see that constant's own comment for
// why (case 2, the "individually plausible inputs, implausible union"
// failure).
function mergeOverlappingRects(rects) {
	let merged = rects.slice();
	let changed = true;
	while (changed) {
		changed = false;
		outer:
		for (let i = 0; i < merged.length; i++) {
			for (let j = i + 1; j < merged.length; j++) {
				if (!rectsOverlap(merged[i], merged[j])) continue;
				let candidate = unionRect(merged[i], merged[j]);
				if (!isRectPlausible(candidate)) continue;
				merged[i] = candidate;
				merged.splice(j, 1);
				changed = true;
				break outer;
			}
		}
	}
	return merged;
}

// A candidate caption/heading that's plainly captioning something ELSE -- a
// figure or table, never a code/JSON listing. Ported verbatim from
// core/citation.js's own (now-removed) _isCaptionForOtherContent -- moved
// here since caption matching for preformatted regions now happens in this
// script instead, alongside detection itself, same as extract-tables-sdt.js/
// extract-figures-sdt.js already do their own caption matching (via
// match-captions.js's pairWithCaptions) rather than leaving it to the
// Zotero-side JS module. Deliberately only excludes the OBVIOUS other-
// content prefixes rather than requiring a positive "Listing"/"Algorithm"-
// style match -- real papers use inconsistent conventions for a listing's
// own label (sometimes numbered, sometimes just a section heading, on
// either side of the code), so a narrower allowlist would reject genuine
// matches just as often as this exclusion list avoids bad ones.
function isCaptionForOtherContent(text) {
	return /^(fig(ure)?|table)\b/i.test(text);
}

// A REAL caption label -- "Listing 6.", "Algorithm 1:" -- starts with a
// REQUIRED leading word, then a required integer (optionally wrapped in
// brackets/one-sided punctuation: "1)", "(1)", "[1]"), immediately followed
// by a real word. Both the leading word and the trailing word are required,
// not optional -- confirmed concretely (this plugin's own test paper) that
// a bare "<number>) <word>..." shape with NO leading word is NOT a safe
// signal on its own, in two different ways:
//   - "44 4.ReturnMatch" (a numbered algorithm STEP line, misclassified by
//     SDT as a 'heading'/'caption'-typed block, leaking through as if it
//     were a real label) starts with a number but is followed by ANOTHER
//     number, not a word -- the trailing-word requirement alone catches
//     this one.
//   - "3) Formal Resolution Algorithm: The ANS resolution algorithm takes
//     an ANSName as input and returns a resolvable Endpoint or an error."
//     (a genuine subsection intro, correctly typed 'paragraph' by SDT, but
//     NOT captioning the nearby listing it happened to sit near) DOES have
//     a real trailing word, so the trailing-word check alone doesn't catch
//     it -- but requiring a LEADING word too does, since real listing
//     labels in this document are always "Listing N."/"Algorithm N:"
//     style (a leading word), never a bare "N) ...". This does mean a bare
//     numbered subsection heading ("3) Verification Rules: ...") no longer
//     qualifies as a caption candidate EITHER, even though it was
//     previously accepted -- confirmed an acceptable tradeoff: the region
//     it used to caption has its own real "Listing N." label sitting on
//     its OTHER side (see pairWithCaptions below, which -- unlike the old
//     findNearbyCaption's own arbitrary "check before, then after" order --
//     actually prefers whichever candidate is genuinely closer/more
//     reading-order-correct instead of just whichever side happens to be
//     checked first).
// "20" (a bare leaked line-number fragment) is rejected by the trailing-
// word requirement alone (nothing follows it).
// Deliberately does NOT accept a plain section header/title with no number
// at all ("D. Protocol-Agnostic Communication Schema", "AgentCapabilityRequest
// Schema:") -- confirmed these are NOT genuine captions for the listing
// they happened to sit nearest to; better to report no caption at all than
// a plausible-looking but wrong one, especially since a wrong caption also
// gets unioned into the region's own bounding rect (see pairWithCaptions'
// own body+caption union), pulling in whatever unrelated text sits between
// the code and that unrelated header.
// Deliberately does NOT cap overall length -- this pattern alone can't
// distinguish a genuinely long caption from a short label bundled with a
// following sentence (see the "Formal Resolution Algorithm" example
// above), but the leading-word requirement already rules that specific
// case out on its own; adding a length cutoff on top would just as easily
// reject a real long caption.
function looksLikeCaptionLabel(text) {
	return /^\s*[A-Za-z]+\.?\s+[(\[{<]?\d+[)\]}>.:]?(?=\s*[A-Za-z])/.test(text);
}

// A block's own position from its TOP-LEVEL anchor.pageRects (first page
// only, "first page wins") -- same block-level (not per-character)
// resolution core/citation.js used for a preformatted block's own position,
// ported here for the same reason as isCaptionForOtherContent above.
// Collapsed to a SINGLE bbox (via unionRect) rather than the multi-rect
// array citation.js's own version returns -- pairWithCaptions' own
// bodies/captions shape (see main() below) expects one bbox per candidate,
// same as extract-tables-sdt.js/extract-figures-sdt.js already give it.
function blockPageRectBbox(block) {
	let pageRects = block.anchor?.pageRects;
	if (!pageRects?.length) return null;
	let pageIndex = pageRects[0][0];
	let rects = pageRects.filter(pr => pr[0] === pageIndex).map(pr => pr.slice(1));
	if (!rects.length) return null;
	return { pageIndex, bbox: rects.reduce((acc, r) => acc ? unionRect(acc, r) : r, null) };
}

// A region with NO caption of its own is very often not a distinct
// listing at all, but a CONTINUATION of the next captioned one -- a
// single logical listing PyMuPDF's own background-fill detection (or a
// page break) happened to split into multiple separate regions (see the
// merge pass in main() below). This decides whether two ADJACENT regions
// (in document/block order) are safe to merge back into one, by checking
// whether any block strictly BETWEEN their own block-index range contains
// a real sentence -- reuses LLMPatterns.splitSentences (shared-patterns.js,
// the SAME sentence-boundary split core/citation.js's own
// splitIntoSentences applies its own 20-500 char length filter on top of
// -- applied here too, so "genuine sentence" means the same thing here it
// already does everywhere else in this plugin) rather than a bespoke
// check. A 'heading'/'caption'-typed block is skipped regardless of its
// own text length -- it's a label (e.g. a listing's own caption, or an
// unrelated section heading the two fragments happen to straddle), never
// prose, even a long-titled one that would otherwise pass the length
// filter.
function hasInterveningProse(content, afterBlockIndex, beforeBlockIndex) {
	for (let i = afterBlockIndex + 1; i < beforeBlockIndex; i++) {
		let block = content[i];
		if (!block || block.type === 'heading' || block.type === 'caption') continue;
		let text = flattenText(block).replace(/\s+/g, ' ').trim();
		if (!text) continue;
		let sentences = splitSentences(text).filter(s => s.length >= 20 && s.length <= 500);
		if (sentences.length) return true;
	}
	return false;
}

async function main() {
	let [, , pdfPath, outputPath, pythonPath, extractScriptPath, structureCachePath] = process.argv;
	if (!pdfPath || !outputPath || !pythonPath || !extractScriptPath) {
		console.error('Usage: extract-preformatted-sdt.js <pdf_path> <output_json_path> <python_path> <extract_preformatted_script_path> [structure_cache_path]');
		process.exit(1);
	}

	// Step 1: run extract_preformatted.py into a throwaway temp file --
	// best-effort, same "continue SDT-only on failure" tolerance
	// document/figures.js's own _extractRaw already has for list_page_images.py
	// (see that module's own comment on why a PyMuPDF failure shouldn't take
	// down the whole extraction).
	let pymupdfRegions = [];
	let tmpOutputPath = path.join(os.tmpdir(), `extract-preformatted-${process.pid}-${Date.now()}.json`);
	try {
		execFileSync(pythonPath, [extractScriptPath, pdfPath, tmpOutputPath], { stdio: ['ignore', 'ignore', 'pipe'] });
		pymupdfRegions = JSON.parse(fs.readFileSync(tmpOutputPath, 'utf8'));
	}
	catch (e) {
		console.error(`extract_preformatted.py failed, continuing SDT-only: ${e.message}`);
	}
	finally {
		fs.rmSync(tmpOutputPath, { force: true });
	}

	let structure = await loadOrComputeStructure(pdfPath, structureCachePath);

	// Region geometry comes from PyMuPDF ALONE -- SDT's own 'preformatted'
	// block rects are NOT used as merge input at all, and (see step 5 below)
	// NOT required as a validation gate either. Confirmed concretely (this
	// plugin's own test paper) that SDT's own block-level rects are
	// genuinely unreliable -- one 'preformatted' block's own anchor.pageRects
	// spans nearly the entire page -- while PyMuPDF's background-fill+font
	// signal has been accurate everywhere checked, including regions SDT's
	// own classifier missed or corrupted entirely (e.g. this paper's own
	// "Listing 7" tail, silently dropped end-to-end under the old
	// SDT-gated design since the ONE block that would have satisfied the
	// gate had an unusable rect). SDT is still used for TEXT recovery (step
	// 4 below, unchanged -- any block type, not just 'preformatted') and for
	// caption matching (pairWithCaptions, matched against 'heading'/
	// 'caption'/'paragraph'-typed blocks, unrelated to 'preformatted'
	// typing).
	let byPage = new Map(); // page_num -> [rect, ...]
	function addRect(pageNum, rect) {
		if (!isRectPlausible(rect)) return;
		if (!byPage.has(pageNum)) byPage.set(pageNum, []);
		byPage.get(pageNum).push(rect);
	}
	for (let { page_num, bbox } of pymupdfRegions) {
		addRect(page_num, bbox);
	}

	// Step 3: merge overlapping PyMuPDF regions together, per page (in case
	// PyMuPDF itself split one physical listing into multiple boxes).
	let regionsByPage = new Map(); // page_num -> [mergedRect, ...]
	for (let [pageNum, rects] of byPage) {
		regionsByPage.set(pageNum, mergeOverlappingRects(rects));
	}

	// A 'table' block whose OWN text starts with a real table-caption
	// prefix ("TABLE I", "Table 1:", ...) is a genuine data table, never a
	// misclassified listing fragment -- excluded from ever joining a
	// preformatted region, regardless of geometric adjacency. Needed
	// because "requires one genuine 'preformatted' block" (see step 5's
	// own filter) isn't enough on its own: confirmed concretely (this
	// plugin's own test paper) that a real table can sit with NO visible
	// gap directly above/below an unrelated listing (this paper's own
	// "TABLE I" ends less than a point away from where the VerifyCertChain
	// listing's own detected box begins), so the two merge into one region
	// that DOES contain a real preformatted block (VerifyCertChain itself)
	// -- passing that filter regardless -- while still wrongly absorbing
	// the table's own text. A plain 'table' fragment with no such caption
	// prefix (e.g. this paper's own "rateLimit" tail, mis-classified as
	// 'table' but genuinely part of a JSON listing) is unaffected by this
	// check and still gets included as before.
	const TABLE_CAPTION_RE = /^\s*(table|tbl)\.?\s*[ivxlcdm\d]/i;

	// Step 4: find EVERY block (any type) whose own rect falls inside a
	// merged region, keyed by which region it belongs to. Keyed by
	// blockIndex (a Map, not an array) specifically to dedupe a block with
	// MULTIPLE pageRects entries that both happen to overlap the SAME
	// region -- confirmed concretely as a real failure, not just
	// theoretical: without this, such a block's own text was counted (and
	// so appeared in the final merged text) TWICE.
	let blocksByRegion = new Map(); // "pageNum:regionIndex" -> Map(blockIndex -> { text, type })
	for (let i = 0; i < structure.content.length; i++) {
		let block = structure.content[i];
		let text = flattenText(block);
		if (block.type === 'table' && TABLE_CAPTION_RE.test(text)) continue;
		for (let pageRect of block.anchor?.pageRects || []) {
			let pageNum = pageRect[0] + 1;
			let rect = pageRect.slice(1);
			// Same rejection as step 2's addRect, applied here too --
			// confirmed concretely as a SEPARATE failure from the one
			// addRect alone fixes: even excluded as a merge INPUT, a
			// corrupted oversized block rect (see MAX_REGION_WIDTH's own
			// comment) still trivially "overlaps" one or more real,
			// legitimately-sized regions once checked against them
			// directly here, leaking that block's own unrelated text into
			// whichever region its bogus rect happens to touch.
			if (!isRectPlausible(rect)) continue;
			let regions = regionsByPage.get(pageNum);
			if (!regions) continue;
			for (let r = 0; r < regions.length; r++) {
				if (!rectsOverlap(rect, regions[r], 0)) continue;
				let key = `${pageNum}:${r}`;
				if (!blocksByRegion.has(key)) blocksByRegion.set(key, new Map());
				blocksByRegion.get(key).set(i, { text, type: block.type });
				break; // a block belongs to at most one region
			}
		}
	}

	// Step 5: merge each region's own blocks' text, in document order.
	// Blocks are joined with "\n" between them (unless the accumulated text
	// already ends in whitespace) -- WITHIN one block, flattenText already
	// reproduces its own real line breaks/spacing (confirmed concretely:
	// SDT's raw leaf text already embeds the newlines/indentation a
	// preformatted block needs, no separator required there), but nothing
	// guarantees two SEPARATE blocks' raw text joins cleanly at the seam
	// the way core/citation.js's own _buildListTextIndex found for
	// concatenating separate 'listitem' blocks -- same fix, applied here to
	// whatever mix of block types a region's own bounding box happens to
	// span.
	//
	// NO requirement that a region contain an SDT `type: 'preformatted'`
	// block anymore -- PyMuPDF's own color+font signal stands alone (see
	// this function's own comment above). The ONLY remaining defense
	// against a real data TABLE (bold/shaded header row, e.g. this paper's
	// own "TABLE I") being mistaken for a listing is the TABLE_CAPTION_RE
	// exclusion above, applied per-block while building blocksByRegion --
	// confirmed on this plugin's own test paper that this alone is enough
	// (no table false-positive appeared), but unlike the old "requires
	// SDT-preformatted agreement" gate, this is no longer a structural
	// guarantee -- a real table with NO caption-style opening text
	// ("TABLE I", "Table 1:") could still pass through undetected by this
	// check alone.
	let bodies = [];
	for (let [pageNum, regions] of regionsByPage) {
		for (let r = 0; r < regions.length; r++) {
			let key = `${pageNum}:${r}`;
			let blocks = [...(blocksByRegion.get(key) || new Map())]
				.map(([blockIndex, info]) => ({ blockIndex, ...info }))
				.sort((a, b) => a.blockIndex - b.blockIndex);
			if (!blocks.length) continue;
			let text = '';
			for (let b of blocks) {
				if (text && !/\s$/.test(text)) text += '\n';
				text += b.text;
			}
			if (!text.trim()) continue;
			let blockIndex = Math.min(...blocks.map(b => b.blockIndex));
			let maxBlockIndex = Math.max(...blocks.map(b => b.blockIndex));
			bodies.push({ blockIndex, maxBlockIndex, page_num: pageNum, bbox: regions[r], text });
		}
	}

	// Caption matching -- same shared toolkit extract-tables-sdt.js/
	// extract-figures-sdt.js already use (match-captions.js's
	// pairWithCaptions), instead of this script's own previous ad-hoc
	// "search outward by block-index distance, take whichever side is
	// checked first" approach. That approach had a real, confirmed failure
	// mode beyond just accepting badly-shaped candidates (see
	// looksLikeCaptionLabel's own comment for that half): even among
	// perfectly plausible candidates, checking minBlockIndex-distance
	// before maxBlockIndex+distance at every distance level meant an
	// arbitrary DIRECTIONAL tie-break, not "pick the better match" --
	// confirmed concretely on this plugin's own test paper: a
	// VerifyCertChain listing's own genuine caption ("Listing 2.
	// Certificate Chain Verification Algorithm") sits one block AFTER it,
	// while an unrelated subsection heading ("3) Verification Rules:
	// Certificate Chain Verification") sits one block BEFORE it -- equally
	// close, but the old search always checked "before" first, so it
	// always won regardless of which one actually captions the listing.
	// pairWithCaptions instead uses real geometric distance (equal-per-page
	// reading-order pairing first, then nearest-actual-PDF-point-distance
	// for the rest, then cross-page adjacency) -- the same algorithm
	// already validated across every table/figure this plugin extracts.
	//
	// `captions`: every block (any type -- 'heading', 'caption', AND
	// 'paragraph', see looksLikeCaptionLabel's own comment on why
	// 'paragraph' needs to be included at all) whose own text passes the
	// same shape+exclusion checks the old search used. blockIndex here is
	// the candidate's own raw structure.content index (pairWithCaptions
	// only needs it for its own cross-page block-adjacency pass).
	let captions = [];
	for (let i = 0; i < structure.content.length; i++) {
		let block = structure.content[i];
		if (block.type !== 'heading' && block.type !== 'caption' && block.type !== 'paragraph') continue;
		let text = flattenText(block).replace(/\s+/g, ' ').trim();
		if (!text || isCaptionForOtherContent(text) || !looksLikeCaptionLabel(text)) continue;
		let position = blockPageRectBbox(block);
		if (!position) continue;
		captions.push({ blockIndex: i, page_num: position.pageIndex + 1, bbox: position.bbox, text });
	}

	let { matched } = pairWithCaptions(bodies, captions);
	let matchedByBlockIndex = new Map(matched.map(m => [m.blockIndex, m]));

	// Does this paper put a listing's label BEFORE the listing ("Listing 4.
	// ...", then the code) or AFTER it (code, then "Listing 4. ...")? Both
	// conventions are common, and the answer decides which of two adjacent
	// regions is the CONTINUATION when a listing gets split across a page
	// break (see the grouping pass below) -- guessing wrong groups nothing,
	// leaving every fragment its own separate "listing".
	//
	// Decided by majority over the pairs pairWithCaptions actually matched,
	// comparing each caption's own block index against the body it was
	// matched to -- deliberately not by geometry: the matched `bbox` has
	// already been unioned with the caption's by that point, so the two are
	// no longer separable there, and block order answers "before or after"
	// directly anyway. Ties (or no captioned regions at all) fall back to
	// captions-after, the convention this plugin's own test paper uses and
	// the behavior this pass had before it handled both.
	let captionsPrecedeListings = (() => {
		let precede = 0;
		let follow = 0;
		for (let m of matched) {
			if (m.captionBlockIndex == null) continue;
			if (m.captionBlockIndex < m.blockIndex) precede++;
			else follow++;
		}
		return precede > follow;
	})();

	let output = bodies.map((body) => {
		let m = matchedByBlockIndex.get(body.blockIndex);
		let bbox = m ? m.bbox : body.bbox;
		let caption = m ? m.caption : '';
		return {
			page_num: body.page_num,
			bbox,
			text: body.text,
			caption,
			position: { pageIndex: body.page_num - 1, rects: [bbox] },
			blockIndex: body.blockIndex,
			maxBlockIndex: body.maxBlockIndex,
		};
	});
	output.sort((a, b) => a.blockIndex - b.blockIndex);

	// Grouping pass: an UNCAPTIONED region is very often not a separate
	// listing at all, just a fragment of the NEXT captioned one --
	// confirmed concretely (this plugin's own test paper): a
	// `Resolve(ANSName, RequestedVersionRange):` algorithm spanning pages
	// 7-8 came back as three SEPARATE regions (PyMuPDF's own per-page
	// background-fill detection naturally breaks at a page boundary), with
	// only the LAST one landing next to the paper's own real "Listing 5."
	// label -- the other two, with no caption of their own, are really
	// just earlier PARTS of that same listing.
	//
	// Deliberately does NOT physically combine these into one entry
	// (an earlier version of this pass did, splicing the earlier
	// fragment's own text into the later one's and DISCARDING the earlier
	// fragment's own page/bbox/position entirely) -- that loses real
	// information: the earlier page's own fragment no longer has anything
	// to highlight, and a single `position` can't represent "this one
	// logical listing has its own box on page 5 AND a separate one on page
	// 6" anyway. Instead, every region stays its OWN separate entry (own
	// page_num/bbox/text/position, own place in document order for
	// llm/prompt.js's own interleaving), and fragments belonging to the
	// SAME logical listing simply SHARE a `preformatted_id` -- a caller
	// that wants the full combined text/position can group entries by
	// `preformatted_id` and read them in ARRAY order (already sorted by
	// blockIndex) itself; one that just wants "what's on this page, right
	// here" already has everything it needs per-entry, unlike before.
	//
	// WHICH of two adjacent regions has to be the uncaptioned one depends
	// on where this paper puts its captions, so that's established first
	// (see captionsPrecedeListings below) rather than assumed. Papers are
	// essentially always internally consistent about this -- the same
	// assumption match-captions.js's own pairWithCaptions already makes for
	// its `dominantArrangement` -- so one document-wide decision is enough.
	//
	// Two adjacent regions join the same group only if BOTH:
	//   - the CONTINUATION one has no caption of its own. Which side that
	//     is flips with the convention: for captions AFTER a listing the
	//     continuation is the EARLIER region (its label only shows up
	//     later, on the final fragment); for captions BEFORE a listing it's
	//     the LATER region (the label was already consumed by the first
	//     fragment). A captioned region on the continuation side is its own
	//     distinct, already-labeled listing, and ends the chain.
	//   - hasInterveningProse finds no real sentence of body text between
	//     the earlier region's end and the later one's start -- a caption/
	//     heading label (or nothing) between them doesn't count, but a
	//     genuine explanatory paragraph does, and means the two are
	//     separate content that merely happens to sit adjacently.
	//
	// Each decision is purely pairwise, so a single pass in document order
	// suffices and a chain of several consecutive uncaptioned fragments
	// still groups correctly regardless of direction.
	let sameGroupAsNext = new Array(output.length).fill(false);
	for (let i = 0; i < output.length - 1; i++) {
		let earlier = output[i];
		let later = output[i + 1];
		let continuation = captionsPrecedeListings ? later : earlier;
		if (!continuation.caption && !hasInterveningProse(structure.content, earlier.maxBlockIndex, later.blockIndex)) {
			sameGroupAsNext[i] = true;
		}
	}

	// preformatted_id: plain 1..N sequential id in document (block) order --
	// same convention table_id/figure_id already use (see
	// extract-tables-sdt.js's own comment), EXCEPT an id is no longer
	// necessarily unique -- every entry in one grouping-pass group (see
	// sameGroupAsNext above) shares the SAME id, only incrementing when a
	// group boundary is crossed. blockIndex is kept in the final output
	// (unlike table_id/figure_id's own analogous field, which strips it)
	// -- core/document/preformatted.js needs a value directly comparable
	// to core/citation.js's own paragraph/heading `order` (both are raw
	// structure.content indices) so llm/prompt.js's
	// _interleaveHeadingsAndParagraphs can correctly interleave a
	// preformatted region among headings/paragraphs in true document order.
	let nextId = 1;
	output.forEach((entry, i) => {
		entry.preformatted_id = nextId;
		if (!sameGroupAsNext[i]) nextId++;
	});

	// maxBlockIndex was only ever needed internally, for the merge pass
	// above -- stripped here so it doesn't leak into the documented output
	// schema (see this file's own header comment).
	let finalOutput = output.map(({ maxBlockIndex, ...rest }) => rest);
	fs.writeFileSync(outputPath, JSON.stringify(finalOutput));
	console.error(`Extracted ${finalOutput.length} preformatted region(s)`);
}

main().catch((e) => {
	console.error(`Error: ${e.stack || e.message}`);
	process.exit(1);
});
