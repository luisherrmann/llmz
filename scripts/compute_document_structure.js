// Computes a PDF's SDT structure (ML-based layout classification, via
// Zotero's document-worker pipeline) and caches it to disk as plain JSON --
// nothing else. This is the ONE genuinely unavoidable, expensive step in
// citation-position resolution (see document/citations.js's
// LLMCitationPosition); resolving an already-cached structure against a
// query is cheap text/position matching that document/citations.js now
// does directly in the plugin's own JS (ported from decode.js/this
// script's former resolution logic), reading this cache file straight off
// disk -- no Node subprocess spawn needed for that part anymore, which is
// what made resolving citations from a SECOND (or later) chat reply
// against the same PDF pay Node-startup + structure-JSON-parsing overhead
// every time, even though the structure itself was already cached.
//
// Idempotent -- a no-op if structure_cache_path already exists, so the
// caller doesn't need to coordinate against a race with another resolution
// already in flight.
//
// Usage: node --import ../sdt/document-worker/scripts/pdfjs-setup.js
//   compute_document_structure.js <pdf_path> <structure_cache_path>

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

async function main() {
	let [, , pdfPath, structureCachePath] = process.argv;
	if (!pdfPath || !structureCachePath) {
		console.error('Usage: compute_document_structure.js <pdf_path> <structure_cache_path>');
		process.exit(1);
	}
	if (fs.existsSync(structureCachePath)) {
		return;
	}
	let buf = fs.readFileSync(resolve(pdfPath));
	let structure = await getStructure(buf, '', dataProvider);
	fs.writeFileSync(structureCachePath, JSON.stringify(structure));
}

main();
