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
		this.registerItemPane();
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
	//   [label](<ref:figure:N>) /
	//   [label](<ref:equation:N>) /
	//   [label](<ref:note:N>)      -- table/figure/equation/note mention: looked
	//                                  up in linkIndex for precise navigation --
	//                                  by annotation key (select + scroll, notes
	//                                  only) if present, else by position,
	//                                  else falling back to a caption
	//                                  text-search (e.g. rotated tables)
	//   [label](<ref:page:N>)      -- bare page-number mention: scrolls directly
	//                                  to page N, no linkIndex lookup needed --
	//                                  unlike the others, this isn't tied to a
	//                                  specific extracted item, just the page
	//                                  itself
	// Done before marked parses, so spaces/special chars in the query don't
	// break markdown link parsing.
	_renderMarkdown(text, linkIndex) {
		if (typeof marked === "undefined") return null;
		let processed = text.replace(
			// Lazy match up to the literal ">)" close, not just any bare ">"
			// -- a "find" payload can be a citation phrase grounded to a
			// verbatim PDF sentence (see llm-citation.js's groundCitations),
			// which can itself contain a literal ">" (e.g. "values >20").
			// With a bare-">" terminator, that truncates the match early and
			// the whole token fails to match at all (regex backtracking
			// can't recover -- [^>]+ can never include the very ">" it
			// needs to stop before), leaving raw "[label](<find:...>)" text
			// in the output. marked's own inline-HTML tokenizer then treats
			// the leftover "<find:...>" as an attempted (invalid,
			// colon-containing) tag, which is what actually threw
			// "innerHTML: An invalid or illegal string was specified" on
			// longer replies (more grounded citations = more chances of
			// grounding to a PDF sentence with a stray ">" in it).
			/\[([^\]]+)\]\(<(find|ref):([\s\S]+?)>\)/g,
			(_, label, kind, payload) => {
				if (kind === "find") {
					let escaped = this._escapeAttr(payload);
					return `<a class="llm-find-link" data-query="${escaped}" title="${escaped}">${label}</a>`;
				}
				let [refType, refNum] = payload.split(":");
				if (refType === "page") {
					let pageNum = parseInt(refNum, 10);
					if (!pageNum) return label;
					return `<a class="llm-find-link" data-page-num="${pageNum}" title="Page ${pageNum}">${label}</a>`;
				}
				let entry = linkIndex?.[refType]?.get(parseInt(refNum, 10));
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

	// Global CMD+I (Ctrl+I elsewhere) shortcut: opens/focuses the chat pane
	// from anywhere in the main window, whether or not it's currently
	// visible -- attached per-window (via onMainWindowLoad/addToAllWindows in
	// bootstrap.js, the standard plugin pattern for main-window-scoped
	// behavior, e.g. plugins/make-it-red) rather than globally, since each
	// Zotero main window has its own document/keydown stream.
	addToWindow(win) {
		if (this._keydownHandlers.has(win)) return;
		let handler = (event) => {
			let accel = Zotero.isMac ? event.metaKey : event.ctrlKey;
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
		this.paneID = Zotero.ItemPaneManager.registerSection({
			paneID: "llm-chat-pane",
			pluginID: this.id,
			header: {
				l10nID: "llm-chat-pane-header",
				icon: "chrome://zotero/skin/16/universal/note.svg",
			},
			sidenav: {
				l10nID: "llm-chat-pane-sidenav",
				icon: "chrome://zotero/skin/20/universal/note.svg",
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

				let imagePaste = LLMUIImagePaste.create(doc, input, (text) => appendMessage("System", text));

				let providerModelSelect = LLMUIProviderModelSelect.create(doc);

				let apiKeys = LLMUIApiKeys.create(doc, (label, message) => {
					appendMessage("System", `Failed to save ${label} API key: ${message}`);
				});

				let keyboardShortcuts = LLMUIKeyboardShortcuts.create(doc);

				let advanced = LLMUIAdvanced.create(doc);

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

				let { element: buttonRow, submitButton, stopButton } = LLMUIButtonRow.create(doc, {
					getActiveItem: () => this.getActiveReaderAttachment(),
					onMessage: (text) => appendMessage("System", text),
					discardImagesButton: imagePaste.discardButton,
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
					if (!e.metaKey) return;
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

				let chat = LLMUIChat.create(doc);

				let controls = doc.createElement("div");
				controls.className = "llm-controls";

				// Dispatches to whichever UI module actually owns rendering for
				// this role -- "System" goes to the Logs panel (ui/logs.js),
				// everything else ("You" or the model's provider label) goes to
				// the conversation message list (ui/chat.js).
				let appendMessage = (role, text) => {
					if (role === "System") return logs.appendMessage(text);
					return chat.appendMessage(role, text);
				};
				let appendRichMessage = (parts) => logs.appendRichMessage(parts);

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
						// same reasoning as _renderMarkdown's ref:note:N handling.
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

				controls.append(providerModelSelect.element, apiKeys.element, keyboardShortcuts.element, advanced.element, logs.element, inputLabel, input, imagePaste.row, buttonRow);
				container.append(controls, chat.label, chat.list);
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
