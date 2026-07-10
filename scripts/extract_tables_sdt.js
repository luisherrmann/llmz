// Extracts tables using ONLY Zotero's document-worker structure pipeline
// (ML-based PDF layout classification, vendored under ../sdt/document-worker/)
// -- no PyMuPDF/Python involved. Experimental bypass of extract_tables.py's
// caption-anchored approach, which structurally cannot find tables with no
// caption at all (e.g. an "Appendix B. <title>" heading directly followed by
// a table, no "Table B.1:" line anywhere) or appendix-lettered captions
// ("Table D.1:") -- see document/tables.js's own comments for the fuller
// rationale and the empirical comparison against PyMuPDF this replaces for now.
//
// Pipeline (validated against several real papers before being wired in):
//   1. Collect every `type: 'table'` block (body) and `type: 'caption'` block
//      whose text starts with "Table"/"Tbl" (page + bbox for both).
//   2. Greedily pair each caption with its nearest table body on the same
//      page (rect distance), union their bboxes.
//   3. Any table body left unpaired (SDT sometimes splits one real table
//      into multiple blocks, e.g. at an internal sub-heading row) gets
//      checked against already-paired tables on the same page: if extending
//      its bbox by a small margin overlaps one, merge it in rather than
//      treating it as a separate table.
//   4. Any STILL-unpaired table body (genuinely no caption in the source PDF)
//      gets a synthetic label from its nearest preceding section heading
//      (via structure.catalog.outline, matched by block index -- headings
//      and table bodies share the same sequential block ordering, so this
//      needs no page/coordinate math), numbered in block order per section.
//
// Usage: node --import ../sdt/document-worker/scripts/pdfjs-setup.js extract_tables_sdt.js <pdf_path> <output_json_path>
// Output: JSON array of { page_num, table_num, table_extra_num, label,
//   caption, data, image_data, position }. table_num is a plain integer only
//   for plainly-numbered captions ("Table 3:"); table_extra_num is a
//   separate 1..K counter for anything else (lettered-appendix or
//   synthetic-from-heading), mirroring extract_equations.js's own
//   equation_num/formula_num split -- avoids the two ever colliding under
//   the same key downstream (buildLinkIndex, selection matching).
// image_data is always null here -- no PyMuPDF, so no image rendering;
// data is SDT's own table content (a real row/column grid when SDT's grid
// model successfully fit one, otherwise a single-cell fallback holding its
// flattened text, still meaningfully better than nothing for the small/
// unruled tables PyMuPDF's own find_tables() fails on).

import fs from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { getStructure } from '../sdt/document-worker/src/pdf/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODEL_ROOT = resolve(__dirname, '../sdt/document-worker/src/pdf/structure/model');
const PDFJS_EXTERNAL = resolve(__dirname, '../sdt/document-worker/pdf.js/external');

function dataProvider(path) {
	if (path.startsWith('cmaps/')) {
		return fs.readFileSync(resolve(PDFJS_EXTERNAL, 'bcmaps', path.slice('cmaps/'.length)));
	}
	if (path.startsWith('standard_fonts/')) {
		return fs.readFileSync(resolve(PDFJS_EXTERNAL, 'standard_fonts', path.slice('standard_fonts/'.length)));
	}
	if (path === 'wasm/openjpeg.wasm') {
		return fs.readFileSync(resolve(PDFJS_EXTERNAL, 'openjpeg/openjpeg.wasm'));
	}
	return fs.readFileSync(resolve(MODEL_ROOT, path));
}

function flattenText(node) {
	if (!node || !Array.isArray(node.content)) return '';
	return node.content.map(child => (
		typeof child.text === 'string' ? child.text : flattenText(child)
	)).join('');
}

function rectDistance(a, b) {
	let dx = Math.max(a[0] - b[2], b[0] - a[2], 0);
	let dy = Math.max(a[1] - b[3], b[1] - a[3], 0);
	return Math.sqrt(dx * dx + dy * dy);
}

