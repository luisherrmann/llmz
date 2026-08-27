// Extracts tables using ONLY Zotero's document-worker structure pipeline
// (ML-based PDF layout classification, fetched at install time under ../sdt/document-worker/)
// -- no PyMuPDF/Python involved. Replaced the old caption-anchored approach
// (extract_tables.py, since removed), which structurally could not find
// tables with no caption at all (e.g. an "Appendix B. <title>" heading
// directly followed by a table, no "Table B.1:" line anywhere) or
// appendix-lettered captions ("Table D.1:") -- see document/tables.js's own
// comments for the fuller rationale and the empirical comparison that led
// to this replacement.
//
// Pipeline (validated against several real papers before being wired in):
//   1. Collect every `type: 'table'` block (body) and `type: 'caption'` block
//      whose text starts with "Table"/"Tbl" (page + bbox for both).
//   2. Greedily pair each caption with its nearest table body on the same
//      page (rect distance), union their bboxes.
//   3. Greedily pair whatever's still unmatched across an ADJACENT page
//      boundary instead, for a table whose caption spilled onto the next
//      page (e.g. a full-page table with no room left for its own caption)
//      -- by block-index proximity in structure.content's own
//      page-spanning reading order, not bbox distance (a body's and a
//      caption's bboxes on two different pages aren't in a shared
//      coordinate space to begin with -- see match-captions.js's
//      pairWithCaptions for why this doesn't need page-geometry fusion to
//      handle).
//   4. Any table body STILL left unpaired (SDT sometimes splits one real
//      table into multiple blocks, e.g. at an internal sub-heading row)
//      gets checked against already-paired tables on the same page: if
//      extending its bbox by a small margin overlaps one, merge it in
//      rather than treating it as a separate table.
//   5. Any STILL-unpaired table body (genuinely no caption anywhere nearby
//      in the source PDF) gets a synthetic label from its nearest
//      preceding section heading (via structure.catalog.outline, matched
//      by block index -- headings and table bodies share the same
//      sequential block ordering, so this needs no page/coordinate math),
//      numbered in block order per section.
//
// Usage: node --import ../sdt/document-worker/scripts/pdfjs-setup.js extract-tables-sdt.js <pdf_path> <output_json_path> [structure_cache_path]
// Output: JSON array of { table_id, page_num, table_num, table_extra_num,
//   label, caption, data, image_data, position }. table_num is a plain
//   integer only for plainly-numbered captions ("Table 3:"); table_extra_num
//   is a separate 1..K counter for anything else (lettered-appendix or
//   synthetic-from-heading), mirroring extract-equations.js's own
//   equation_num/formula_num split -- avoids the two ever colliding under
//   the same key downstream (buildLinkIndex, citation-link resolution).
// table_id is a THIRD, distinct numbering: a plain 1..N sequential id, in
// document (block) order, assigned to EVERY table regardless of whether it
// has a real printed number at all -- unlike table_num/table_extra_num
// (whose split exists for CITATION links, where the visible text needs to
// read as an actual number the paper prints), table_id exists purely so an
// LLM asked to pick/identify a table can answer with a small, always-
// unambiguous integer instead of needing to reproduce a table's own label
// text exactly (fragile -- a lettered/synthetic label can be long, and a
// model paraphrasing or mistyping punctuation used to require a whole tier
// of fuzzy-matching just to recover from). See document/tables.js/
// llm/prompt.js/tools/table-export.js for where table_id is actually used;
// this script only assigns it.
// image_data is always null here -- no PyMuPDF, so no image rendering;
// data is SDT's own table content (a real row/column grid when SDT's grid
// model successfully fit one, otherwise a single-cell fallback holding its
// flattened text, still meaningfully better than nothing for the small/
// unruled tables PyMuPDF's own find_tables() fails on).

import fs from 'fs';
import { flattenText, pairWithCaptions, flattenOutline, nearestSection, hasInterveningProse, buildLabelPrefixRe } from './match-captions.js';
import { loadOrComputeStructure } from './structure-sdt.js';

