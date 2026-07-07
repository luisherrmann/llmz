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
// Usage: node --import ../sdt/document-worker/scripts/pdfjs-setup.js extract_equations.js <pdf_path> <output_json_path>
// Output: JSON array of { equation_num, formula_num, label, text, position }.

import fs from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { getStructure } from '../sdt/document-worker/src/pdf/index.js';
import { getMathBlocks } from '../sdt/document-worker/src/pdf/structure/math.js';

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

		if (numberByBlockRef.has(i)) {
			let equationNum = numberByBlockRef.get(i);
			equations.push({
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
	let [, , pdfPath, outputPath] = process.argv;
	if (!pdfPath || !outputPath) {
		console.error('Usage: extract_equations.js <pdf_path> <output_json_path>');
		process.exit(1);
	}
	let buf = fs.readFileSync(pdfPath);
	let structure = await getStructure(buf, '', dataProvider);
	let equations = getEquations(structure);
	fs.writeFileSync(outputPath, JSON.stringify(equations));
	console.error(`Extracted ${equations.length} equations`);
}

main().catch((e) => {
	console.error(`Error: ${e.stack || e.message}`);
	process.exit(1);
});
