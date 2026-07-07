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
								return `<span>${token.text}</span>`;
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
								return `<span>${token.text}</span>`;
							}
						},
					},
				],
			});
		}
	},

	_escapeAttr(str) {
		return String(str).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
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
			/\[([^\]]+)\]\(<(find|ref):([^>]+)>\)/g,
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
		return marked.parse(processed);
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

				let submitButton = doc.createElement("button");
				submitButton.textContent = "Submit";
				submitButton.className = "llm-submit";
				submitButton.title = "Submit (⌘ ⇧ Return)";

				let stopButton = doc.createElement("button");
				stopButton.textContent = "Stop";
				stopButton.className = "llm-stop";
				stopButton.disabled = true;
				stopButton.title = "Stop (⌘ ⇧ ⌫)";

				// Images pasted (⌘V) into the input, attached as context for the
				// next request(s) -- capped at MAX_PASTED_IMAGES since providers'
				// per-request image limits, while generous, aren't unlimited, and
				// a runaway paste of a large batch would silently balloon request
				// size/cost. Not cleared on submit (matching the existing
				// behavior of the text input itself, which also isn't cleared)
				// -- images stay attached across turns until removed via the
				// thumbnail's "x", so a follow-up question about the same
				// image(s) doesn't require re-pasting.
				const MAX_PASTED_IMAGES = 10;
				// Each entry is { dataUri, fingerprint } -- fingerprint is a SHA-256
				// hash of the data URI, used to silently skip re-adding an image
				// that's already attached (e.g. pasting the same screenshot twice).
				let pastedImages = [];

				let fingerprintDataUri = async (dataUri) => {
					let digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(dataUri));
					return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
				};

				let imagesRow = doc.createElement("div");
				imagesRow.className = "llm-images-row";
				imagesRow.hidden = true;

				let discardImagesButton = doc.createElement("button");
				discardImagesButton.textContent = "Discard All";
				discardImagesButton.className = "llm-discard-images";
				discardImagesButton.disabled = true;
				discardImagesButton.title = "Remove all attached images";
				discardImagesButton.addEventListener("click", () => {
					pastedImages = [];
					renderPastedImages();
				});

				let renderPastedImages = () => {
					imagesRow.innerHTML = "";
					imagesRow.hidden = pastedImages.length === 0;
					discardImagesButton.disabled = pastedImages.length === 0;
					for (let [index, { dataUri }] of pastedImages.entries()) {
						let thumb = doc.createElement("div");
						thumb.className = "llm-image-thumb";
						let img = doc.createElement("img");
						img.src = dataUri;
						let removeButton = doc.createElement("span");
						removeButton.className = "llm-image-thumb-remove";
						removeButton.textContent = "×";
						removeButton.title = "Remove image";
						removeButton.addEventListener("click", () => {
							pastedImages.splice(index, 1);
							renderPastedImages();
						});
						thumb.append(img, removeButton);
						imagesRow.appendChild(thumb);
					}
				};

				input.addEventListener("paste", async (e) => {
					let items = e.clipboardData?.items;
					if (!items) return;
					let imageItems = Array.from(items).filter(item => item.kind === "file" && item.type.startsWith("image/"));
					if (!imageItems.length) return;
					// Only swallow the paste when it actually carries an image --
					// clipboard content that's just text should still paste normally.
					e.preventDefault();
					for (let item of imageItems) {
						if (pastedImages.length >= MAX_PASTED_IMAGES) {
							appendMessage("System", `You can attach up to ${MAX_PASTED_IMAGES} images at once.`);
							break;
						}
						let blob = item.getAsFile();
						if (!blob) continue;
						let dataUri = await new Promise((resolve, reject) => {
							let reader = new FileReader();
							reader.onload = () => resolve(reader.result);
							reader.onerror = () => reject(reader.error);
							reader.readAsDataURL(blob);
						});
						let fingerprint = await fingerprintDataUri(dataUri);
						if (pastedImages.some(img => img.fingerprint === fingerprint)) {
							appendMessage("System", "That image is already attached.");
							continue;
						}
						pastedImages.push({ dataUri, fingerprint });
						renderPastedImages();
					}
				});

				let providerSelect = doc.createElement("select");
				providerSelect.className = "llm-provider-select";
				providerSelect.title = "Model provider";
				let providerOptions = [
					{ value: "ollama", label: "Ollama" },
					{ value: "lmstudio", label: "LM Studio" },
					{ value: "litellm", label: "API (LiteLLM)" },
					{ value: "openai", label: "OpenAI" },
					{ value: "anthropic", label: "Anthropic" },
				];
				for (let { value, label } of providerOptions) {
					let option = doc.createElement("option");
					option.value = value;
					option.textContent = label;
					providerSelect.appendChild(option);
				}
				providerSelect.value = LLMInterfaces._provider;

				let modelSelect = doc.createElement("select");
				modelSelect.className = "llm-model-select";
				modelSelect.title = "Model";
				modelSelect.disabled = true;

				let modelRefreshButton = doc.createElement("button");
				modelRefreshButton.textContent = "⟳";
				modelRefreshButton.className = "llm-model-refresh";
				modelRefreshButton.title = "Refresh model list";

				let modelGroupLabels = {
					openai: "OpenAI",
					anthropic: "Anthropic",
					ollama: "Ollama",
					ollama_chat: "Ollama",
					gemini: "Gemini",
					vertex_ai: "Vertex AI",
					xai: "XAI",
					vllm: "VLLM",
					fireworks_ai: "Fireworks AI",
				};

				let addModelOption = (parent, name) => {
					let option = doc.createElement("option");
					option.value = name;
					option.textContent = name;
					parent.appendChild(option);
				};

				// Extracts the leading dotted/dashed version run (e.g. "5" from "gpt-5-pro",
				// [4, 5] from "claude-sonnet-4-5") as an array of numeric components, so models
				// sort newest-version-first without relying on provider metadata (which turned
				// out to be a fake placeholder, not real dates).
				let modelVersionParts = (name) => {
					let match = name.match(/\d+(?:[.-]\d+)*/);
					if (!match) return [];
					return match[0].split(/[.-]/).map(n => parseInt(n, 10));
				};
				let pathDepth = (name) => (name.match(/\//g) || []).length;
				let compareModelNames = (a, b) => {
					let depthDiff = pathDepth(a) - pathDepth(b); // ascending: shorter paths first
					if (depthDiff !== 0) return depthDiff;
					let va = modelVersionParts(a);
					let vb = modelVersionParts(b);
					let len = Math.max(va.length, vb.length);
					for (let i = 0; i < len; i++) {
						let diff = (vb[i] || 0) - (va[i] || 0); // descending: higher version first
						if (diff !== 0) return diff;
					}
					return a.localeCompare(b);
				};

				let populateModelOptions = (models) => {
					let groups = new Map();
					let ungrouped = [];
					for (let name of models) {
						let slash = name.indexOf("/");
						if (slash > 0) {
							let prefix = name.slice(0, slash);
							if (!groups.has(prefix)) groups.set(prefix, []);
							groups.get(prefix).push(name);
						}
						else {
							ungrouped.push(name);
						}
					}
					ungrouped.sort(compareModelNames);
					for (let name of ungrouped) addModelOption(modelSelect, name);
					for (let [prefix, names] of groups) {
						names.sort(compareModelNames);
						let optgroup = doc.createElement("optgroup");
						optgroup.label = modelGroupLabels[prefix] || (prefix.charAt(0).toUpperCase() + prefix.slice(1));
						for (let name of names) addModelOption(optgroup, name);
						modelSelect.appendChild(optgroup);
					}
				};

				let refreshModelOptions = async () => {
					let provider = LLMInterfaces._provider;
					modelSelect.disabled = true;
					modelSelect.replaceChildren();
					let loadingOption = doc.createElement("option");
					loadingOption.textContent = "Loading models…";
					modelSelect.appendChild(loadingOption);
					try {
						let models = await LLMInterfaces._withTimeout(LLMInterfaces.listModels(), 15000, "listModels");
						if (provider !== LLMInterfaces._provider) return; // provider changed while fetching
						modelSelect.replaceChildren();
						if (!models.length) {
							let emptyOption = doc.createElement("option");
							emptyOption.textContent = "No models found";
							modelSelect.appendChild(emptyOption);
							return;
						}
						populateModelOptions(models);
						let selected = LLMInterfaces._selectedModel[provider];
						modelSelect.value = models.includes(selected) ? selected : models[0];
						LLMInterfaces._selectedModel[provider] = modelSelect.value;
						modelSelect.disabled = false;
					}
					catch (e) {
						if (provider !== LLMInterfaces._provider) return;
						modelSelect.replaceChildren();
						let errorOption = doc.createElement("option");
						errorOption.textContent = "Unavailable";
						modelSelect.appendChild(errorOption);
						this.log(`Failed to list models for ${provider}: ${e.message}`);
					}
				};

				// API keys are always editable here regardless of which
				// provider is currently selected (unlike the old single
				// LiteLLM-only field, which only showed up once LiteLLM was
				// selected) -- letting the user pre-configure a provider
				// before switching to it. Persisted via
				// LLMInterfaces.setApiKey() (OS-keychain-encrypted, survives
				// restarts -- see llm-interfaces.js) rather than kept only
				// in memory, so they don't need to be re-entered every
				// session.
				let apiKeysDetails = doc.createElement("details");
				apiKeysDetails.className = "llm-api-keys-details";
				let apiKeysSummary = doc.createElement("summary");
				apiKeysSummary.textContent = "API Keys";
				let apiKeysBody = doc.createElement("div");
				apiKeysBody.className = "llm-api-keys-body";
				let apiKeyFields = [
					{ providerKey: "litellm", label: "LiteLLM" },
					{ providerKey: "openai", label: "OpenAI" },
					{ providerKey: "anthropic", label: "Anthropic" },
				];
				for (let { providerKey, label } of apiKeyFields) {
					let row = doc.createElement("label");
					row.className = "llm-api-key-row";
					let span = doc.createElement("span");
					span.textContent = label;
					let keyInput = doc.createElement("input");
					keyInput.type = "password";
					keyInput.className = "llm-api-key-input";
					keyInput.placeholder = "API key";
					keyInput.value = LLMInterfaces._apiKeys[providerKey];
					keyInput.addEventListener("change", async () => {
						try {
							await LLMInterfaces.setApiKey(providerKey, keyInput.value);
						}
						catch (e) {
							this.log(`Failed to save ${label} API key: ${e.message}`);
							appendMessage("System", `Failed to save ${label} API key: ${e.message}`);
						}
					});
					row.append(span, keyInput);
					apiKeysBody.appendChild(row);
				}
				apiKeysDetails.append(apiKeysSummary, apiKeysBody);

				providerSelect.addEventListener("change", () => {
					LLMInterfaces._provider = providerSelect.value;
					refreshModelOptions();
				});
				modelSelect.addEventListener("change", () => {
					LLMInterfaces._selectedModel[LLMInterfaces._provider] = modelSelect.value;
				});
				modelRefreshButton.addEventListener("click", () => refreshModelOptions());
				refreshModelOptions();

				let modelRow = doc.createElement("div");
				modelRow.className = "llm-model-row";
				modelRow.append(providerSelect, modelSelect, modelRefreshButton);

				let makeIntegerSetting = (labelText, get, set, { min = 1 } = {}) => {
					let row = doc.createElement("label");
					row.className = "llm-advanced-row";
					let span = doc.createElement("span");
					span.textContent = labelText;
					let input = doc.createElement("input");
					input.type = "number";
					input.min = String(min);
					input.step = "1";
					input.value = get();
					input.addEventListener("change", () => {
						let value = parseInt(input.value, 10);
						if (Number.isInteger(value) && value >= min) {
							set(value);
						}
						else {
							input.value = get();
						}
					});
					row.append(span, input);
					return row;
				};

				let shortcutsDetails = doc.createElement("details");
				shortcutsDetails.className = "llm-shortcuts-details";
				let shortcutsSummary = doc.createElement("summary");
				shortcutsSummary.textContent = "Keyboard Shortcuts";
				let shortcutsBody = doc.createElement("div");
				shortcutsBody.className = "llm-shortcuts-body";
				// Sorted by (keys.length, keys) -- shorter combos first, then
				// ascending lexicographically (by the shortcut itself, not
				// the description) within each length. Plain `<`/`>` rather
				// than localeCompare(), since locale-aware collation could
				// reorder these symbol characters unpredictably instead of
				// by simple code-point order.
				let shortcuts = [
					{ keys: "⌘ ⇧ ⏎", desc: "Submit" },
					{ keys: "⌘ ⇧ ⌫", desc: "Stop" },
					{ keys: "⌘ ↓", desc: "Older message" },
					{ keys: "⌘ ↑", desc: "Newer message" },
					{ keys: "⌘ ⇧ ↓", desc: "Oldest message" },
					{ keys: "⌘ ⇧ ↑", desc: "Newest message" },
					{ keys: "⌘ I", desc: "Toggle chat pane" },
				].sort((a, b) => a.keys.length - b.keys.length || (a.keys < b.keys ? -1 : a.keys > b.keys ? 1 : 0));
				for (let { keys, desc } of shortcuts) {
					let row = doc.createElement("div");
					row.className = "llm-shortcut-row";
					let badge = doc.createElement("span");
					badge.className = "llm-shortcut-badge";
					badge.textContent = keys;
					let label = doc.createElement("span");
					label.className = "llm-shortcut-desc";
					label.textContent = desc;
					row.append(badge, label);
					shortcutsBody.appendChild(row);
				}
				shortcutsDetails.append(shortcutsSummary, shortcutsBody);

				let advancedDetails = doc.createElement("details");
				advancedDetails.className = "llm-advanced-details";
				let advancedSummary = doc.createElement("summary");
				advancedSummary.textContent = "Advanced";
				let advancedBody = doc.createElement("div");
				advancedBody.className = "llm-advanced-body";
				advancedBody.append(
					makeIntegerSetting(
						"Max PDF context (characters)",
						() => LLMPrompt.maxPDFContextChars,
						(value) => { LLMPrompt.maxPDFContextChars = value; }
					),
					makeIntegerSetting(
						"Chunk context top-K",
						() => LLMPrompt.chunkContextTopK,
						(value) => { LLMPrompt.chunkContextTopK = value; }
					)
				);
				advancedDetails.append(advancedSummary, advancedBody);

				// System messages (extraction/selection status, errors, etc.) render
				// here instead of the main message list -- see appendMessage/
				// appendRichMessage below, which route "System"-labeled content to
				// appendLogEntry() rather than messageList. Keeps the user/assistant
				// conversation readable without dozens of "Table extraction: ..."/
				// "Including N notes as context..." lines interleaved into it, while
				// still keeping that information available (and clickable, where
				// applicable) for debugging.
				let logsDetails = doc.createElement("details");
				logsDetails.className = "llm-logs-details";
				let logsSummary = doc.createElement("summary");
				logsSummary.textContent = "Logs";
				let logsBody = doc.createElement("div");
				logsBody.className = "llm-logs-body";
				logsDetails.append(logsSummary, logsBody);

				let buttonRow = doc.createElement("div");
				buttonRow.className = "llm-button-row";
				buttonRow.append(submitButton, stopButton, discardImagesButton);

				let capturedSelection = null;
				input.addEventListener("focus", () => {
					let { text } = this.getReaderSelection();
					if (text) capturedSelection = text;
				});

				// `cancelStream` is the narrow, existing mechanism for interrupting
				// an in-progress model response (a real reader.cancel() handle,
				// wired up once actual token streaming begins -- see the
				// onReady() callback below). `cancelled`/`rejectCancel` are the
				// general mechanism layered on top: the ENTIRE submit handler
				// body runs inside a single closure (`work`, below) that gets
				// raced against a promise Stop can reject at any time, so
				// clicking Stop works during EVERY phase of a request --
				// download-reference lookups, prompt/context building, table/
				// figure selection -- not just once the model is already
				// streaming a reply. Whatever step `work` was in when cancelled
				// keeps running to completion in the background (there's no way
				// to hard-abort a Zotero.Translate call or HiddenBrowser page
				// load partway through), but the race settles immediately, so
				// the UI stops waiting/updating right away, and every checkpoint
				// inside `work` checks `cancelled` before doing anything more so
				// a stray message can't land after "Cancelled." is shown.
				let cancelStream = null;
				let cancelled = false;
				let rejectCancel = null;
				stopButton.addEventListener("click", () => {
					cancelled = true;
					cancelStream?.();
					rejectCancel?.(new Error("Cancelled"));
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

				let messageListLabel = doc.createElement("div");
				messageListLabel.className = "llm-section-label";
				messageListLabel.textContent = "Conversation";

				let messageList = doc.createElement("div");
				messageList.className = "llm-message-list";

				let controls = doc.createElement("div");
				controls.className = "llm-controls";

				// [DD/MM/YYYY - hh:mm:ss], local time, zero-padded.
				let formatLogTimestamp = () => {
					let d = new Date();
					let pad = n => String(n).padStart(2, "0");
					return `[${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} - ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}]`;
				};

				// Prepends a timestamped entry to the Logs panel (see logsBody
				// above) -- same "newest at the top, scrollTop reset to show it"
				// convention as messageList below, just a separate, collapsed-by-
				// default panel so system/status messages don't clutter the actual
				// conversation. `contentEl` carries its own "llm-log-text" class
				// (see appendMessage/appendRichMessage) for the white-text/
				// blue-link styling in style.css.
				let appendLogEntry = (contentEl) => {
					let entry = doc.createElement("div");
					entry.className = "llm-log-entry";
					let timestampEl = doc.createElement("span");
					timestampEl.className = "llm-log-timestamp";
					timestampEl.textContent = formatLogTimestamp() + " ";
					entry.append(timestampEl, contentEl);
					logsBody.prepend(entry);
					logsBody.scrollTop = 0;
					return entry;
				};

				let appendMessage = (role, text) => {
					if (role === "System") {
						let content = doc.createElement("span");
						content.className = "llm-log-text";
						content.textContent = text;
						appendLogEntry(content);
						return content;
					}

					let message = doc.createElement("div");
					message.className = "llm-message";

					let label = doc.createElement("div");
					label.className = "llm-message-label";
					label.textContent = role;

					let content = doc.createElement("pre");
					content.className = "llm-message-content";
					content.textContent = text;

					message.append(label, content);
					messageList.prepend(message);
					messageList.scrollTop = 0;
					return content;
				};

				// Makes a system message clickable to jump to the figure/table it
				// refers to: precise region navigation via its stored `position`
				// (native PDF-space rects, computed at extraction time) when
				// available, falling back to caption text-search otherwise (e.g.
				// for tables found via rotation-normalization, where a real-page
				// position can't be reliably computed).
				let makeMessageClickable = (messageEl, item) => {
					messageEl.classList.add("llm-clickable-message");
					messageEl.addEventListener("click", () => {
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

				// Renders a system message built from an ordered list of
				// parts -- each either plain text ({ text }) or a real
				// inline clickable link ({ label, title, onClick }) -- as
				// opposed to makeMessageClickable's whole-row click target,
				// so it reads as a normal sentence with just specific words
				// as the clickable parts (matching how the model's own
				// figure/table/reference links look). Used for the
				// download-reference results, which need independent links
				// for both the library item and its PDF source.
				let appendRichMessage = (parts) => {
					let content = doc.createElement("span");
					content.className = "llm-log-text";
					for (let part of parts) {
						if (part.text !== undefined) {
							content.append(doc.createTextNode(part.text));
							continue;
						}
						let link = doc.createElement("a");
						link.className = "llm-find-link";
						link.textContent = part.label;
						if (part.title) link.title = part.title;
						link.addEventListener("click", (e) => {
							e.preventDefault();
							part.onClick();
						});
						content.append(link);
					}
					appendLogEntry(content);
					return content;
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
					cancelled = false;
					let cancelPromise = new Promise((_, reject) => { rejectCancel = reject; });
					let providerLabels = { ollama: "Ollama", lmstudio: "LM Studio", litellm: "LiteLLM", openai: "OpenAI", anthropic: "Anthropic" };
					let providerLabel = providerLabels[LLMInterfaces._provider] || "Ollama";

					// The entire request -- download-reference lookup or normal
					// chat -- runs inside this one closure so it can be raced
					// against cancelPromise as a whole (see the outer
					// try/finally below), rather than needing every internal
					// step to separately understand cancellation.
					let work = (async () => {
						// Checked FIRST, before building the (comparatively expensive)
						// full PDF-context prompt -- a "download reference N" request
						// short-circuits the normal chat flow entirely, since the main
						// model has nothing useful to add to a request this specific.
						try {
							let intent = await LLMReferenceRetrieval.detectDownloadIntent(prompt);
							if (cancelled) return;
							if (intent !== null) {
								appendMessage("You", prompt);
								let pdfItem = this.getActiveReaderAttachment();
								let downloadRefNum = intent.index ?? null;
								if (downloadRefNum === null && intent.description) {
									if (!pdfItem) {
										appendMessage("System", "No active PDF to look up references from.");
										return;
									}
									let referenceIndex = await LLMReferences.getReferenceIndex(pdfItem);
									if (cancelled) return;
									downloadRefNum = await LLMReferenceRetrieval.resolveReferenceByDescription(referenceIndex, intent.description);
									if (cancelled) return;
									if (downloadRefNum === null) {
										appendMessage("System", `Could not find a reference matching "${intent.description}" in this paper's bibliography.`);
										return;
									}
								}
								appendMessage("System", `Looking up reference ${downloadRefNum} and searching for it online...`);
								let result = await LLMReferenceRetrieval.downloadReferenceToLibrary(downloadRefNum, pdfItem);
								if (cancelled) return;
								if (result.alreadyInLibrary) {
									appendRichMessage([
										{ text: "The paper is already included in your Zotero library: " },
										{ label: result.item.getField("title"), title: "Open in Zotero", onClick: () => this._openLibraryItem(result.item) },
										{ text: "." },
									]);
								}
								else if (result.success) {
									let statusText = result.hasPDF ? " with its PDF" : " (metadata only — no PDF could be found)";
									let parts = [
										{ text: `Added "` },
										{ label: result.item.getField("title"), title: "Open in Zotero", onClick: () => this._openLibraryItem(result.item) },
										{ text: `"${statusText}` },
									];
									if (result.sourceURL) {
										parts.push(
											{ text: " [source: " },
											{ label: result.sourceURL, title: "Open source in browser", onClick: () => Zotero.launchURL(result.sourceURL) },
											{ text: "]" }
										);
									}
									parts.push({ text: "." });
									appendRichMessage(parts);
								}
								else {
									appendMessage("System", result.message);
								}
								return;
							}
						}
						catch (e) {
							if (cancelled) return;
							this.log(`LLMReferenceRetrieval.detectDownloadIntent/downloadReferenceToLibrary failed: ${e.message}`);
							appendMessage("System", `Reference download failed: ${e.message}`);
							return;
						}

						try {
							let { text: liveText, info: selectionInfo } = this.getReaderSelection();
							let selectedText = liveText || capturedSelection;
							capturedSelection = null;
							let { text: pageText, pageNum, info: pageInfo } = await this.getReaderPageText();
							if (cancelled) return;
							// Shared reader-context signal for every selectXWithLLM call
							// below (tables/equations/figures/notes) -- if the user has an
							// annotation actively selected/highlighted in the reader right
							// now (clicked on the page or in the sidebar), that's about as
							// strong a relevance hint as it gets for a query like "explain
							// this".
							let { item: selectedAnnotationItem } = this.getSelectedAnnotation();
							let selectedAnnotationNote = selectedAnnotationItem
								? LLMNotes.formatAnnotation(selectedAnnotationItem)
								: null;
							let readerContext = { pageNum, selectedText, selectedAnnotationNote };
							let { prompt: modelPrompt, contextInfo, item: pdfItem, citationIndex } = await LLMPrompt.buildPromptWithActivePDFContext(prompt, selectedText, pageText);
							if (cancelled) return;
							let tableIndexPromise = pdfItem
								? LLMTables.getTableIndex(pdfItem).catch((e) => {
									this.log(`getTableIndex failed: ${e.message}`);
									return { error: e.message };
								})
								: Promise.resolve(null);
							let figureIndexPromise = pdfItem
								? LLMFigures.getFigureIndex(pdfItem).catch((e) => {
									this.log(`getFigureIndex failed: ${e.message}`);
									return null;
								})
								: Promise.resolve(null);
							let referenceIndexPromise = pdfItem
								? LLMReferences.getReferenceIndex(pdfItem).catch((e) => {
									this.log(`getReferenceIndex failed: ${e.message}`);
									return null;
								})
								: Promise.resolve(null);
							let equationIndexPromise = pdfItem
								? LLMEquations.getEquationIndex(pdfItem).catch((e) => {
									this.log(`getEquationIndex failed: ${e.message}`);
									return { error: e.message };
								})
								: Promise.resolve(null);
							let notesPromise = pdfItem
								? LLMNotes.getNotes(pdfItem).catch((e) => {
									this.log(`getNotes failed: ${e.message}`);
									return [];
								})
								: Promise.resolve([]);
							// Debug/status metadata about the request, not part of the actual
							// message -- logged rather than shown inline in the "You" bubble
							// (which now shows just the raw prompt), same reasoning as every
							// other appendMessage("System", ...) call routing to the Logs
							// panel.
							appendMessage("System", selectedText
								? `Selected Text: "${selectedText.slice(0, 120)}${selectedText.length > 120 ? "…" : ""}"`
								: `Selected Text: (none — ${selectionInfo})`);
							appendMessage("System", pageText
								? `Page Context: page ${pageNum}`
								: `Page Context: (none — ${pageInfo})`);
							appendMessage("System", contextInfo ? `PDF: ${contextInfo.title}` : "PDF: (none)");
							appendMessage("You", prompt);

							if (contextInfo?.missingText) {
								appendMessage("System", `No extracted text was available for "${contextInfo.title}". Asking without PDF context.`);
							}
							else if (contextInfo) {
								appendMessage(
									"System",
									contextInfo.retrieved
										? `Using PDF context from "${contextInfo.title}" (full PDF too large — showing top ${contextInfo.chunkCount} relevant paragraphs).`
										: `Using PDF context from "${contextInfo.title}" (${contextInfo.charCount} characters${contextInfo.truncated ? ", truncated" : ""}).`
								);
							}
							else {
								appendMessage("System", "No active PDF reader tab found. Asking without PDF context.");
							}

							let tableIndex = await tableIndexPromise;
							if (cancelled) return;
							if (tableIndex === null) {
								appendMessage("System", "Table extraction: no PDF attached.");
							}
							else if (tableIndex.error) {
								appendMessage("System", `Table extraction failed: ${tableIndex.error}`);
							}
							else if (!tableIndex.tables.length) {
								appendMessage("System", "Table extraction: no tables found in PDF.");
							}
							else {
								let selectedTables = [];
								try {
									selectedTables = await LLMPrompt.selectTablesWithLLM(tableIndex, prompt, readerContext);
								}
								catch (e) {
									this.log(`selectTablesWithLLM failed: ${e.message}`);
								}
								if (cancelled) return;
								if (selectedTables.length) {
									let tableBlock = selectedTables.map(t => LLMPrompt._formatTableMarkdown(t)).join("\n\n");
									modelPrompt += `\n\n<TABLE_CONTEXT>\n${tableBlock}\n</TABLE_CONTEXT>`;
									let labels = selectedTables.map(t => t.label).join(", ");
									let msg = appendMessage("System", `Including ${selectedTables.length} table${selectedTables.length === 1 ? "" : "s"} as context (out of ${tableIndex.tables.length} extracted): ${labels}. Click to jump to the first one.`);
									makeMessageClickable(msg, selectedTables[0]);
								}
								else {
									appendMessage("System", `Extracted ${tableIndex.tables.length} table${tableIndex.tables.length === 1 ? "" : "s"} from PDF; none matched your question closely enough to include.`);
								}
							}

							// Unlike tables (present in most papers), the large majority of
							// PDFs have zero *numbered* equations at all -- so, unlike the
							// table block above, this stays silent for the "none found" and
							// "none matched" cases rather than announcing an absence that's
							// the overwhelmingly common case and not something the user asked
							// about.
							let equationIndex = await equationIndexPromise;
							if (cancelled) return;
							if (equationIndex?.error) {
								appendMessage("System", `Equation extraction failed: ${equationIndex.error}`);
							}
							else if (equationIndex?.equations?.length) {
								let selectedEquations = [];
								try {
									selectedEquations = await LLMPrompt.selectEquationsWithLLM(equationIndex, prompt, readerContext);
								}
								catch (e) {
									this.log(`selectEquationsWithLLM failed: ${e.message}`);
								}
								if (cancelled) return;
								if (selectedEquations.length) {
									let eqBlock = selectedEquations.map(eq => LLMPrompt._formatEquationText(eq)).join("\n\n");
									modelPrompt += `\n\n<EQUATION_CONTEXT>\n${eqBlock}\n</EQUATION_CONTEXT>`;
									let labels = selectedEquations.map(eq => eq.label).join(", ");
									let msg = appendMessage("System", `Including ${selectedEquations.length} equation${selectedEquations.length === 1 ? "" : "s"} as equation context (out of ${equationIndex.equations.length} extracted): ${labels}. Click to jump to the first one.`);
									// caption fallback mirrors linkIndex's equation entries below --
									// selectedEquations entries have no `caption` field, only `text`.
									makeMessageClickable(msg, {
										position: selectedEquations[0].position,
										caption: selectedEquations[0].text.split(/\s+/).slice(0, 8).join(" "),
									});
								}
							}

							// Always announced, even on the "found none"/"none matched"
							// paths -- unlike the equation block above, this stays
							// visible (matching the table block's style) since it's
							// useful for debugging whether annotations are being picked
							// up as expected.
							let notes = await notesPromise;
							if (cancelled) return;
							// Hoisted above the if/else so it's still in scope down at
							// linkIndex construction below, for ref:note:N resolution.
							let selectedNotes = [];
							if (!notes.length) {
								appendMessage("System", "Notes: no highlights, underlines, or notes found on this PDF.");
							}
							else {
								try {
									selectedNotes = await LLMPrompt.selectNotesWithLLM(notes, prompt, readerContext);
								}
								catch (e) {
									this.log(`selectNotesWithLLM failed: ${e.message}`);
								}
								if (cancelled) return;
								if (selectedNotes.length) {
									let noteBlock = selectedNotes.map((n, i) => LLMPrompt._formatNoteContext(n, i + 1)).join("\n\n");
									modelPrompt += `\n\n<NOTE_CONTEXT>\n${noteBlock}\n</NOTE_CONTEXT>`;
									let titles = selectedNotes.map(n => n.title).join(", ");
									let msg = appendMessage("System", `Including ${selectedNotes.length} note${selectedNotes.length === 1 ? "" : "s"} as context (out of ${notes.length} extracted): ${titles}. Click to jump to the first one.`);
									// Whole-message click only jumps to the first selected note --
									// makeMessageClickable is a single click target, not one per
									// note -- good enough as a quick way in, the rest are visible in
									// the model's own answer either way (each individually
									// clickable via its own [Note N](<ref:note:N>) link, if the
									// model includes one).
									makeMessageClickable(msg, selectedNotes[0]);
								}
								else {
									appendMessage("System", `Extracted ${notes.length} note${notes.length === 1 ? "" : "s"}/highlight${notes.length === 1 ? "" : "s"} from PDF; none matched your question closely enough to include.`);
								}
							}

							let images = [];
							let figureIndex = await figureIndexPromise;
							if (cancelled) return;
							try {
								let currentModel = await LLMInterfaces.getCurrentModel();
								let supportsImages = await LLMInterfaces.modelSupportsImages(currentModel);
								// Snapshotted rather than referenced live, so a mid-request
								// removal via the thumbnail's "x" doesn't retroactively
								// change what's sent for a request already in flight.
								if (pastedImages.length) {
									if (supportsImages) {
										images.push(...pastedImages.map(img => img.dataUri));
									}
									else {
										appendMessage("System", `${currentModel} doesn't support image input -- the ${pastedImages.length} attached image${pastedImages.length === 1 ? "" : "s"} won't be sent.`);
									}
								}
								// Skipped when the user already attached image(s) themselves --
								// no need to spend an extra LLM call hunting for a figure to use
								// as image context when image context has already been provided.
								// figureIndex itself is still fetched above regardless (used below
								// for citation-link resolution on figures the model's text mentions).
								if (figureIndex?.figures?.length && supportsImages && !pastedImages.length) {
									let bestFigures = await LLMPrompt.selectFiguresWithLLM(figureIndex, prompt, readerContext);
									if (cancelled) return;
									let figuresWithImages = bestFigures.filter(f => f.image_data);
									if (figuresWithImages.length) {
										images.push(...figuresWithImages.map(f => f.image_data));
										let labels = figuresWithImages.map(f => f.label || `figure ${f.figure_num}`).join(", ");
										let msg = appendMessage("System", `Including ${figuresWithImages.length} figure${figuresWithImages.length === 1 ? "" : "s"} as image context (best match for your question, ${currentModel} supports vision): ${labels}. Click to jump to the first one.`);
										makeMessageClickable(msg, figuresWithImages[0]);
									}
								}
							}
							catch (e) {
								if (cancelled) return;
								this.log(`Image context setup failed: ${e.message}`);
							}

							// Unlike tables/figures, the reference list isn't pre-selected by a
							// separate LLM call -- the whole bibliography (already short,
							// citation-length entries) is given to the answering model
							// directly, and the system prompt tells it it MAY cite one if
							// genuinely relevant, not that it must.
							let referenceIndex = await referenceIndexPromise;
							if (cancelled) return;
							if (referenceIndex?.references?.length) {
								modelPrompt += `\n\n<REFERENCE_CONTEXT>\n${LLMPrompt._formatReferenceContext(referenceIndex.references)}\n</REFERENCE_CONTEXT>`;
								appendMessage("System", `Including bibliography (${referenceIndex.references.length} references) as context.`);
							}

							// Lets the model's own text mentions of any extracted table/figure/
							// reference/equation/note (not just the one injected as full context)
							// become clickable links -- see _renderMarkdown's `ref:table:N` /
							// `ref:figure:N` / `ref:reference:N` / `ref:equation:N` /
							// `ref:formula:N` / `ref:note:N` handling.
							// References have no stored position, so they fall back to a text search using the
							// first few words of the citation (a full-length quote is too
							// brittle a phrase-search target). The model only emits the bare
							// number, e.g. [12](<ref:reference:12>), and the rendered link
							// KEEPS that bare "[12]" as its visible text -- `label` here is
							// only used to enrich the hover tooltip with the full citation,
							// not to replace the inline text (a full bibliography entry
							// inline would clutter the response).
							let linkIndex = {
								table: new Map((tableIndex?.tables || []).map(t => [t.table_num, { position: t.position, caption: t.caption }])),
								figure: new Map((figureIndex?.figures || []).map(f => [f.figure_num, { position: f.position, caption: f.caption }])),
								reference: new Map((referenceIndex?.references || []).map(r => [r.index, {
									label: `[${r.index}] ${r.text}`,
									caption: r.text.split(/\s+/).slice(0, 8).join(" "),
								}])),
								// Real numbered equations key on equation_num (matching the
								// paper's own printed number, cited via ref:equation:N); Formulas
								// key on formula_num under a separate map instead (cited via
								// ref:formula:N) -- they share the same numeric range, so merging
								// them into one map would let a formula_num collide with an
								// unrelated equation_num.
								equation: new Map((equationIndex?.equations || [])
									.filter(eq => eq.equation_num !== null)
									.map(eq => [eq.equation_num, {
										position: eq.position,
										caption: eq.text.split(/\s+/).slice(0, 8).join(" "),
									}])),
								formula: new Map((equationIndex?.equations || [])
									.filter(eq => eq.formula_num !== null)
									.map(eq => [eq.formula_num, {
										position: eq.position,
										caption: eq.text.split(/\s+/).slice(0, 8).join(" "),
									}])),
								// Keyed 1..K over just this message's selectedNotes (see
								// _formatNoteContext's "Note N" numbering) -- not a stable
								// paper-wide number, but linkIndex itself is rebuilt fresh per
								// message anyway, so that's fine.
								note: new Map(selectedNotes.map((n, i) => [i + 1, {
									annotationKey: n.annotationKey,
									position: n.position,
									caption: n.caption,
								}])),
							};

							let reply = appendMessage(providerLabel, `Waiting for ${providerLabel}...`);
							this.log(`Submitting prompt to ${providerLabel}: ${prompt}`);
							reply.textContent = "";
							let result = await LLMInterfaces.streamModel(modelPrompt, (token) => {
								if (!cancelled) reply.textContent += token;
							}, {
								onReady(cancelFn) {
									cancelStream = cancelFn;
								},
							}, images);
							if (cancelled) return;
							if (!result.text) {
								reply.textContent = "(No response)";
							}
							else {
								let groundedText = await LLMCitation.groundCitations(result.text, citationIndex);
								if (cancelled) return;
								let html = this._renderMarkdown(groundedText, linkIndex);
								if (html) {
									let rendered = doc.createElement("div");
									rendered.className = "llm-markdown";
									rendered.innerHTML = html;
									rendered.addEventListener("click", (e) => {
										let anchor = e.target.closest(".llm-find-link");
										if (!anchor) return;
										e.preventDefault();
										if (anchor.dataset.annotationKey) {
											LLMCitation.navigateToAnnotation(anchor.dataset.annotationKey);
											return;
										}
										if (anchor.dataset.pageNum) {
											LLMCitation.navigateToPage(parseInt(anchor.dataset.pageNum, 10));
											return;
										}
										if (anchor.dataset.position) {
											try {
												LLMCitation.navigateToPosition(JSON.parse(anchor.dataset.position));
											}
											catch (err) {
												this.log(`Failed to parse position for link: ${err.message}`);
											}
											return;
										}
										LLMCitation.navigateToText(anchor.dataset.query);
									});
									reply.replaceWith(rendered);
								}
							}
							this.log(`Received response from ${providerLabel} model ${result.model}`);
						}
						catch (e) {
							if (cancelled) return;
							appendMessage(providerLabel, `${providerLabel} request failed: ${e.message}`);
							this.log(`${providerLabel} request failed: ${e.message}`);
						}
					})();

					try {
						await Promise.race([work, cancelPromise]);
					}
					catch (e) {
						if (cancelled) {
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
						cancelStream = null;
						rejectCancel = null;
					}
				});

				controls.append(modelRow, apiKeysDetails, shortcutsDetails, advancedDetails, logsDetails, inputLabel, input, imagesRow, buttonRow);
				container.append(controls, messageListLabel, messageList);
				body.appendChild(container);

				if (section && scrollContainer) {
					let scrollRect = scrollContainer.getBoundingClientRect();
					let sectionRect = section.getBoundingClientRect();
					let sectionOffsetFromTop = Math.max(0, sectionRect.top - scrollRect.top);
					let availForSection = scrollContainer.clientHeight - sectionOffsetFromTop;
					let overhead = 32; // 8px top padding + 16px bottom padding + 8px gap
					let listH = Math.max(80, availForSection - controls.offsetHeight - overhead);
					messageList.style.height = listH + "px";
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