// The terse "<word> <number>" prefix of a table caption, normalized so two
// captions naming the SAME table compare equal regardless of how each is
// written or what follows. Accepts the abbreviations papers actually use
// ("Table 1", "Tbl. 1", "Tab. 1") and keeps an appendix letter as part of
// the key, so "Table D.1" never collides with "Table 1".
//
// Used by the merge pass below for the case where BOTH fragments of a
// page-split table carry a caption: a LaTeX longtable repeats its own
// header on each page as "Table 1 - continued from previous page", which
// is a genuine caption by every shape test -- it just names a table that
// has already been seen, rather than introducing a new one. Comparing the
// normalized prefix is what distinguishes "this is the same table
// continuing" from "this is the next table".
// Derived from the SAME pattern that produces a table's terse label, rather
// than a second narrower one: this used to require \d+, so once
// buildLabelPrefixRe learned roman numerals and single letters, a
// roman-numbered table split across pages ("TABLE IV", then "Tab. IV --
// continued") produced no key on either fragment and the two could never be
// recognised as one table.
const CAPTION_LABEL_KEY_RE = buildLabelPrefixRe(['table', 'tbl', 'tab']);

// The enumerator alone, lowercased and stripped of spaces -- "Table 1" and
// "TABLE IV" key on "1" and "iv". Digit forms keep the keys they had before
// ("Table D.1" -> "d.1"), so previously-merging tables are unaffected.
function captionLabelKey(caption) {
	if (!caption) return null;
	let m = CAPTION_LABEL_KEY_RE.exec(caption);
	if (!m) return null;
	let enumerator = m[1].replace(/^\s*(?:table|tbl|tab)\.?\s*/i, '').toLowerCase().replace(/\s+/g, '');
	return enumerator || null;
}

// Collapses a group's fragments into ONE reader position. Mirrors
// llm/prompt.js's own buildLinkIndex window for page-split listings, for
// the same reason: the reader's position format supports exactly two
// adjacent pages (`rects` on `pageIndex`, optional `nextPageRects` on
// `pageIndex + 1`), with no general N-page form. Fragments on the anchor
// page are unioned into `rects`, ones on the next page into
// `nextPageRects`, and a table spanning 3+ pages shows only that two-page
// window.
function buildGroupPosition(fragments, captionFragment) {
	let rectsByPage = new Map();
	for (let f of fragments) {
		let page = f.page_num - 1;
		if (!rectsByPage.has(page)) rectsByPage.set(page, []);
		rectsByPage.get(page).push(f.bbox);
	}
	let pages = [...rectsByPage.keys()].sort((a, b) => a - b);
	let captionPage = captionFragment ? captionFragment.page_num - 1 : null;
	let anchor = (captionPage != null && rectsByPage.has(captionPage)) ? captionPage : pages[0];
	if (anchor === pages[pages.length - 1] && pages.length > 1) {
		let previous = pages[pages.indexOf(anchor) - 1];
		if (previous === anchor - 1) anchor = previous;
	}
	let position = { pageIndex: anchor, rects: rectsByPage.get(anchor) };
	let nextPageRects = rectsByPage.get(anchor + 1);
	if (nextPageRects) position.nextPageRects = nextPageRects;
	return position;
}

// SDT's table block content is either a real row/column grid (array of
// tablerow -> tablecell nodes, when its internal grid-fitting model
// succeeded) or a flattened-text fallback (when it didn't -- see
// table/output.js's createFallbackTableNode). Normalizes either into the
// same `data` shape (array of rows, each an array of cell strings) this
// plugin's formatting/embedding code already expects.
function tableContentToData(content) {
	if (!Array.isArray(content) || !content.length) return [['']];
	let isGrid = content.every(node => node.type === 'tablerow');
	if (isGrid) {
		return content.map(row => (row.content || []).map(cell => {
			let text = flattenText({ content: cell.content }).replace(/\s+/g, ' ').trim();
			return text;
		}));
	}
	// Fallback: content is plain text nodes (or paragraphs) -- flatten
	// everything into one cell rather than dropping it, since even
	// unstructured text is more useful downstream than nothing (see module
	// comment -- this is often the ONLY usable content for small/unruled
	// tables PyMuPDF's own grid detection fails on entirely).
	let text = flattenText({ content }).replace(/\s+/g, ' ').trim();
	return [[text]];
}

