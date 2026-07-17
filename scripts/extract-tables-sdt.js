// Extracts tables using ONLY Zotero's document-worker structure pipeline
// (ML-based PDF layout classification, vendored under ../sdt/document-worker/)
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
import { flattenText, pairWithCaptions, flattenOutline, nearestSection } from './match-captions.js';
import { loadOrComputeStructure } from './structure-sdt.js';

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
		// block whose text literally STARTS with "Table"/"Tbl" matches at
		// all, which is already a strong caption-like signal on its own
		// regardless of the source block's classified type.
		let text = flattenText(block).replace(/\s+/g, ' ').trim();
		if (/^(table|tbl)\b/i.test(text)) {
			captions.push({ blockIndex: i, page_num: pageRect[0] + 1, bbox: pageRect.slice(1), text });
		}
	}

	let sections = flattenOutline(structure.catalog?.outline || [], structure);
	let { matched, unmatchedBodies: unmatchedTables } = pairWithCaptions(tables, captions);

	// Plain numeric caption ("Table 3: ...") -> table_num; anything else
	// (lettered-appendix caption, or no caption at all) -> table_extra_num,
	// a separate counter -- mirrors extract-equations.js's equation_num/
	// formula_num split, avoiding a lettered "Table D.1" ever colliding with
	// a plain "Table 1" under the same numeric key downstream.
	const PLAIN_NUMBER_RE = /^tab(?:le)?\.?\s*(\d+)\s*[.:|–—]/i;
	// Terse label prefix only (e.g. "Table D.1", not the whole caption
	// sentence) -- matches the "Table 1"/"Formula 8"-style terse labels used
	// everywhere else, for a lettered-appendix caption. Plain-numbered ones
	// don't need this (they get a synthesized `Table ${table_num}` below).
	const LABEL_PREFIX_RE = /^((?:table|tbl)\.?\s*(?:[a-z]\.)?\d+)/i;
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
			data: tableContentToData(m.content),
			image_data: null,
			position: { pageIndex: m.page_num - 1, rects: [m.bbox] },
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
				data: tableContentToData(t.content),
				image_data: null,
				position: { pageIndex: t.page_num - 1, rects: [t.bbox] },
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
