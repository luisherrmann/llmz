// Extracts equations from a PDF using Zotero's own document-worker structure
// pipeline (ML-based PDF layout classification, vendored under
// ../sdt/document-worker/) -- same pipeline extract_references.js uses. The
// classifier tags each equation block directly (`type: 'equation'`), and
// structure/math.js's getMathBlocks() identifies which ones the paper itself
// numbers via a trailing right-aligned "(N)" label (e.g. "(3)"), the same way
// papers themselves cross-reference equations in prose ("as given by (3)").
//
// Equations with a detected "(N)" label get equation_num = N, matching the
// number the paper's own prose would use to refer to them (so the model can
// cite them via <ref:equation:N> using a number it actually saw in the PDF
// text). Equations without one are still extracted -- unlike figures/tables,
// where an uncaptioned one isn't worth surfacing at all -- but as a distinct,
// separately-numbered "Formula N" series (equation_num: null, formula_num: N,
// ascending in document order), since there's no real-paper number for the
// model to cite them by -- see llm-chat-pane.js's ref:formula:N handling.
//
// Usage: node --import ../sdt/document-worker/scripts/pdfjs-setup.js extract_equations.js <pdf_path> <output_json_path> [structure_cache_path]
// Output: JSON array of { page_num, equation_num, formula_num, label, text,
//   position }. page_num is the plain 1-indexed page number (null if this
//   block had no anchor at all), same convention/field name
//   extract_tables_sdt.js/extract_figures_sdt.js already use.

import fs from 'fs';
import { getMathBlocks } from '../sdt/document-worker/src/pdf/structure/math.js';
import { loadOrComputeStructure } from './structure_sdt.js';

function flattenText(node) {
	if (!node || !Array.isArray(node.content)) return '';
	return node.content.map(child => (
		typeof child.text === 'string' ? child.text : flattenText(child)
	)).join('');
}

// getMathBlocks() indexes by equation number (parsed from a block's own
// trailing "(N)" word), giving back { src: { blockRef: [i] } } entries --
// invert that into blockRef -> number so each equation block can look up its
// own number directly while walking structure.content below.
function getNumberByBlockRef(structure) {
	let numberByBlockRef = new Map();
	for (let [num, entries] of getMathBlocks(structure)) {
		for (let entry of entries) {
			numberByBlockRef.set(entry.src.blockRef[0], num);
		}
	}
	return numberByBlockRef;
}

function getEquations(structure) {
	let numberByBlockRef = getNumberByBlockRef(structure);
	let equations = [];
	let formulaCount = 0;

	for (let i = 0; i < structure.content.length; i++) {
		let block = structure.content[i];
		if (block.type !== 'math') continue;

		let text = flattenText(block).replace(/\s+/g, ' ').trim();
		if (!text) continue;

		let pageRect = block.anchor?.pageRects?.[0];
		let position = pageRect
			? { pageIndex: pageRect[0], rects: [pageRect.slice(1)] }
			: null;
		// Plain 1-indexed page number, same top-level field (and convention)
		// extract_tables_sdt.js/extract_figures_sdt.js already expose as
		// `page_num` -- previously only reachable indirectly via
		// position.pageIndex (0-indexed, and buried one level down), which
		// meant every caller needing an equation's page had to know that
		// derivation itself rather than just reading a field.
		let page_num = pageRect ? pageRect[0] + 1 : null;

		if (numberByBlockRef.has(i)) {
			let equationNum = numberByBlockRef.get(i);
			equations.push({
				page_num,
				equation_num: equationNum,
				formula_num: null,
				label: `Equation ${equationNum}`,
				text,
				position,
			});
		}
		else {
			formulaCount++;
			equations.push({
				page_num,
				equation_num: null,
				formula_num: formulaCount,
				label: `Formula ${formulaCount}`,
				text,
				position,
			});
		}
	}

	return equations;
}

async function main() {
	let [, , pdfPath, outputPath, structureCachePath] = process.argv;
	if (!pdfPath || !outputPath) {
		console.error('Usage: extract_equations.js <pdf_path> <output_json_path> [structure_cache_path]');
		process.exit(1);
	}
	let structure = await loadOrComputeStructure(pdfPath, structureCachePath);
	let equations = getEquations(structure);
	fs.writeFileSync(outputPath, JSON.stringify(equations));
	console.error(`Extracted ${equations.length} equations`);
}

main().catch((e) => {
	console.error(`Error: ${e.stack || e.message}`);
	process.exit(1);
});