function unionRect(a, b) {
	return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

function extendRect(a, m) {
	return [a[0] - m, a[1] - m, a[2] + m, a[3] + m];
}

function iou(a, b) {
	let ix0 = Math.max(a[0], b[0]), iy0 = Math.max(a[1], b[1]);
	let ix1 = Math.min(a[2], b[2]), iy1 = Math.min(a[3], b[3]);
	if (ix1 <= ix0 || iy1 <= iy0) return 0;
	let inter = (ix1 - ix0) * (iy1 - iy0);
	let areaA = (a[2] - a[0]) * (a[3] - a[1]);
	let areaB = (b[2] - b[0]) * (b[3] - b[1]);
	return inter / (areaA + areaB - inter);
}

const EXTEND_MARGIN = 10;

// "above"/"below" describes where the caption sits relative to the table
// body, in reading-order terms (native/bottom-up y: larger y = higher on
// the page) -- "above" means the caption's center sits higher on the page
// than the table's (LaTeX \caption-before-\begin{tabular} convention),
// "below" the opposite (Nature/Scientific-Reports convention).
function captionArrangement(tableBbox, captionBbox) {
	let tableCenterY = (tableBbox[1] + tableBbox[3]) / 2;
	let captionCenterY = (captionBbox[1] + captionBbox[3]) / 2;
	return captionCenterY > tableCenterY ? "above" : "below";
}

// Matches captions to table bodies, unions their bboxes, then merges any
// still-unmatched table body into an already-paired table on the same page
// if extending its bbox overlaps one at all (handles SDT splitting one real
// table into multiple blocks -- see module comment).
//
// Pairing happens in two passes:
//  1. Per-page equal-count fast path: when a page has exactly as many table
//     bodies as table captions, pair them by READING ORDER (block index),
//     not distance -- two tables stacked closely together can have a
//     caption sitting geometrically CLOSER to the wrong table's body than
//     to its own (observed on Bozkurt et al.'s page 11: Table 3's body
//     ended up nearer to Table 4's caption than to Table 3's own caption,
//     mismatching them under pure nearest-distance matching). A page's own
//     table/caption sequence is essentially never out of reading order,
//     unlike raw geometric distance, so this is the more reliable signal
//     whenever the counts line up 1:1.
//  2. Nearest-distance greedy matching (the original approach) for
//     whatever's left afterward -- pages where the counts didn't match, so
//     there's no clean 1:1 correspondence to exploit.
function pairTablesWithCaptions(tables, captions) {
	let unmatchedTables = tables.map((t, i) => ({ ...t, _i: i }));
	let unmatchedCaptions = captions.map((c, i) => ({ ...c, _i: i }));
	let takenT = new Set(), takenC = new Set();
	let pairs = [];

	let pages = new Set([...unmatchedTables.map(t => t.page_num), ...unmatchedCaptions.map(c => c.page_num)]);
	for (let page of pages) {
		let pageTables = unmatchedTables.filter(t => t.page_num === page);
		let pageCaptions = unmatchedCaptions.filter(c => c.page_num === page);
		if (!pageTables.length || pageTables.length !== pageCaptions.length) continue;
		let sortedTables = [...pageTables].sort((a, b) => a.blockIndex - b.blockIndex);
		let sortedCaptions = [...pageCaptions].sort((a, b) => a.blockIndex - b.blockIndex);
		for (let i = 0; i < sortedTables.length; i++) {
			takenT.add(sortedTables[i]._i);
			takenC.add(sortedCaptions[i]._i);
			pairs.push({ table: sortedTables[i], caption: sortedCaptions[i] });
		}
	}

	// A paper is essentially always internally consistent about whether
	// captions sit above or below their table (LaTeX vs. Nature/Sci-Reports
	// style) -- establish that convention from pass 1's confident
	// (reading-order) matches, then deprioritize pass 2 candidates that
	// would violate it: a candidate pairing that puts the caption on the
	// "wrong" side is unlikely to be the real match even when it happens to
	// be geometrically closer. No preference is applied if pass 1 itself
	// didn't produce a clear majority (including no pass-1 matches at all).
	let arrangementCounts = { above: 0, below: 0 };
	for (let p of pairs) {
		arrangementCounts[captionArrangement(p.table.bbox, p.caption.bbox)]++;
	}
	let dominantArrangement = null;
	if (arrangementCounts.above !== arrangementCounts.below) {
		dominantArrangement = arrangementCounts.above > arrangementCounts.below ? "above" : "below";
	}

	let candidates = [];
	for (let t of unmatchedTables) {
		if (takenT.has(t._i)) continue;
		for (let c of unmatchedCaptions) {
			if (takenC.has(c._i)) continue;
			if (t.page_num !== c.page_num) continue;
			let dist = rectDistance(t.bbox, c.bbox);
			if (dominantArrangement && captionArrangement(t.bbox, c.bbox) !== dominantArrangement) {
				dist = Infinity;
			}
			candidates.push({ t, c, dist });
		}
	}
	candidates.sort((a, b) => a.dist - b.dist);
	for (let { t, c } of candidates) {
		if (takenT.has(t._i) || takenC.has(c._i)) continue;
		takenT.add(t._i);
		takenC.add(c._i);
		pairs.push({ table: t, caption: c });
	}

	let matched = pairs.map(p => ({
		page_num: p.table.page_num,
		bbox: unionRect(p.table.bbox, p.caption.bbox),
		label: p.caption.text,
		caption: p.caption.text,
		tableContent: p.table.content,
	}));
	let leftoverTables = unmatchedTables.filter(t => !takenT.has(t._i));

	let stillUnmatched = [];
	for (let t of leftoverTables) {
		let ext = extendRect(t.bbox, EXTEND_MARGIN);
		let best = null, bestIoU = 0;
		for (let m of matched) {
			if (m.page_num !== t.page_num) continue;
			let score = iou(ext, m.bbox);
			if (score > bestIoU) {
				bestIoU = score;
				best = m;
			}
		}
		if (best) {
			best.bbox = unionRect(best.bbox, t.bbox);
		}
		else {
			stillUnmatched.push(t);
		}
	}

	return { matched, unmatchedTables: stillUnmatched };
}

// Flattens structure.catalog.outline (title/ref/children tree) into a flat
// list ordered by block index, each resolved to its own page/bbox via the
// referenced block's own anchor.
function flattenOutline(outline, structure, out = []) {
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
function nearestSection(sections, blockIndex) {
	let best = null;
	for (let s of sections) {
		if (s.blockIndex < blockIndex && (!best || s.blockIndex > best.blockIndex)) {
			best = s;
		}
	}
	return best;
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
	let [, , pdfPath, outputPath] = process.argv;
	if (!pdfPath || !outputPath) {
		console.error('Usage: extract_tables_sdt.js <pdf_path> <output_json_path>');
		process.exit(1);
	}
	let buf = fs.readFileSync(pdfPath);
	let structure = await getStructure(buf, '', dataProvider);

	let tables = [];
	let captions = [];
	for (let i = 0; i < structure.content.length; i++) {
		let block = structure.content[i];
		let pageRect = block.anchor?.pageRects?.[0];
		if (!pageRect) continue;
		if (block.type === 'table') {
			tables.push({ blockIndex: i, page_num: pageRect[0] + 1, bbox: pageRect.slice(1), content: block.content });
		}
		else if (block.type === 'caption') {
			let text = flattenText(block).replace(/\s+/g, ' ').trim();
			if (/^(table|tbl)\b/i.test(text)) {
				captions.push({ blockIndex: i, page_num: pageRect[0] + 1, bbox: pageRect.slice(1), text });
			}
		}
	}

	let sections = flattenOutline(structure.catalog?.outline || [], structure);
	let { matched, unmatchedTables } = pairTablesWithCaptions(tables, captions);

	// Plain numeric caption ("Table 3: ...") -> table_num; anything else
	// (lettered-appendix caption, or no caption at all) -> table_extra_num,
	// a separate counter -- mirrors extract_equations.js's equation_num/
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
			page_num: m.page_num,
			table_num,
			table_extra_num,
			label,
			caption: m.caption,
			data: tableContentToData(m.tableContent),
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

	fs.writeFileSync(outputPath, JSON.stringify(output));
	console.error(`Extracted ${output.length} tables (${matched.length} captioned, ${output.length - matched.length} unlabelled)`);
}

main().catch((e) => {
	console.error(`Error: ${e.stack || e.message}`);
	process.exit(1);
});
