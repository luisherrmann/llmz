LLMChatPane = {
	id: null,
	version: null,
	rootURI: null,
	initialized: false,
	paneID: null,
	_keydownHandlers: new WeakMap(),
	// Per-paper history of submitted messages, so CMD+DOWN/CMD+UP (see
	// onRender's input keydown handler) can navigate back/forward through
	// what was previously typed for THIS paper specifically -- keyed by the
	// active PDF attachment's item ID (or a fixed key when there's no active
	// PDF), since a fresh <textarea> is created per item-pane render but the
	// underlying history should survive switching away and back.
	_messageHistory: new Map(),
	_css: null,

	init({ id, version, rootURI }) {
		if (this.initialized) return;
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
		this.initialized = true;
	},

	log(msg) {
		Zotero.debug("LLM Chat Pane: " + msg);
	},

	getActiveReaderAttachment() {
		if (!Zotero.Reader) {
			return null;
		}
		let win = Zotero.getMainWindow();
		let selectedID = win?.Zotero_Tabs?.selectedID;
		if (selectedID) {
			let reader = Zotero.Reader.getByTabID(selectedID);
			if (reader?.itemID) {
				return Zotero.Items.get(reader.itemID);
			}
		}
		// Fall back to the item currently shown in the item pane
		let item = this._currentPaneItem;
		if (item?.isPDFAttachment()) {
			return item;
		}
		return null;
	},

	// A stable key for "which paper" a chat input's message history belongs
	// to -- the active PDF attachment's item ID, or a fixed fallback when
	// there's no active PDF (general chat still gets its own shared history).
	_paperHistoryKey() {
		return this.getActiveReaderAttachment()?.id ?? "__no_pdf__";
	},

	_getMessageHistory(key) {
		let history = this._messageHistory.get(key);
		if (!history) {
			history = [];
			this._messageHistory.set(key, history);
		}
		return history;
	},

	// Opens a library item as a new reader tab (if it has a PDF attachment
	// available), falling back to just selecting/highlighting it in the
	// library pane otherwise -- used for the "already in your library" link
	// on a download-reference request, so clicking the paper's title behaves
	// like clicking it directly in the library.
	async _openLibraryItem(item) {
		let win = Zotero.getMainWindow();
		if (!win) return;
		let attachment = await item.getBestAttachment?.();
		if (attachment?.isPDFAttachment?.()) {
			await Zotero.Reader.open(attachment.id);
		}
		else {
			await win.ZoteroPane.selectItem(item.id);
		}
	},

	getReaderSelection() {
		if (!Zotero.Reader) return { text: null, info: "no reader API" };
		let win = Zotero.getMainWindow();
		let selectedID = win?.Zotero_Tabs?.selectedID;
		if (!selectedID) return { text: null, info: "no tab selected" };
		let reader = Zotero.Reader.getByTabID(selectedID);
		if (!reader) return { text: null, info: "no PDF reader in tab" };
		let iwin = reader._iframeWindow;
		if (!iwin) return { text: null, info: "reader._iframeWindow is null" };
		try {
			let text = iwin.getSelection?.()?.toString?.()?.trim();
			if (text) return { text, info: "ok" };
			let n = iwin.frames?.length || 0;
			for (let i = 0; i < n; i++) {
				try {
					text = iwin.frames[i]?.getSelection?.()?.toString?.()?.trim();
					if (text) return { text, info: `ok (frame ${i})` };
				}
				catch (e) {}
			}
			return { text: null, info: `iwin ok, frames=${n}, no selection (may have been cleared on focus)` };
		}
		catch (e) {
			return { text: null, info: `error: ${e.message}` };
		}
	},

	// Returns { item: annotationItemOrNull, info } for the annotation the
	// user currently has selected/highlighted in the reader -- whether they
	// clicked a text-bound highlight/underline directly on the page, a
	// standalone sticky-note pin, or the equivalent entry in the sidebar list
	// (all three funnel into the same selection state; there's no separate
	// "page click" vs. "sidebar click" concept in the reader). Used as an
	// extra signal for note selection ("explain this" while an annotation is
	// selected should strongly favor that one). Reached via the reader's
	// internal React state -- reader._internalReader._state.selectedAnnotationIDs
	// is an array of annotation *keys*, not ids (see reader.js's
	// _getAnnotation(), which sets json.id = item.key for the reader's own
	// bookkeeping) -- this is unofficial/internal reader state, not a public
	// API, so it's wrapped defensively like getReaderSelection/
	// getReaderPageText above; a future Zotero version could restructure it
	// without warning. Only the first selected annotation is used, matching
	// "the currently selected note" (singular) rather than a multi-select.
	getSelectedAnnotation() {
		if (!Zotero.Reader) return { item: null, info: "no reader API" };
		let win = Zotero.getMainWindow();
		let selectedID = win?.Zotero_Tabs?.selectedID;
		if (!selectedID) return { item: null, info: "no tab selected" };
		let reader = Zotero.Reader.getByTabID(selectedID);
		if (!reader) return { item: null, info: "no PDF reader in tab" };
		try {
			let ids = reader._internalReader?._state?.selectedAnnotationIDs;
			if (!ids?.length) return { item: null, info: "no annotation selected" };
			let libraryID = reader._item?.libraryID;
			if (libraryID == null) return { item: null, info: "reader._item unavailable" };
			let item = Zotero.Items.getByLibraryAndKey(libraryID, ids[0]);
			if (!item) return { item: null, info: `selected annotation key ${ids[0]} not found` };
			return { item, info: "ok" };
		}
		catch (e) {
			return { item: null, info: `error: ${e.message}` };
		}
	},

	async getReaderPageText() {
		if (!Zotero.Reader) return { text: null, info: "no reader API" };
		let win = Zotero.getMainWindow();
		let selectedID = win?.Zotero_Tabs?.selectedID;
		if (!selectedID) return { text: null, info: "no tab selected" };
		let reader = Zotero.Reader.getByTabID(selectedID);
		if (!reader) return { text: null, info: "no PDF reader in tab" };
		let iwin = reader._iframeWindow;
		if (!iwin) return { text: null, info: "no _iframeWindow" };
		try {
			// Recursively find the window that actually contains the PDF text layers
			let pdfWin = null;
			let findPDFWin = (w) => {
				try {
					if (w?.document?.querySelector('.textLayer')) { pdfWin = w; return; }
					for (let i = 0; i < (w?.frames?.length || 0); i++) findPDFWin(w.frames[i]);
				}
				catch (e) {}
			};
			findPDFWin(iwin);
			if (!pdfWin) return { text: null, info: "no .textLayer in any frame" };

			// Get current page number — search same frame hierarchy for PDFViewerApplication
			let pageNum = null;
			let findPageNum = (w) => {
				try {
					let app = w?.wrappedJSObject?.PDFViewerApplication || w?.PDFViewerApplication;
					if (app?.page) { pageNum = app.page; return; }
					for (let i = 0; i < (w?.frames?.length || 0); i++) findPageNum(w.frames[i]);
				}
				catch (e) {}
			};
			findPageNum(iwin);

			let doc = pdfWin.document;
			let textLayer = pageNum
				? (doc.querySelector(`.page[data-page-number="${pageNum}"] .textLayer`)
					|| doc.querySelector(`[data-page-number="${pageNum}"] .textLayer`)
					|| doc.querySelector(`#pageContainer${pageNum} .textLayer`))
				: null;
			// Fall back to any visible text layer if page number unknown
			if (!textLayer) textLayer = doc.querySelector('.textLayer');
			if (!textLayer) return { text: null, info: `pdfWin found but no textLayer for page ${pageNum}` };

			let text = textLayer.textContent?.trim();
			if (text && text.length > LLMPrompt.maxPageContextChars) {
				text = text.slice(0, LLMPrompt.maxPageContextChars);
			}
			return { text: text || null, pageNum, info: `page ${pageNum ?? "?"}` };
		}
		catch (e) {
			return { text: null, info: `error: ${e.message}` };
		}
	},

	async main() {
		this.log("Hello World pane loaded");
		this._configureMarkdown();
		await LLMFigures.init(this.rootURI);
		await LLMTables.init(this.rootURI);
		try {
			let hljsCss = await Zotero.File.getContentsFromURL(this.rootURI + "vendor/atom-one-dark.min.css");
			let markdownCss = await Zotero.File.getContentsFromURL(this.rootURI + "style.css");
			this._css = hljsCss + markdownCss;
		}
		catch (e) {
			this.log("Failed to load CSS: " + e.message);
		}
		// Registered LAST, only once this._css is actually populated --
		// registerItemPane() makes the section immediately renderable by
		// Zotero (onItemChange/onRender can fire as soon as registration
		// returns, if the item pane is already visible with an item
		// selected at startup), and onRender's own <style> tag falls back to
		// an EMPTY stylesheet (`this._css || ""`) if this hasn't finished
		// yet -- registering first (the previous order) meant that first
		// render could beat this fetch, rendering completely unstyled until
		// the user switched to a different item and back (a fresh onRender
		// call, by which point the fetch had long since resolved) -- see
		// onRender's own comment for where the fallback lives.
		this.registerItemPane();
	},

	_configureMarkdown() {
		if (typeof marked === "undefined") return;
		// Local (not this._escapeAttr) since the katex extension renderers
		// below are plain object methods handed to marked, which doesn't
		// necessarily invoke them with `this` bound to LLMChatPane. Escapes
		// for safe use as HTML TEXT content (unlike _escapeAttr, which is
		// for quoted attribute values specifically and doesn't need to
		// escape "<"/">" -- this one does, since it's used inside a
		// <span>...</span> body).
		let escapeHtmlText = (str) => String(str)
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;");
		if (typeof hljs !== "undefined") {
			marked.setOptions({
				highlight(code, lang) {
					let language = hljs.getLanguage(lang) ? lang : "plaintext";
					return hljs.highlight(code, { language }).value;
				},
				langPrefix: "hljs language-",
			});
		}
		if (typeof katex !== "undefined") {
			// Two separate extensions, not one shared "inline" tokenizer for
			// both $$ and $ (the original approach) -- confirmed concretely
			// that combining them breaks in two distinct ways:
			// (1) A single stray "$" earlier in the same paragraph (e.g. a
			// currency amount, "$100. The formula is $$x=1$$.") gets matched
			// as the OPENING of inline math by the single-$ pattern, which
			// then greedily consumes everything up to the next "$" it can
			// find -- which is the start of an unrelated $$ block -- turning
			// an entire sentence into garbled "math" and leaving the real
			// formula's closing $$ dangling as literal text.
			// (2) A display math block containing a blank line (e.g. a
			// multi-line derivation the model formatted with blank-line
			// spacing) never renders AT ALL: marked's BLOCK-level lexer
			// splits into separate paragraph tokens at the blank line before
			// an "inline"-level tokenizer ever gets a chance to see the full
			// $$...$$ span, so each half is left as literal, un-rendered "$$"
			// text -- this matches the exact "I see $$ ... $$ not rendered"
			// symptom directly.
			marked.use({
				extensions: [
					// Block-level: runs against the whole remaining source
					// BEFORE marked's own blank-line paragraph-splitting, so
					// a $$...$$ span containing a blank line is still matched
					// as one token (fixes bug 2 above).
					{
						name: "blockMath",
						level: "block",
						start(src) {
							// Requires a FULL $$...$$ match ahead, not just any bare "$$"
							// substring -- a bare-"$$" search false-positives on the
							// accidental "$$" formed at the boundary between two adjacent
							// inline math spans with no separator (e.g. "$3$$4$": the
							// closing $ of the first span sits right against the opening $
							// of the second). That false positive made the lexer split the
							// text there before the inline extension below ever got a
							// chance to tokenize the first span, leaving it as broken
							// literal "$3" text. Requiring a full pair ahead means start()
							// only reports a position where the tokenizer will actually
							// succeed.
							let m = src.match(/\$\$[\s\S]+?\$\$/);
							return m ? m.index : undefined;
						},
						tokenizer(src) {
							let match = src.match(/^\$\$([\s\S]+?)\$\$/);
							if (match) {
								return { type: "blockMath", raw: match[0], text: match[1].trim() };
							}
						},
						renderer(token) {
							try {
								return katex.renderToString(token.text, {
									displayMode: true,
									output: "mathml",
									throwOnError: false,
								}) + "\n";
							}
							catch (e) {
								return `<span>${escapeHtmlText(token.text)}</span>`;
							}
						},
					},
					// Inline-level: single-$ math only (display $$ is fully
					// handled by the block extension above, so this no longer
					// needs to try $$ at all). Requires a non-space character
					// on the inside of both delimiters, and no digit
					// immediately after the closing $ -- so a lone currency
					// "$" (e.g. "$100" or "$5 and $10") can't be mistaken for
					// an opening/closing delimiter (fixes bug 1 above).
					{
						name: "inlineMath",
						level: "inline",
						start(src) {
							let m = src.match(/\$/);
							return m ? m.index : undefined;
						},
						tokenizer(src) {
							let match = src.match(/^\$(?!\s)([^$\n]*?[^\s$])\$(?!\d)/);
							if (match) {
								return { type: "inlineMath", raw: match[0], text: match[1].trim() };
							}
						},
						renderer(token) {
							try {
								return katex.renderToString(token.text, {
									displayMode: false,
									output: "mathml",
									throwOnError: false,
								});
							}
							catch (e) {
								return `<span>${escapeHtmlText(token.text)}</span>`;
							}
						},
					},
				],
			});
		}
	},

	// Was missing "<"/">" escaping -- harmless for most attribute values, but
	// a real bug for ones built from model-generated or PDF-extracted text
	// (grounded citation phrases, captions, etc.) that can contain a literal
	// "<" or ">" (e.g. an inequality like "x < 5"), which then corrupts the
	// surrounding HTML once inserted unescaped -- this was the root cause of
	// a "innerHTML: An invalid or illegal string was specified" crash on
	// longer replies (more grounded citations = more chances of hitting one).
	_escapeAttr(str) {
		return String(str)
			.replace(/&/g, "&amp;")
			.replace(/"/g, "&quot;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;");
	},

	// Renders markdown, converting three kinds of link tokens to HTML anchors
	// (all sharing the `llm-find-link` class, so figure/table links look
	// identical to citation links -- blue, underlined):
	//   [label](<find:query>)      -- citation: text-search navigation
	//   [label](<ref:table:N>) /
	//   [label](<ref:tableExtra:N>) /
	//   [label](<ref:figure:N>) /
	//   [label](<ref:figureExtra:N>) /
	//   [label](<ref:equation:N>) /
	//   [label](<ref:note:KEY>)    -- table/figure/equation/note mention: looked
	//                                  up in linkIndex for precise navigation --
	//                                  by annotation key (select + scroll, notes
	//                                  only) if present, else by position,
	//                                  else falling back to a caption
	//                                  text-search (e.g. rotated tables).
	//                                  Every ref: kind uses a numeric N
	//                                  EXCEPT note, which uses the
	//                                  annotation's actual (string) Zotero
	//                                  item key -- see LLMPrompt.buildLinkIndex
	//                                  for why.
	//   [label](<ref:page:N>)      -- bare page-number mention: scrolls directly
	//                                  to page N, no linkIndex lookup needed --
	//                                  unlike the others, this isn't tied to a
	//                                  specific extracted item, just the page
	//                                  itself
	// Done before marked parses, so spaces/special chars in the query don't
	// break markdown link parsing.
	// `citationPositions`, if given, is a Map of citation phrase -> resolved
	// { pageIndex, rects } | null (see document/citations.js's
	// LLMCitationPosition.resolvePositions, called synchronously by
	// request.js BEFORE rendering -- fast, in-process, no network calls,
	// see its own comment for why). Doubles as citation VERIFICATION, not
	// just navigation: a phrase that resolves to an actual position was
	// found verbatim (modulo whitespace/hyphen normalization) somewhere in
	// the PDF's real text, which is a strictly stronger signal than the
	// embedding-similarity grounding this replaced (semantically similar
	// isn't the same as actually present) -- one that failed to resolve is
	// flagged in the rendered link (see the "find" branch below and
	// style.css's .llm-find-link-unverified) rather than silently treated
	// as equally trustworthy.
	_renderMarkdown(text, linkIndex, citationPositions) {
		if (typeof marked === "undefined") return null;
		let processed = text.replace(
			// Alternation, tried in order at each position:
			//  1. $$...$$ (block math) / $...$ (inline math, same pattern as
			//     the blockMath/inlineMath marked extensions in
			//     _configureMarkdown -- kept in sync with those so this
			//     agrees with marked about what actually IS a math span) --
			//     matched here ONLY so the callback below can return it
			//     untouched, not to do anything to it.
			//  2. [label](<find|ref:...>) -- the link token to substitute.
			// Math spans are found first and left alone because substituting
			// a link token into raw <a class="..." data-position="...">
			// HTML -- as the ref:/find: branch below does -- and then
			// feeding THAT to KaTeX as literal LaTeX source (which is what
			// happens to any text inside $...$/$$...$$) breaks
			// katex.renderToString: _escapeAttr HTML-entity-escapes the
			// position JSON's quotes to "&quot;", and "&" is itself
			// LaTeX-reserved (e.g. a column separator inside an
			// array/tabular environment), so a link substituted into a
			// formula corrupts it -- this is exactly what happened before
			// the system prompt was changed to have the model format tables
			// as plain Markdown (which supports links in cells natively,
			// see .llm-markdown table in style.css) rather than a KaTeX
			// $$\begin{array}...\end{array}$$ block; this stays in place as
			// a defensive fallback for any standalone $...$/$$...$$ formula
			// that still ends up with a link token inside it (e.g. if a
			// model ignores that instruction). Leaving the raw
			// "[label](<ref:...>)" token unsubstituted inside math is
			// harmless: none of those characters are LaTeX-reserved, so
			// KaTeX just renders them as literal (if ugly) text -- exactly
			// what happens when the same markdown is pasted into Obsidian,
			// which never performs this substitution in the first place.
			//
			// The find: lazy match, up to the literal ">)" close rather than
			// any bare ">" -- a "find" payload can be a citation phrase
			// grounded to a verbatim PDF sentence (see llm-citation.js's
			// groundCitations), which can itself contain a literal ">" (e.g.
			// "values >20"). With a bare-">" terminator, that truncates the
			// match early and the whole token fails to match at all (regex
			// backtracking can't recover -- [^>]+ can never include the very
			// ">" it needs to stop before), leaving raw "[label](<find:...>)"
			// text in the output. marked's own inline-HTML tokenizer then
			// treats the leftover "<find:...>" as an attempted (invalid,
			// colon-containing) tag, which is what actually threw
			// "innerHTML: An invalid or illegal string was specified" on
			// longer replies (more grounded citations = more chances of
			// grounding to a PDF sentence with a stray ">" in it).
			/\$\$[\s\S]+?\$\$|\$(?!\s)[^$\n]*?[^\s$]\$(?!\d)|\[([^\]]+)\]\(<(find|ref):([\s\S]+?)>\)/g,
			(whole, label, kind, payload) => {
				if (label === undefined) return whole; // matched a math span -- leave untouched
				if (kind === "find") {
					let escaped = this._escapeAttr(payload);
					// citationPositions.has(payload) but its value is null ==
					// resolution was ATTEMPTED and found nothing verbatim in
					// the PDF's own text -- distinct from key absent
					// entirely (no PDF context / prefetch didn't run), which
					// isn't a verification failure, just means we never
					// checked.
					if (citationPositions?.has(payload)) {
						let position = citationPositions.get(payload);
						if (position) {
							let posAttr = this._escapeAttr(JSON.stringify(position));
							return `<a class="llm-find-link" data-position="${posAttr}" data-query="${escaped}" title="${escaped}">${label}</a>`;
						}
						let title = this._escapeAttr(`Could not verify this citation against the PDF text: "${payload}"`);
						return `<a class="llm-find-link llm-find-link-unverified" data-query="${escaped}" title="${title}">${label}</a>`;
					}
					return `<a class="llm-find-link" data-query="${escaped}" title="${escaped}">${label}</a>`;
				}
				let [refType, refNum] = payload.split(":");
				if (refType === "page") {
					let pageNum = parseInt(refNum, 10);
					if (!pageNum) return label;
					return `<a class="llm-find-link" data-page-num="${pageNum}" title="Page ${pageNum}">${label}</a>`;
				}
				// Every other ref: kind keys its linkIndex map by a numeric
				// paper-native number EXCEPT note, which keys by the
				// annotation's actual (string) Zotero item key -- see
				// LLMPrompt.buildLinkIndex.
				let key = refType === "note" ? refNum : parseInt(refNum, 10);
				let entry = linkIndex?.[refType]?.get(key);
				// Fallback for table/figure links specifically: a model that
				// gets the ref: token itself wrong (wrong type, e.g.
				// ref:figure:F.8 instead of ref:figureExtra:1, or an
				// outright invented number) has still almost always copied
				// the VISIBLE label correctly, since that's just verbatim
				// caption text -- resolve by that instead of leaving the
				// link silently dead. See LLMPrompt.buildLinkIndex's byLabel
				// for why this is safe/sufficient across both numbering
				// schemes (table/tableExtra, figure/figureExtra).
				if (!entry && (refType === "table" || refType === "tableExtra" || refType === "figure" || refType === "figureExtra")) {
					entry = linkIndex?.byLabel?.get(label.toLowerCase());
				}
				if (!entry) return label;
				// The rendered link text always stays short -- for a
				// reference mention specifically, just "[12]" (the model
				// emits the bare number as its markdown label, e.g.
				// "[12](<ref:reference:12>)", and plain markdown rendering
				// would otherwise drop the brackets entirely since they're
				// consumed as link syntax; re-add them here so it still
				// reads like an in-text citation). Tables/figures/notes keep
				// their own already-descriptive label (e.g. "Table 1") as-is.
				// entry.label (the full citation text, when present) is used
				// only for the hover tooltip, never inline -- a full
				// bibliography entry inline would clutter the response.
				let visibleLabel = refType === "reference" ? `[${label}]` : label;
				let tooltipText = entry.label || entry.caption || label;
				// annotationKey (notes only) beats position -- navigate({ annotationID })
				// selects+scrolls to the annotation itself, matching a manual click in
				// the reader, rather than just scrolling to a coordinate region.
				if (entry.annotationKey) {
					let keyAttr = this._escapeAttr(entry.annotationKey);
					return `<a class="llm-find-link" data-annotation-key="${keyAttr}" title="${this._escapeAttr(tooltipText)}">${visibleLabel}</a>`;
				}
				if (entry.position) {
					let posJson = this._escapeAttr(JSON.stringify(entry.position));
					return `<a class="llm-find-link" data-position="${posJson}" title="${this._escapeAttr(tooltipText)}">${visibleLabel}</a>`;
				}
				let escapedCaption = this._escapeAttr(entry.caption || tooltipText);
				return `<a class="llm-find-link" data-query="${escapedCaption}" title="${this._escapeAttr(tooltipText)}">${visibleLabel}</a>`;
			}
		);
		let html = marked.parse(processed);
		// Zotero's item pane is an XHTML (XML) document, so innerHTML parsing
		// there requires XML-well-formed markup -- unlike a plain HTML
		// document, where innerHTML parsing is lenient. marked emits
		// HTML5-style void elements with no self-closing slash (bare "<br>",
		// "<hr>", etc.), which is valid HTML5 but NOT valid XML (XML requires
		// every element to be explicitly closed, e.g. "<br/>"). A bare "<br>"
		// from a markdown hard line break (trailing "  \n") was exactly what
		// caused "innerHTML: An invalid or illegal string was specified" --
		// confirmed via the browser console showing the underlying "XML
		// Parsing Error: mismatched tag. Expected: </br>." error that
		// precedes it. Self-close every void element here so the string is
		// XML-safe before it ever reaches innerHTML.
		html = html.replace(
			/<(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)((?:\s+[^<>]*)?)\s*\/?>/gi,
			(_, tag, attrs) => `<${tag}${attrs}/>`
		);
		return html;
	},

	// Global CTRL+I/CMD+I shortcut (both accepted on every platform, see
	// ui/keyboard-shortcuts.js's own comment): opens/focuses the chat pane
	// from anywhere in the main window, whether or not it's currently
	// visible -- attached per-window (via onMainWindowLoad/addToAllWindows in
	// bootstrap.js, the standard plugin pattern for main-window-scoped
	// behavior, e.g. plugins/make-it-red) rather than globally, since each
	// Zotero main window has its own document/keydown stream.
	addToWindow(win) {
		if (this._keydownHandlers.has(win)) return;

		// Zotero's plugin loader (xpcom/plugins.js's registerLocales)
		// automatically discovers and registers this plugin's
		// locale/en-US/llm-chat-pane.ftl as an AVAILABLE Fluent source (under
		// the "zotero-plugins" L10nRegistry source) as soon as the plugin
		// starts -- but that alone doesn't make its messages resolvable.
		// Each *document* that wants to use data-l10n-id="llm-chat-pane-..."
		// (here, the section header set via registerItemPane's header.l10nID,
		// which Zotero applies to a <collapsible-section> in the main
		// window's own document) needs to separately opt in via
		// addResourceIds(), the same way Zotero.ftl -- a *plain*
		// Localization, not tied to any one document -- lists its own
		// built-in files in xpcom/intl.js. Without this, the header's
		// data-l10n-id never resolves to anything, so the section renders
		// with no title at all (blank, not an error) -- this was the actual
		// cause, not the .ftl file's own message syntax.
		win.document.l10n?.addResourceIds(["llm-chat-pane.ftl"]);

		let handler = (event) => {
			// Both accepted on every platform (not just the OS-conventional
			// one) -- see ui/keyboard-shortcuts.js's own comment for why.
			let accel = event.metaKey || event.ctrlKey;
			if (accel && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "i") {
				event.preventDefault();
				event.stopPropagation();
				this.openChatPane(win);
			}
		};
		win.document.addEventListener("keydown", handler, true);
		this._keydownHandlers.set(win, handler);
	},

	removeFromWindow(win) {
		let handler = this._keydownHandlers.get(win);
		if (handler) {
			win.document.removeEventListener("keydown", handler, true);
			this._keydownHandlers.delete(win);
		}
	},

	addToAllWindows() {
		for (let win of Zotero.getMainWindows()) {
			if (!win.ZoteroPane) continue;
			this.addToWindow(win);
		}
	},

	removeFromAllWindows() {
		for (let win of Zotero.getMainWindows()) {
			if (!win.ZoteroPane) continue;
			this.removeFromWindow(win);
		}
	},

	// Expands both the overall item/context pane and this section's own
	// collapsible twisty (either may independently be collapsed) and
	// focuses the chat input. Works uniformly for the library tab's item
	// pane and a reader tab's context pane -- two separate DOM subtrees,
	// each with its own <item-pane-sidenav>, but ZoteroContextPane.sidenav
	// always resolves to whichever one is current for the active tab
	// (chrome/content/zotero/contextPane.js). Deliberately does NOT call
	// container.scrollToPane() -- that's <item-pane-sidenav>'s own
	// click-handler behavior (chrome/content/zotero/elements/itemPaneSidenav.js),
	// but it repositions the ENTIRE item-pane scroll container so the target
	// section sits at the very top, shoving every section above it (info,
	// abstract, attachments, etc.) out of view -- a jarring jump for a
	// keyboard shortcut whose only job is "get me to the input box".
	// Focusing the textarea directly is enough: focusing an off-screen
	// element already scrolls it into view natively, just far more gently
	// (only as far as needed, not always to the top).
	async openChatPane(win) {
		let { ZoteroContextPane, ZoteroPane, Zotero_Tabs } = win;
		let sidenav = ZoteroContextPane?.sidenav;
		let container = sidenav?.container;
		if (!container) return;

		if (Zotero_Tabs.selectedType === "library") {
			ZoteroPane.itemPane.collapsed = false;
		}
		else {
			ZoteroContextPane.collapsed = false;
		}

		let pane = container.getPane(this.paneID);
		if (pane) {
			pane.open = true;
			pane.querySelector(".llm-input")?.focus();
		}
	},

	registerItemPane() {
		if (this.paneID) return;
		// icons/robot_2_pane.svg -- NOT the same file as the plain
		// icons/robot_2_24dp_*.svg used elsewhere (buttons, via iconURL()
		// in onRender below). Material Symbols glyphs are exported
		// "full-bleed" (the glyph fills essentially the whole 24x24 box),
		// which reads fine at button size but got clipped at the corners
		// in the item-pane header/sidenav's own icon slot (native Zotero
		// chrome, not something this plugin's CSS can reach). This file is
		// the exact same glyph with a padded viewBox (30% larger canvas,
		// glyph unchanged) so it renders with breathing room instead.
		this.paneID = Zotero.ItemPaneManager.registerSection({
			paneID: "llm-chat-pane",
			pluginID: this.id,
			header: {
				l10nID: "llm-chat-pane-header",
				icon: this.rootURI + "icons/robot_2_pane.svg",
			},
			sidenav: {
				l10nID: "llm-chat-pane-sidenav",
				icon: this.rootURI + "icons/robot_2_pane.svg",
				orderable: true,
			},
			onItemChange: ({ item, setEnabled }) => {
				this._currentPaneItem = item;
				setEnabled(!!item);
			},
			onRender: ({ doc, body }) => {
				body.replaceChildren();
				let style = doc.createElement("style");
				style.textContent = this._css || "";
				body.appendChild(style);
				let section = body.closest("item-pane-custom-section");
				let scrollContainer = body.closest(".zotero-view-item");
				// height calculation happens after appendChild below
				body.classList.add("llm-body");

				let container = doc.createElement("div");
				container.className = "llm-container";

				let inputLabel = doc.createElement("div");
				inputLabel.className = "llm-section-label";
				inputLabel.textContent = "Prompt";

				let input = doc.createElement("textarea");
				input.placeholder = "Type here...";
				input.className = "llm-input";

				// Every icons/*.svg file follows the same Material Symbols
				// export naming pattern -- this just saves repeating that
				// suffix at every one of the many call sites below.
				let iconURL = (name) => this.rootURI + `icons/${name}_24dp_E3E3E3_FILL0_wght400_GRAD0_opsz24.svg`;

				let imagePaste = LLMUIImagePaste.create(doc, input, (text) => appendMessage("System", text), iconURL("remove_selection"));

				// Header for the provider/model select + Providers/Keyboard
				// Shortcuts/Advanced/Logs grouping below -- all
				// configuration, as opposed to the Conversation grouping
				// (Conversation header onward) below it.
				let settingsLabel = doc.createElement("div");
				settingsLabel.className = "llm-section-label";
				settingsLabel.textContent = "Settings";

				let providerModelSelect = LLMUIProviderModelSelect.create(doc, {
					refreshIconURL: iconURL("refresh"),
					// Keeps LLMPrompt's per-(provider,model) advanced settings
					// (Max PDF context, Max selected figures, etc. -- see
					// llm-prompt.js's own comment) in sync with the CHAT
					// provider/model pair specifically -- fires on every
					// actual pair change, including the auto-select that
					// happens when switching provider, not just an explicit
					// model pick. `advanced` is assigned further down, but
					// this closure only ever runs later (async, after at
					// least one model-list fetch resolves), well after this
					// whole render function has finished running -- see
					// ui/provider-model-select.js's own comment on onChange.
					onChange: (provider, model) => {
						LLMPrompt.applyAdvancedSettingsFor(provider, model);
						advanced.refreshPairSettings();
					},
				});

				let providers = LLMUIProviders.create(doc, (label, message) => {
					appendMessage("System", `Failed to save ${label} API key: ${message}`);
				});

				let keyboardShortcuts = LLMUIKeyboardShortcuts.create(doc);

				let advanced = LLMUIAdvanced.create(doc, {
					getActiveItem: () => this.getActiveReaderAttachment(),
					onMessage: (text) => appendMessage("System", text),
					clearCacheIconURL: iconURL("delete_forever"),
					refreshIconURL: iconURL("refresh"),
				});

				// System messages (extraction/selection status, errors, etc.) render
				// here instead of the main message list -- see appendMessage/
				// appendRichMessage below, which route "System"-labeled content to
				// logs.appendMessage/appendRichMessage (ui/logs.js) rather than
				// chat.appendMessage (ui/chat.js). Keeps the user/assistant
				// conversation readable without dozens of "Table extraction: ..."/
				// "Including N notes as context..." lines interleaved into it, while
				// still keeping that information available (and clickable, where
				// applicable) for debugging.
				let logs = LLMUILogs.create(doc);

				let chat = LLMUIChat.create(doc);

				// Replaces whatever's currently shown with `transcript` --
				// shared by both onImport (a file-picker-selected file) and
				// onLoadConversation (a Conversation History card's Load
				// button), since both need the exact same rebuild. Non-"You"
				// messages are re-rendered as markdown (not just dumped as
				// plain text) using the SAME link-resolution data a live
				// request would build -- table/figure/reference/equation
				// links key off each item's own stable paper-native number,
				// and note links key off the annotation's own stable Zotero
				// item key (see LLMPrompt.buildLinkIndex/_formatNoteContext),
				// so as long as the active PDF's cached extraction indexes
				// (and, for notes, its still-existing annotations) are the
				// same ones the export came from, ALL of these resolve
				// identically to a live reply -- there's no historical/live
				// distinction left. A note link only fails to resolve if
				// that specific annotation has since been deleted, in which
				// case it falls back to plain unlinked text via
				// _renderMarkdown's own handling of an unresolvable
				// linkIndex entry.
				let loadTranscriptIntoChat = async (transcript, pdfItem, logLabel) => {
					chat.clear();

					let linkIndex = {};
					if (pdfItem) {
						try {
							let [tableIndex, figureIndex, referenceIndex, equationIndex, notes] = await Promise.all([
								LLMTables.getTableIndex(pdfItem).catch(() => null),
								LLMFigures.getFigureIndex(pdfItem).catch(() => null),
								LLMReferences.getReferenceIndex(pdfItem).catch(() => null),
								LLMEquations.getEquationIndex(pdfItem).catch(() => null),
								// ALL current annotations, not just some
								// message's selected subset -- there's no way
								// to know which ones the original (historical)
								// request actually selected, but since note
								// links now key off the annotation's own
								// stable key rather than a per-message ordinal,
								// any of them can resolve a match.
								LLMNotes.getNotes(pdfItem).catch(() => []),
							]);
							linkIndex = LLMPrompt.buildLinkIndex({ tableIndex, figureIndex, referenceIndex, equationIndex, notes });
						}
						catch (e) {
							this.log(`Failed to build link index for ${logLabel}: ${e.message}`);
						}
					}

					for (let { role, time, text } of transcript) {
						// Preserves the original timestamp from the file --
						// `time` comes back "" for files exported before
						// timestamps were added (see LLMImport.parseConversation),
						// in which case chat.appendMessage's own default
						// (the current time) kicks in instead.
						let content = chat.appendMessage(role, text, time || undefined);
						if (role === "You") continue;
						let html = this._renderMarkdown(text, linkIndex);
						if (html) chat.renderMarkdownMessage(content, html, text);
					}
				};

				// Imports a conversation previously written by Export
				// (picked via a native file dialog), replacing whatever's
				// currently shown.
				let onImport = async () => {
					let pdfItem = this.getActiveReaderAttachment();
					let transcript = await LLMImport.importConversation(pdfItem);
					if (transcript === null) return; // cancelled
					if (!transcript.length) {
						appendMessage("System", "Import: no messages found in that file.");
						return;
					}
					await loadTranscriptIntoChat(transcript, pdfItem, "import");
					appendMessage("System", `Imported ${transcript.length} message${transcript.length === 1 ? "" : "s"}.`);
				};

				// Loads a specific conversation from the Conversation
				// History panel's Load button, replacing whatever's
				// currently shown -- same rebuild as onImport, just reading
				// `conv.path` directly instead of going through a file
				// picker.
				let onLoadConversation = async (conv) => {
					let pdfItem = this.getActiveReaderAttachment();
					let markdown = await IOUtils.readUTF8(conv.path);
					let transcript = LLMImport.parseConversation(markdown);
					if (!transcript.length) {
						appendMessage("System", `Load: no messages found in ${conv.filename}.`);
						return;
					}
					await loadTranscriptIntoChat(transcript, pdfItem, "conversation history load");
					appendMessage("System", `Loaded ${transcript.length} message${transcript.length === 1 ? "" : "s"} from ${conv.filename}.`);
				};

				let conversationHistory = LLMUIConversationHistory.create(doc, {
					onLoad: (conv) => onLoadConversation(conv).catch(e => appendMessage("System", `Load failed: ${e.message}`)),
					editIconURL: iconURL("edit"),
					doneIconURL: iconURL("done_outline"),
					loadIconURL: iconURL("upload"),
					deleteIconURL: iconURL("delete"),
				});

				// Reloads the card list from whatever's actually on disk for
				// the active PDF right now -- there's no separate persisted
				// index to keep in sync (see conversation-history.js), so a
				// "refresh" is just "re-read the folder". Called once below
				// (initial population) and again after every successful
				// Export (see onExported), which is the only action that
				// changes what's on disk from within this pane. Deleting a
				// card (see ui/past-conversations.js) doesn't need this --
				// it just removes its own DOM node directly.
				let refreshConversationHistory = async () => {
					let pdfItem = this.getActiveReaderAttachment();
					if (!pdfItem) {
						conversationHistory.render([]);
						return;
					}
					try {
						let conversations = await LLMConversationHistory.listConversations(pdfItem);
						conversationHistory.render(conversations);
					}
					catch (e) {
						this.log(`Failed to load conversation history: ${e.message}`);
						conversationHistory.render([]);
					}
				};
				refreshConversationHistory();

				let { element: buttonRow, messagesRow, submitButton, stopButton } = LLMUIButtonRow.create(doc, {
					getActiveItem: () => this.getActiveReaderAttachment(),
					onMessage: (text) => appendMessage("System", text),
					discardImagesButton: imagePaste.discardButton,
					getTranscript: () => chat.exportTranscript(),
					onImport: () => onImport().catch(e => appendMessage("System", `Import failed: ${e.message}`)),
					onExported: () => refreshConversationHistory(),
					onClearConversation: () => chat.clear(),
					sendIconURL: iconURL("send"),
					cancelIconURL: iconURL("cancel"),
					uploadIconURL: iconURL("upload"),
					fileExportIconURL: iconURL("file_export"),
					clearAllIconURL: iconURL("clear_all"),
				});

				// Stashed on input focus as a fallback for LLMRequest.send's
				// takeCapturedSelection() -- focusing the prompt textarea can
				// itself clear the reader's live text selection, so by the time
				// a request actually runs, getReaderSelection() may come back
				// empty even though the user had text selected moments ago.
				let capturedSelection = null;
				input.addEventListener("focus", () => {
					let { text } = this.getReaderSelection();
					if (text) capturedSelection = text;
				});

				// Holds the in-flight LLMRequest.send() handle (or null between
				// requests), so Stop can cancel whatever's currently running --
				// see submitButton's click listener below, which assigns this,
				// and LLMRequest.send's own doc comment for what cancel() does
				// (works during EVERY phase of a request, not just once the
				// model is already streaming a reply).
				let currentRequest = null;
				stopButton.addEventListener("click", () => {
					currentRequest?.cancel();
				});

				// History of messages previously submitted from THIS input,
				// scoped to whichever paper was active when this section was
				// rendered (see _paperHistoryKey) -- navigated with CMD+DOWN
				// (back to an older message) / CMD+UP (forward toward the
				// most recent one, then back to whatever was being typed
				// before navigating). `historyIndex === history.length`
				// means "not currently navigating" -- viewing the live
				// draft; stepping back for the first time stashes that draft
				// in `historyDraft` so stepping all the way forward again
				// restores it, rather than just leaving the last history
				// entry sitting there.
				let history = this._getMessageHistory(this._paperHistoryKey());
				let historyIndex = history.length;
				let historyDraft = "";

				input.addEventListener("keydown", (e) => {
					// Both accepted on every platform, not just the OS-conventional
					// one (CMD on Mac, CTRL elsewhere) -- see
					// ui/keyboard-shortcuts.js's own comment for why.
					if (!e.metaKey && !e.ctrlKey) return;
					if (e.code === "Enter" && e.shiftKey) {
						e.preventDefault();
						if (!submitButton.disabled) submitButton.click();
					}
					else if (e.code === "Backspace" && e.shiftKey) {
						e.preventDefault();
						if (!stopButton.disabled) stopButton.click();
					}
					// CMD+SHIFT+Down/Up jump straight to the oldest/newest ends
					// of history, rather than stepping one message at a time
					// like plain CMD+Down/Up (below) -- same "stash the live
					// draft on the way out" behavior as a single step, so
					// navigating all the way back to the present afterward
					// still restores it.
					else if (e.code === "ArrowDown" && e.shiftKey) {
						e.preventDefault();
						if (!history.length) return;
						if (historyIndex === history.length) historyDraft = input.value;
						historyIndex = 0;
						input.value = history[0];
					}
					else if (e.code === "ArrowUp" && e.shiftKey) {
						e.preventDefault();
						if (!history.length) return;
						if (historyIndex === history.length) historyDraft = input.value;
						historyIndex = history.length - 1;
						input.value = history[historyIndex];
					}
					else if (e.code === "ArrowDown") {
						e.preventDefault();
						if (historyIndex <= 0) return;
						if (historyIndex === history.length) historyDraft = input.value;
						historyIndex--;
						input.value = history[historyIndex];
					}
					else if (e.code === "ArrowUp") {
						e.preventDefault();
						if (historyIndex >= history.length) return;
						historyIndex++;
						input.value = historyIndex === history.length ? historyDraft : history[historyIndex];
					}
				});

				let controls = doc.createElement("div");
				controls.className = "llm-controls";

				// Dispatches to whichever UI module actually owns rendering for
				// this role -- "System" goes to the Logs panel (ui/logs.js),
				// everything else ("You" or a provider/feature label like
				// "Zotero") goes to the conversation message list (ui/chat.js).
				let appendMessage = (role, text) => {
					if (role === "System") return logs.appendMessage(text);
					return chat.appendMessage(role, text);
				};
				let appendRichMessage = (role, parts) => {
					if (role === "System") return logs.appendRichMessage(parts);
					return chat.appendRichMessage(role, parts);
				};

				// Makes a system message clickable to jump to the figure/table it
				// refers to: precise region navigation via its stored `position`
				// (native PDF-space rects, computed at extraction time) when
				// available, falling back to caption text-search otherwise (e.g.
				// for tables found via rotation-normalization, where a real-page
				// position can't be reliably computed). Only ever used on logged
				// (System) messages, so this wraps logs.makeClickable rather than
				// living in ui/logs.js itself -- the annotationKey/position/
				// caption navigation preference below is LLMCitation-specific
				// business logic, not something the Logs UI module needs to know
				// about.
				let makeMessageClickable = (messageEl, item) => {
					logs.makeClickable(messageEl, () => {
						// annotationKey (notes only) beats position -- selects+scrolls to
						// the annotation itself, matching a manual click in the reader,
						// same reasoning as _renderMarkdown's ref:note:KEY handling.
						if (item.annotationKey) {
							LLMCitation.navigateToAnnotation(item.annotationKey);
						}
						else if (item.position) {
							LLMCitation.navigateToPosition(item.position);
						}
						else {
							LLMCitation.navigateToText(item.caption);
						}
					});
				};

				submitButton.addEventListener("click", async () => {
					let prompt = input.value.trim();
					if (!prompt) {
						appendMessage("System", "Enter a prompt first.");
						return;
					}

					// Recorded regardless of which flow the message triggers
					// (download-reference lookup or normal chat) -- anything
					// submitted from this field counts as "a message" for
					// history purposes. Skips a duplicate of the immediately
					// preceding entry (e.g. re-sending the same message
					// twice in a row) rather than cluttering history with an
					// identical adjacent one.
					if (history[history.length - 1] !== prompt) {
						history.push(prompt);
					}
					historyIndex = history.length;
					historyDraft = "";

					submitButton.disabled = true;
					// Enabled immediately, rather than only once actual model
					// token-streaming begins (the old behavior) -- Stop now
					// needs to work during every phase of a request, not just
					// the last one. See the cancellation-mechanism comment
					// above stopButton's click listener.
					stopButton.disabled = false;

					// See request.js for the actual request flow (download-
					// reference lookup or normal chat, through to the rendered
					// reply) -- everything below is just: kick it off, wait for
					// it, report how it ended, and reset button state.
					currentRequest = LLMRequest.send(this, prompt, {
						doc,
						appendMessage,
						appendRichMessage,
						makeMessageClickable,
						chat,
						imagePaste,
						takeCapturedSelection: () => {
							let text = capturedSelection;
							capturedSelection = null;
							return text;
						},
					});

					try {
						await currentRequest.promise;
					}
					catch (e) {
						if (currentRequest.cancelled) {
							appendMessage("System", "Cancelled.");
						}
						else {
							appendMessage("System", `Error: ${e.message}`);
							this.log(`Submit failed: ${e.message}`);
						}
					}
					finally {
						submitButton.disabled = false;
						stopButton.disabled = true;
						currentRequest = null;
					}
				});

				// Prompt (label, textarea, pasted-image row, Submit/Stop row)
				// grouped into its own wrapper -- see style.css's
				// .llm-prompt-section, which replicates controls' own gap so
				// spacing within the group is unaffected by the wrapping.
				// Messages' label and its Clear/Export/Import row are NOT
				// grouped together the same way -- the label sits above
				// History (as the header for the whole History+row+list
				// area) while the row itself stays right above the message
				// list, so they end up on opposite sides of
				// conversationHistory.element below. chat.list (the actual
				// scrollable message area) stays outside controls entirely,
				// appended directly to container below -- its height is
				// computed from controls.offsetHeight (see the
				// section-height calculation right after), which needs to
				// cover everything EXCEPT the scrollable area itself.
				// logs.element sits below the "Prompt" header and above the
				// textarea itself, inside promptSection -- not in the
				// Settings group above.
				let promptSection = doc.createElement("div");
				promptSection.className = "llm-prompt-section";
				promptSection.append(inputLabel, logs.element, input, imagePaste.row, buttonRow);

				// Plain <hr>s (see style.css's .llm-section-divider) between
				// Settings/Prompt/History -- a bit more visual separation
				// than the gap alone gives between these groupings. No
				// divider between History and Messages' row, or between
				// that row and chat.list -- those boundaries read fine from
				// the gap alone.
				let settingsDivider = doc.createElement("hr");
				settingsDivider.className = "llm-section-divider";
				let promptDivider = doc.createElement("hr");
				promptDivider.className = "llm-section-divider";

				// Settings group, divider, Prompt section (header, Logs,
				// textarea, pasted-image row, button row), divider,
				// Messages label, History, Messages row -- a contiguous run
				// within controls, in that order.
				controls.append(
					settingsLabel,
					providerModelSelect.element,
					providers.element,
					keyboardShortcuts.element,
					advanced.element,
					settingsDivider,
					promptSection,
					promptDivider,
					chat.label,
					conversationHistory.element,
					messagesRow
				);
				container.append(controls, chat.list);
				body.appendChild(container);

				if (section && scrollContainer) {
					let scrollRect = scrollContainer.getBoundingClientRect();
					let sectionRect = section.getBoundingClientRect();
					let sectionOffsetFromTop = Math.max(0, sectionRect.top - scrollRect.top);
					let availForSection = scrollContainer.clientHeight - sectionOffsetFromTop;
					let overhead = 32; // 8px top padding + 16px bottom padding + 8px gap
					let listH = Math.max(80, availForSection - controls.offsetHeight - overhead);
					chat.list.style.height = listH + "px";
					section.style.minHeight = (controls.offsetHeight + listH + overhead) + "px";
				}
			},
		});
	},

	shutdown() {
		this.removeFromAllWindows();
		if (this.paneID) {
			Zotero.ItemPaneManager.unregisterSection(this.paneID);
			this.paneID = null;
		}
	},
};