async function main() {
	let [, , pdfPath, outputPath, structureCachePath] = process.argv;
	if (!pdfPath || !outputPath) {
		console.error('Usage: extract-tables-sdt.js <pdf_path> <output_json_path> [structure_cache_path]');
		process.exit(1);
	}
	let structure = await loadOrComputeStructure(pdfPath, structureCachePath);

	let tables = [];
	let captions = [];
	for (let i = 0; i < structure.content.length; i++) {
		let block = structure.content[i];
		let pageRect = block.anchor?.pageRects?.[0];
		if (!pageRect) continue;
		if (block.type === 'table') {
			tables.push({ blockIndex: i, page_num: pageRect[0] + 1, bbox: pageRect.slice(1), content: block.content });
		}
		// Checked regardless of block type (not just SDT's own 'caption'
		// classification) -- SDT's block classifier can misclassify a
		// genuine caption as something else entirely (observed on Scutteri
		// et al. for a figure caption misclassified as 'heading' -- see
		// extract-figures-sdt.js's own comment on this same check; the
		// same misclassification risk applies here). A caption
		// misclassified as ANY other type is invisible to the pairing
		// algorithm entirely -- it never even reaches the `captions` list
		// -- regardless of how good the pairing logic itself is, so this
		// only trusts SDT for WHERE the text blocks are, not what it
		// thinks each one IS. The `^` anchor keeps this safe against false
		// positives from an ordinary paragraph that merely MENTIONS a
		// table mid-sentence (e.g. "As shown in Table 2, ...") -- only a
		// block whose text literally STARTS with "Table"/"Tbl"/"Tab"
		// matches at all, which is already a strong caption-like signal on
		// its own regardless of the source block's classified type.
		let text = flattenText(block).replace(/\s+/g, ' ').trim();
		if (/^(table|tbl|tab)\b/i.test(text)) {
			captions.push({ blockIndex: i, page_num: pageRect[0] + 1, bbox: pageRect.slice(1), text });
		}
	}

	let sections = flattenOutline(structure.catalog?.outline || [], structure);
	let { matched, unmatchedBodies: unmatchedTables } = pairWithCaptions(tables, captions);

	// A table that runs past the bottom of a page continues on the next one,
	// and SDT sees each page's portion as its own separate `table` block --
	// so one logical table arrives here as several fragments that have to be
	// merged back together, exactly as page-split listings do in
	// extract-preformatted-sdt.js (see its own grouping pass, and
	// hasInterveningProse in match-captions.js for the shared test).
	let fragments = [
		...matched.map(m => ({
			blockIndex: m.blockIndex, page_num: m.page_num, bbox: m.bbox, content: m.content,
			caption: m.caption, label: m.label, captionBlockIndex: m.captionBlockIndex,
		})),
		...unmatchedTables.map(t => ({
			blockIndex: t.blockIndex, page_num: t.page_num, bbox: t.bbox, content: t.content,
			caption: null, label: null, captionBlockIndex: null,
		})),
	].sort((a, b) => a.blockIndex - b.blockIndex);

	// Which side of its table a caption sits on decides which fragment is
	// the CONTINUATION -- the one that must not have a caption of its own
	// for the two to be the same table. Established from the document rather
	// than assumed, by majority over the captions actually matched, the same
	// way extract-preformatted-sdt.js and match-captions.js's own
	// dominantArrangement already do.
	let captionsPrecedeTables = (() => {
		let before = 0;
		let after = 0;
		for (let m of matched) {
			if (m.captionBlockIndex == null || m.captionBlockIndex === m.blockIndex) continue;
			if (m.captionBlockIndex < m.blockIndex) before++;
			else after++;
		}
		return before >= after;
	})();

	// Two adjacent fragments are the same table under either of two rules,
	// in order of how direct the evidence is:
	//
	//   1. The continuation's caption names the SAME table as the group it
	//      would join ("Table 9" then "Table 9 - continued from previous
	//      page"). Two different tables in one document do not share a
	//      number, so this is the document stating outright that these are
	//      one table -- which beats any heuristic, and merges regardless of
	//      what sits in between.
	//   2. Otherwise, the continuation carries no caption at all AND no real
	//      prose separates the two -- the implicit case, where a table simply
	//      spills onto the next page with nothing repeated.
	//
	let groups = [];
	let current = null;
	let currentKey = null;
	for (let fragment of fragments) {
		if (!current) {
			current = [fragment];
			currentKey = captionLabelKey(fragment.caption);
			groups.push(current);
			continue;
		}
		let earlier = current[current.length - 1];
		let later = fragment;
		let earlierKey = captionLabelKey(earlier.caption);
		let laterKey = captionLabelKey(later.caption);
		// Which side is the continuation flips with the caption convention,
		// exactly as in extract-preformatted-sdt.js's own grouping pass.
		let continuation = captionsPrecedeTables ? later : earlier;
		let continuationKey = captionsPrecedeTables ? laterKey : earlierKey;
		let establishedKey = (captionsPrecedeTables ? earlierKey : laterKey) || currentKey;

		let sameTable;
		if (continuationKey && establishedKey && continuationKey === establishedKey) {
			sameTable = true;
		}
		else {
			sameTable = !continuation.caption
				&& !hasInterveningProse(structure.content, earlier.blockIndex, later.blockIndex);
		}

		if (sameTable) {
			current.push(fragment);
			currentKey = currentKey || laterKey || earlierKey;
		}
		else {
			current = [fragment];
			currentKey = captionLabelKey(fragment.caption);
			groups.push(current);
		}
	}

	// One entry per logical table. `data` is every fragment's rows in
	// document order -- a repeated "continued" header row is kept rather
	// than stripped, since it is real printed content and a fragment may not
	// have one at all. The caption kept is the one from the END the document
	// puts its captions on, so a "continued from previous page" repeat never
	// displaces the real introducing caption.
	let merged = groups.map((group) => {
		let captioned = group.filter(f => f.caption);
		let captionFragment = captionsPrecedeTables ? captioned[0] : captioned[captioned.length - 1];
		return {
			blockIndex: group[0].blockIndex,
			page_num: group[0].page_num,
			caption: captionFragment?.caption || null,
			label: captionFragment?.label || null,
			data: group.flatMap(f => tableContentToData(f.content)),
			position: buildGroupPosition(group, captionFragment),
		};
	});
	matched = merged.filter(t => t.caption);
	unmatchedTables = merged.filter(t => !t.caption);

	// Plain numeric caption ("Table 3: ...") -> table_num; anything else
	// (lettered-appendix caption, or no caption at all) -> table_extra_num,
	// a separate counter -- mirrors extract-equations.js's equation_num/
	// formula_num split, avoiding a lettered "Table D.1" ever colliding with
	// a plain "Table 1" under the same numeric key downstream.
	const PLAIN_NUMBER_RE = /^tab(?:le)?\.?\s*(\d+)\s*[.:|–—]/i;
	// Terse label prefix only (e.g. "Table D.1", not the whole caption
	// sentence) -- matches the "Table 1"/"Formula 8"-style terse labels used
	// everywhere else, for a lettered-appendix, roman-numbered, or
	// single-letter caption. Plain-numbered ones don't need this (they get a
	// synthesized `Table ${table_num}` below).
	const LABEL_PREFIX_RE = buildLabelPrefixRe(['table', 'tbl', 'tab']);
	let output = [];
	let extraCounter = 0;

	for (let m of matched) {
		let numMatch = PLAIN_NUMBER_RE.exec(m.label);
		let table_num = numMatch ? parseInt(numMatch[1], 10) : null;
		let table_extra_num = table_num === null ? ++extraCounter : null;
		let label;
		if (table_num !== null) {
			label = `Table ${table_num}`;
		}
		else {
			let prefixMatch = LABEL_PREFIX_RE.exec(m.label);
			label = prefixMatch ? prefixMatch[1] : m.label;
		}
		output.push({
			blockIndex: m.blockIndex,
			page_num: m.page_num,
			table_num,
			table_extra_num,
			label,
			caption: m.caption,
			data: m.data,
			image_data: null,
			position: m.position,
		});
	}

	// Group unmatched (uncaptioned) tables by nearest preceding section, in
	// block order within each section, numbering them "Unlabelled Table i".
	let bySection = new Map();
	for (let t of unmatchedTables.sort((a, b) => a.blockIndex - b.blockIndex)) {
		let section = nearestSection(sections, t.blockIndex);
		let key = section ? section.title : '(no preceding section)';
		if (!bySection.has(key)) bySection.set(key, []);
		bySection.get(key).push(t);
	}
	for (let [sectionTitle, list] of bySection) {
		list.forEach((t, i) => {
			let label = `${sectionTitle}, Unlabelled Table ${i + 1}`;
			output.push({
				blockIndex: t.blockIndex,
				page_num: t.page_num,
				table_num: null,
				table_extra_num: ++extraCounter,
				label,
				caption: label,
				data: t.data,
				image_data: null,
				position: t.position,
			});
		});
	}

	// table_id: a plain 1..N sequential id in document (block) order,
	// assigned to EVERY table regardless of numbering -- see this file's own
	// header comment for why this is separate from table_num/table_extra_num.
	// Sorted/assigned here (once, across BOTH groups above) rather than
	// incrementally in either loop, since the two loops don't interleave in
	// block order on their own (all captioned tables are pushed first, then
	// all uncaptioned ones, regardless of where each actually falls in the
	// document).
	output.sort((a, b) => a.blockIndex - b.blockIndex);
	output.forEach((t, i) => {
		t.table_id = i + 1;
		delete t.blockIndex;
	});

	fs.writeFileSync(outputPath, JSON.stringify(output));
	console.error(`Extracted ${output.length} tables (${matched.length} captioned, ${output.length - matched.length} unlabelled)`);
}

main().catch((e) => {
	console.error(`Error: ${e.stack || e.message}`);
	process.exit(1);
});
