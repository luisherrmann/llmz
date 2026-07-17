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
//   compute-document-structure.js <pdf_path> <structure_cache_path>

import { loadOrComputeStructure } from './structure-sdt.js';

async function main() {
	let [, , pdfPath, structureCachePath] = process.argv;
	if (!pdfPath || !structureCachePath) {
		console.error('Usage: compute-document-structure.js <pdf_path> <structure_cache_path>');
		process.exit(1);
	}
	await loadOrComputeStructure(pdfPath, structureCachePath);
}

main();
