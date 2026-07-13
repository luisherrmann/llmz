// Extracts the paper's own References/Bibliography list using Zotero's
// document-worker structure pipeline (ML-based PDF layout classification),
// vendored under ../sdt/document-worker/. This replaces regex/line-based
// reference-list parsing: the classifier tags each bibliography entry
// directly (`reference: true` on a list item), which is far more reliable
// than pattern-matching flat extracted text (handles lowercase-starting
// surnames, page-footer watermark noise, and false-positive "References"
// headings from table columns, all without special-casing).
//
// Usage: node --import ../sdt/document-worker/scripts/pdfjs-setup.js extract_references.js <pdf_path> <output_json_path> [structure_cache_path]
// Output: JSON array of { index, text }, index = the paper's own reference number (or null if not parseable).

import fs from 'fs';

import { loadOrComputeStructure } from './structure_sdt.js';

function flattenText(node) {
	if (!node || !Array.isArray(node.content)) return '';
	return node.content.map(child => (
		typeof child.text === 'string' ? child.text : flattenText(child)
	)).join('');
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
			refs.push({ index: m ? parseInt(m[1], 10) : null, text });
		}
	}
	return refs;
}

async function main() {
	let [, , pdfPath, outputPath, structureCachePath] = process.argv;
	if (!pdfPath || !outputPath) {
		console.error('Usage: extract_references.js <pdf_path> <output_json_path> [structure_cache_path]');
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
