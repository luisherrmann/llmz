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
// preformatted_id is a plain 1..N sequential id in document (block) order --
// same "always-unambiguous integer identifier" convention table_id/figure_id
// already use (see extract-tables-sdt.js's own comment on why). blockIndex
// is the region's own minimum constituent block index (see step 5 below),
// kept (unlike table_id/figure_id) since core/document/preformatted.js needs
// it for document-order interleaving against paragraphs/headings. caption is
// a best-effort matched nearby label's text, or '' if none was found (see
// findNearbyCaption below); when matched on the same page, `bbox`/`position`
// already reflect the union of the region's own extent with the caption's,
// same body+caption union convention extract-tables-sdt.js/
// extract-figures-sdt.js apply via match-captions.js's pairWithCaptions.
// position is { pageIndex: page_num - 1, rects: [bbox] }, matching every
// other extraction script's own convention.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { flattenText, unionRect } from './match-captions.js';
import { loadOrComputeStructure } from './structure-sdt.js';

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

// A REAL caption label -- "Listing 6.", "Algorithm 1:", "3) Verification
// Rules:" -- starts with an optional word, then a required integer
// (optionally wrapped in brackets/one-sided punctuation: "1)", "(1)",
// "[1]"), immediately followed by a real word (or the end of the string).
// That trailing condition is the actual discriminator, not the leading
// number alone: confirmed concretely (this plugin's own test paper) that a
// bare numbered-prefix check isn't enough on its own -- "44 4.ReturnMatch"
// (a numbered algorithm STEP line, misclassified by SDT as a
// 'heading'/'caption'-typed block, leaking through as if it were a real
// label) also starts with a number, but is followed by ANOTHER number, not
// a word -- exactly what a genuine label's own trailing text never does.
// Deliberately does NOT accept a plain section header/title with no number
// at all ("D. Protocol-Agnostic Communication Schema", "AgentCapabilityRequest
// Schema:") -- confirmed these are NOT genuine captions for the listing
// they happened to sit nearest to, just the closest heading/caption-typed
// block within the search window; better to report no caption at all
// (empty string, see findNearbyCaption below) than a plausible-looking but
// wrong one, especially since a wrong caption also gets unioned into the
// region's own bounding rect (see the caller's own comment), pulling in
// whatever unrelated text sits between the code and that unrelated header.
function looksLikeCaptionLabel(text) {
	return /^\s*(?:[A-Za-z]+\.?\s+)?[(\[{<]?\d+[)\]}>.:]?(?=\s*(?:[A-Za-z]|$))/.test(text);
}

// A block's own position from its TOP-LEVEL anchor.pageRects (first page
// only, "first page wins") -- same block-level (not per-character)
// resolution core/citation.js used for a preformatted block's own position,
// ported here for the same reason as isCaptionForOtherContent above.
function blockPageRectPosition(block) {
	let pageRects = block.anchor?.pageRects;
	if (!pageRects?.length) return null;
	let pageIndex = pageRects[0][0];
	let rects = pageRects.filter(pr => pr[0] === pageIndex).map(pr => pr.slice(1));
	return { pageIndex, rects };
}

// Best-effort match of a region (spanning constituent blocks
// [minBlockIndex, maxBlockIndex], NOT a single block the way core/
// citation.js's own predecessor of this function anchored on one SDT
// 'preformatted' block's own contentIndex) to a nearby label -- SDT has no
// explicit link tying a caption to what it captions, and a listing's own
// label can land as EITHER a 'heading' or a 'caption' type block, on EITHER
// side of the code, so this searches outward by distance from BOTH edges of
// the region's own span, alternating before/after at each step, and returns
// the FIRST heading/caption text (plus that neighbor's own block-level
// position, so the caller can union it into the region's own bounding rect)
// found within `window` positions of either edge, or { text: '',
// position: null } for no match. Searching from both edges (not just
// minBlockIndex) matters concretely: a region recovering a misclassified
// 'paragraph'/'table' fragment can extend several blocks past whichever
// single block SDT itself tagged 'preformatted', pushing a caption that
// sits just past the region's own FAR edge outside a window measured from
// the NEAR edge alone -- confirmed on this plugin's own test paper (Listing
// 1's own region spans blocks 37-41, with its caption at block 42 -- 5 away
// from minBlockIndex=37, outside window=4, but only 1 away from
// maxBlockIndex=41).
function findNearbyCaption(content, minBlockIndex, maxBlockIndex, window = 4) {
	for (let distance = 1; distance <= window; distance++) {
		for (let neighborIndex of [minBlockIndex - distance, maxBlockIndex + distance]) {
			let neighbor = content[neighborIndex];
			if (!neighbor || (neighbor.type !== 'heading' && neighbor.type !== 'caption')) continue;
			let text = flattenText(neighbor).replace(/\s+/g, ' ').trim();
			if (text && !isCaptionForOtherContent(text) && looksLikeCaptionLabel(text)) {
				return { text, position: blockPageRectPosition(neighbor) };
			}
		}
	}
	return { text: '', position: null };
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
	// caption matching (findNearbyCaption, matches against 'heading'/
	// 'caption'-typed blocks, unrelated to 'preformatted' typing).
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
	let output = [];
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
			let bbox = regions[r];
			let blockIndex = Math.min(...blocks.map(b => b.blockIndex));
			let maxBlockIndex = Math.max(...blocks.map(b => b.blockIndex));

			// Caption matching, same window-search as core/citation.js used
			// to do per SDT 'preformatted' block, now applied once per
			// merged region instead (searching outward from BOTH edges of
			// the region's own block span -- see findNearbyCaption's own
			// comment for why that matters here). A same-page match
			// collapses `bbox` to the SMALLEST single rect covering both the
			// region's own bbox and the caption's -- same body+caption union
			// convention extract-tables-sdt.js/extract-figures-sdt.js
			// already apply via match-captions.js's pairWithCaptions. A
			// different-page match (or no match) leaves `bbox` as the
			// region's own extent alone.
			let { text: caption, position: captionPosition } = findNearbyCaption(structure.content, blockIndex, maxBlockIndex);
			if (caption && captionPosition?.pageIndex === pageNum - 1 && captionPosition.rects.length) {
				let captionBbox = captionPosition.rects.reduce((acc, r) => acc ? unionRect(acc, r) : r, null);
				bbox = unionRect(bbox, captionBbox);
			}

			output.push({
				page_num: pageNum,
				bbox,
				text,
				caption,
				position: { pageIndex: pageNum - 1, rects: [bbox] },
				blockIndex,
			});
		}
	}

	// preformatted_id: plain 1..N sequential id in document (block) order --
	// same convention table_id/figure_id already use (see
	// extract-tables-sdt.js's own comment). blockIndex is kept in the final
	// output (unlike table_id/figure_id's own analogous field, which strips
	// it) -- core/document/preformatted.js needs a value directly comparable
	// to core/citation.js's own paragraph/heading `order` (both are raw
	// structure.content indices) so llm/prompt.js's
	// _interleaveHeadingsAndParagraphs can correctly interleave a
	// preformatted region among headings/paragraphs in true document order.
	output.sort((a, b) => a.blockIndex - b.blockIndex);
	output.forEach((entry, i) => {
		entry.preformatted_id = i + 1;
	});

	fs.writeFileSync(outputPath, JSON.stringify(output));
	console.error(`Extracted ${output.length} preformatted region(s)`);
}

main().catch((e) => {
	console.error(`Error: ${e.stack || e.message}`);
	process.exit(1);
});
