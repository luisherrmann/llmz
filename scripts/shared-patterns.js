// Regex patterns/helpers shared between the main plugin runtime (subscript-
// loaded like every other core/*.js file -- see bootstrap.js) and Node
// subprocess scripts (imported via createRequire -- see e.g.
// extract-equations.js) -- kept in exactly ONE place so a pattern needed on
// both sides of that JS-runtime/Node-subprocess boundary never has two
// copies to silently drift out of sync, the way e.g. the citation-boundary
// ">)" regex currently has to be manually kept in sync across three files
// within the main runtime alone.
//
// Loads natively on BOTH sides via two completely different mechanisms,
// deliberately without needing a build step or bundler (neither exists for
// this plugin):
//   - Zotero's subscript loader executes this file in the SAME shared
//     global scope as every other core/*.js file (see bootstrap.js's own
//     `var LLMPatterns;` pre-declaration) -- so the plain top-level bare
//     assignment below (no `const`/`let`, no import/export -- any of which
//     would be a SYNTAX ERROR in that non-module, shared-scope context) is
//     all that's needed for this half.
//   - A Node ESM script can't `import` a non-module file like this one
//     directly, but CAN load it as a CommonJS module via `createRequire`
//     (Node's own supported bridge from ESM to CommonJS) -- which is what
//     the module.exports tail at the very bottom is for. `module` simply
//     doesn't exist in Zotero's subscript-loader scope, so that tail is a
//     silent no-op there.
// This is a plain UMD-style dual-mode file, not a novel technique -- UMD
// (Universal Module Definition) predates ES modules specifically for "one
// file, multiple module systems," which is exactly this plugin's own split.
//
// For a packed .xpi install, this file also needs to be deployed to a real
// filesystem path alongside extract-equations.js (Node needs a real path,
// not a jar: URI) -- see core/document/references.js's own
// _siblingScriptNames, which this is listed in.
LLMPatterns = {
	// Sentence-boundary split -- shared verbatim with
	// LLMCitation.splitIntoSentences (core/citation.js), which applies its
	// OWN additional length filter (20-500 chars, tuned for standalone
	// citation-chunk selection) on top of this same raw split. A caller
	// that just wants the literal sentence immediately adjacent to
	// something (e.g. equation surrounding-context extraction, see
	// scripts/extract-equations.js) should call splitSentences directly
	// instead of splitIntoSentences -- that length filter would wrongly
	// drop a short but perfectly valid transitional sentence ("Formally,",
	// "Thus,") immediately before/after an equation.
	SENTENCE_BOUNDARY_PATTERN: /(?<=[.!?])\s+(?=[A-Z0-9"'(])/,

	// Splits `text` into sentences at SENTENCE_BOUNDARY_PATTERN, after
	// collapsing all whitespace runs to a single space -- no length
	// filtering and no count cap (unlike LLMCitation.splitIntoSentences,
	// which layers both of those on top of this same split). References
	// LLMPatterns.SENTENCE_BOUNDARY_PATTERN by the object's own top-level
	// name, deliberately NOT `this.SENTENCE_BOUNDARY_PATTERN` -- confirmed
	// concretely that `this` breaks here: the expected call shape on the
	// Node side is `const { splitSentences } = require(...)` (see e.g.
	// extract-equations.js), which detaches the function from its object
	// and leaves `this` undefined, silently turning `this.SENTENCE_BOUNDARY_PATTERN`
	// into `undefined` and `.split(undefined)` into a no-op (String.split
	// with no separator just returns the whole string as a one-element
	// array -- no error, just silently wrong output).
	splitSentences(text) {
		if (!text) return [];
		return text
			.replace(/\s+/g, " ")
			.split(LLMPatterns.SENTENCE_BOUNDARY_PATTERN)
			.map(s => s.trim())
			.filter(Boolean);
	},
};

// Node-side bridge -- see this file's own header comment. `module` doesn't
// exist in Zotero's subscript-loader scope, so this is a no-op there.
if (typeof module !== "undefined" && module.exports) {
	module.exports = LLMPatterns;
}
