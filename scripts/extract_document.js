// Runs Zotero's document-worker structure pipeline (ML-based PDF layout
// classification, vendored under ../sdt/document-worker/) exactly ONCE per
// PDF, then derives every SDT-based concern (references, equations, tables,
// figures) from that single result. Each concern's own detection/pairing/
// labeling logic still lives in its own file (extract_references.js,
// extract_equations.js, extract_tables_sdt.js, extract_figures_sdt.js),
// imported here as plain functions taking an already-computed `structure`
// -- previously each of those files independently called getStructure() on
// the same PDF, meaning a single request needing all four concerns (the
// common case -- see request.js, which kicks off getReferenceIndex/
// getEquationIndex/getTableIndex/getFigureIndex together) paid the full ML
// classification cost 4 times over for the same document. Consolidated once
// LLMTables/LLMFigures also moved to SDT-only detection, making the
// redundancy 4x instead of 2x (previously just references+equations).
//
// This is now the only script document/references.js's _runNode ever
// invokes -- see that file's getDocumentStructure(), the single entry point
// LLMEquations/LLMTables/LLMFigures all go through instead of running their
// own scripts directly. Each of the four extract_*.js files above still has
// its own CLI-runnable main() (guarded by an import.meta.url check so it
// doesn't fire when imported here) for standalone/manual/debug runs against
// just one concern.
//
// Usage: node --import ../sdt/document-worker/scripts/pdfjs-setup.js extract_document.js <pdf_path> <output_json_path>
// Output: JSON object { references, equations, tables, figures }, each in
// the exact same shape its own former standalone script produced.

import fs from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { getStructure } from '../sdt/document-worker/src/pdf/index.js';
import { getReferences } from './extract_references.js';
import { getEquations } from './extract_equations.js';
import { extractTables } from './extract_tables_sdt.js';
import { extractFigures } from './extract_figures_sdt.js';

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

async function main() {
	let [, , pdfPath, outputPath] = process.argv;
	if (!pdfPath || !outputPath) {
		console.error('Usage: extract_document.js <pdf_path> <output_json_path>');
		process.exit(1);
	}
	let buf = fs.readFileSync(pdfPath);
	let structure = await getStructure(buf, '', dataProvider);

	let references = getReferences(structure);
	let equations = getEquations(structure);
	let tables = extractTables(structure);
	let figures = extractFigures(structure);

	fs.writeFileSync(outputPath, JSON.stringify({ references, equations, tables, figures }));
	console.error(`Extracted ${references.length} references, ${equations.length} equations, ${tables.length} tables, ${figures.length} figures`);
}

main().catch((e) => {
	console.error(`Error: ${e.stack || e.message}`);
	process.exit(1);
});
