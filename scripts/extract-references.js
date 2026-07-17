// Extracts the paper's own References/Bibliography list using Zotero's
// document-worker structure pipeline (ML-based PDF layout classification),
// vendored under ../sdt/document-worker/. This replaces regex/line-based
// reference-list parsing: the classifier tags each bibliography entry
// directly (`reference: true` on a list item), which is far more reliable
// than pattern-matching flat extracted text (handles lowercase-starting
// surnames, page-footer watermark noise, and false-positive "References"
// headings from table columns, all without special-casing).
//
// Usage: node --import ../sdt/document-worker/scripts/pdfjs-setup.js extract-references.js <pdf_path> <output_json_path> [structure_cache_path]
// Output: JSON array of { reference_id, index, text, position }. `index` =
//   the paper's own printed reference number (or null if not parseable --
//   see getReferences below) -- NOT reliably present, so it can't serve as a
//   stable per-paper identifier on its own. `reference_id` is a separate,
//   ALWAYS-present 1..N sequential id in document (list) order, mirroring
//   extract-figures-sdt.js's own figure_id/extract-tables-sdt.js's own
//   table_id (see either one's header comment for the fuller rationale).
//   `position` is { pageIndex, rects: [[x0,y0,x1,y1], ...] } (null if the
//   entry had no anchor at all) -- read straight off the SAME list-item
//   node's own item.anchor.pageRects that structure.js's ensureBlockPageRects
//   already aggregates onto EVERY block/list-item in the tree (not just
//   math/table/figure blocks -- see its own comment), same field
//   extract-equations.js already reads for its own position. Unlike
//   extract-equations.js (which only takes pageRects[0], since an equation
//   is always a single line/block), a bibliography entry routinely wraps
//   across several lines, so every pageRects entry on the entry's OWN first
//   page is kept (see getReferences below) to produce a multi-line
//   highlight, not just its first line.

import fs from 'fs';

import { loadOrComputeStructure } from './structure-sdt.js';

function flattenText(node) {
	if (!node || !Array.isArray(node.content)) return '';
	return node.content.map(child => (
		typeof child.text === 'string' ? child.text : flattenText(child)
	)).join('');
}

// Builds { pageIndex, rects } from a structure node's own item.anchor.pageRects
// (each entry [pageIndex, x0, y0, x1, y1] -- see this file's own header
// comment) -- null if the node had no anchor/pageRects at all (e.g. an
// unparseable/malformed entry). Only rects on the SAME page as the entry's
// own FIRST line are kept, in case a reference straddles a page break --
// same "one page per position" convention navigateToPosition/every other
// position-backed link in this codebase already assumes (see
// core/citation.js's navigateToPosition), so the highlight covers wherever
// the entry starts even in that rare case, rather than mixing rects from
// two different pages into one nonsensical highlight.
function buildPosition(item) {
	let pageRects = item.anchor?.pageRects;
	if (!pageRects?.length) return null;
	let pageIndex = pageRects[0][0];
	let rects = pageRects.filter(pr => pr[0] === pageIndex).map(pr => pr.slice(1));
	return { pageIndex, rects };
}

// Reference-tagged nodes are always list items inside a top-level `list`
// block (see document-worker/src/pdf/structure/structure.js: reference:true
// is only ever set on structure.content[listRef].content[itemRef]).
function getReferences(structure) {
	let refs = [];
	for (let block of structure.content) {
		if (block.type !== 'list') continue;
		for (let item of block.content) {
			if (item.reference !== true) continue;
			let text = flattenText(item).replace(/\s+/g, ' ').trim();
			if (!text) continue;
			let m = text.match(/^\s*[[({]*\s*(\d{1,4})/);
			refs.push({ index: m ? parseInt(m[1], 10) : null, text, position: buildPosition(item) });
		}
	}
	// reference_id: a plain 1..N sequential id in document (list) order,
	// assigned to EVERY reference regardless of whether its own printed
	// number (`index` above) was parseable -- see this file's own header
	// comment for why this is separate from `index`. Safe to assign
	// directly here (no sort needed first) since `refs` is already pushed
	// in structure.content's own document order by the loop above.
	refs.forEach((r, i) => { r.reference_id = i + 1; });
	return refs;
}

async function main() {
	let [, , pdfPath, outputPath, structureCachePath] = process.argv;
	if (!pdfPath || !outputPath) {
		console.error('Usage: extract-references.js <pdf_path> <output_json_path> [structure_cache_path]');
		process.exit(1);
	}
	let structure = await loadOrComputeStructure(pdfPath, structureCachePath);
	let refs = getReferences(structure);
	fs.writeFileSync(outputPath, JSON.stringify(refs));
	console.error(`Extracted ${refs.length} references`);
}

main().catch((e) => {
	console.error(`Error: ${e.stack || e.message}`);
	process.exit(1);
});
