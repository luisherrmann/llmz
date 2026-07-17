// Extracts equations from a PDF using Zotero's own document-worker structure
// pipeline (ML-based PDF layout classification, vendored under
// ../sdt/document-worker/) -- same pipeline extract-references.js uses. The
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
// model to cite them by -- see chat-pane.js's ref:formula:N handling.
//
// Usage: node --import ../sdt/document-worker/scripts/pdfjs-setup.js extract-equations.js <pdf_path> <output_json_path> [structure_cache_path]
// Output: JSON array of { equation_id, page_num, equation_num, formula_num,
//   label, text, preceding_sentence, following_sentence, position }.
//   page_num is the plain 1-indexed page number (null if this block had no
//   anchor at all), same convention/field name extract-tables-sdt.js/
//   extract-figures-sdt.js already use. equation_id is a THIRD, distinct
//   numbering from equation_num/formula_num -- a plain 1..N sequential id,
//   in document (block) order, assigned to EVERY equation regardless of
//   which of the two series it landed in (mirrors extract-figures-sdt.js's
//   own figure_id/extract-tables-sdt.js's own table_id, see either one's
//   header comment for the fuller rationale: an always-present, stable
//   identifier neither number-or-null field can be used as directly).
//   preceding_sentence/following_sentence are the literal sentence
//   immediately before/after the equation in the surrounding prose (null if
//   none exists on that side, e.g. the equation opens/closes the document)
//   -- see findNearestSentence's own comment for how these are found.

import fs from 'fs';
import { createRequire } from 'module';
import { getMathBlocks } from '../sdt/document-worker/src/pdf/structure/math.js';
import { loadOrComputeStructure } from './structure-sdt.js';

// See shared-patterns.js's own header comment for why this is require()'d
// (via Node's ESM-to-CommonJS bridge) rather than imported -- it's the same
// plain file Zotero's own subscript loader executes directly as a global on
// the plugin-runtime side, so it can't use import/export syntax itself.
const require = createRequire(import.meta.url);
const { splitSentences } = require('./shared-patterns.js');

function flattenText(node) {
	if (!node || !Array.isArray(node.content)) return '';
	return node.content.map(child => (
		typeof child.text === 'string' ? child.text : flattenText(child)
	)).join('');
}

// Walks structure.content from `startIndex` in `direction` (-1 or +1),
// skipping any block that isn't type 'paragraph' (an adjacent equation,
// image, table, caption, heading, etc.), until the nearest real prose block
// is found or the array bounds are exhausted -- unbounded, since we want
// the TRUE nearest sentence regardless of how many non-prose blocks sit in
// between, not a "close enough" match the way table/figure caption matching
// needs a distance guard against (there's no ambiguity to resolve here,
// just one nearest neighbor to find). Returns that paragraph's LAST
// sentence (direction -1, "preceding") or FIRST sentence (direction +1,
// "following") via the shared, unfiltered splitSentences (see
// shared-patterns.js) -- deliberately NOT LLMCitation.splitIntoSentences'
// own length-filtered version, since a short transitional sentence right
// next to the equation ("Formally,", "Thus,") is exactly what we want here,
// not something to discard. Returns null if no paragraph block exists on
// this side at all, or if one is found but yields no sentences somehow.
function findNearestSentence(structure, startIndex, direction) {
	for (let i = startIndex; i >= 0 && i < structure.content.length; i += direction) {
		let block = structure.content[i];
		if (block.type !== 'paragraph') continue;
		let text = flattenText(block).replace(/\s+/g, ' ').trim();
		if (!text) continue;
		let sentences = splitSentences(text);
		if (!sentences.length) continue;
		return direction < 0 ? sentences[sentences.length - 1] : sentences[0];
	}
	return null;
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
		// extract-tables-sdt.js/extract-figures-sdt.js already expose as
		// `page_num` -- previously only reachable indirectly via
		// position.pageIndex (0-indexed, and buried one level down), which
		// meant every caller needing an equation's page had to know that
		// derivation itself rather than just reading a field.
		let page_num = pageRect ? pageRect[0] + 1 : null;

		let preceding_sentence = findNearestSentence(structure, i - 1, -1);
		let following_sentence = findNearestSentence(structure, i + 1, 1);

		if (numberByBlockRef.has(i)) {
			let equationNum = numberByBlockRef.get(i);
			equations.push({
				page_num,
				equation_num: equationNum,
				formula_num: null,
				label: `Equation ${equationNum}`,
				text,
				preceding_sentence,
				following_sentence,
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
				preceding_sentence,
				following_sentence,
				position,
			});
		}
	}

	// equation_id: a plain 1..N sequential id in document (block) order,
	// assigned to EVERY equation regardless of which series (equation_num
	// vs. formula_num) it landed in -- see this file's own header comment
	// for why this is separate from both. Safe to assign directly here (no
	// sort needed first, unlike extract-tables-sdt.js's own table_id) since
	// `equations` is already pushed in structure.content's own document
	// order by the loop above -- there's no second, separately-ordered
	// group to interleave back in.
	equations.forEach((e, i) => { e.equation_id = i + 1; });

	return equations;
}

async function main() {
	let [, , pdfPath, outputPath, structureCachePath] = process.argv;
	if (!pdfPath || !outputPath) {
		console.error('Usage: extract-equations.js <pdf_path> <output_json_path> [structure_cache_path]');
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
