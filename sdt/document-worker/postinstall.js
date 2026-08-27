// Sets up node_modules/canvas as a compatibility shim redirecting to
// @napi-rs/canvas's own node-canvas-API-compatible module. Plain node-canvas
// has no Path2D implementation at all, which pdf.js's rendering path
// (src/display/canvas.js) needs; @napi-rs/canvas (Skia-backed) does, and
// ships this exact shim (node-canvas.js) for drop-in compatibility.
// render-runtime.js does a hardcoded dynamicImport('canvas'), so this has
// to exist under that literal package name, not just as a direct
// @napi-rs/canvas import elsewhere.
import { mkdirSync, writeFileSync } from 'node:fs';

mkdirSync('node_modules/canvas', { recursive: true });
writeFileSync(
	'node_modules/canvas/package.json',
	JSON.stringify({ name: 'canvas', version: '3.2.1', main: 'index.js' }, null, 2) + '\n'
);
writeFileSync(
	'node_modules/canvas/index.js',
	"module.exports = require('@napi-rs/canvas/node-canvas.js');\n"
);
console.log('Created node_modules/canvas shim -> @napi-rs/canvas');
