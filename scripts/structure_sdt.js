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

export async function loadOrComputeStructure(pdfPath, structureCachePath) {
	if (structureCachePath && fs.existsSync(structureCachePath)) {
		return JSON.parse(fs.readFileSync(structureCachePath, 'utf8'));
	}

	let buf = fs.readFileSync(resolve(pdfPath));
	let structure = await getStructure(buf, '', dataProvider);

	if (structureCachePath) {
		fs.mkdirSync(dirname(structureCachePath), { recursive: true });
		fs.writeFileSync(structureCachePath, JSON.stringify(structure));
	}

	return structure;
}
