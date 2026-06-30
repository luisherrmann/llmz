LLMChatPane = {
	id: null,
	version: null,
	rootURI: null,
	initialized: false,
	paneID: null,
	maxPDFContextChars: 60000,
	_css: null,
	_systemPrompt: [
		"You are a helpful research assistant.",
		"Always express mathematical formulas and equations using LaTeX notation:",
		"use $<formula>$ for inline math and $$<formula>$$ for display math, ",
		"where <formula> is the mathematical formula to be returned."
	].join(" "),

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

	async getOllamaModel() {
		let response = await Zotero.HTTP.request("GET", "http://127.0.0.1:11434/api/tags", {
			timeout: 10000,
		});
		let data = JSON.parse(response.responseText);
		let model = data.models?.[0]?.name;
		if (!model) {
			throw new Error("No Ollama models found. Pull a model with `ollama pull <model>` first.");
		}
		return model;
	},

	async streamOllama(prompt, onToken, { onReady } = {}) {
		let model = await this.getOllamaModel();
		let response = await fetch("http://127.0.0.1:11434/api/generate", {
			method: "POST",
			body: JSON.stringify({
				model,
				prompt,
				stream: true,
			}),
			headers: {
				"Content-Type": "application/json",
			},
		});

		if (!response.ok) {
			throw new Error(`Ollama returned HTTP ${response.status}`);
		}

		let reader = response.body.getReader();
		onReady?.(() => reader.cancel());

		let decoder = new TextDecoder();
		let buffer = "";
		let text = "";

		while (true) {
			let { value, done } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			let lines = buffer.split("\n");
			buffer = lines.pop();

			for (let line of lines) {
				if (!line.trim()) continue;
				let data = JSON.parse(line);
				if (data.error) {
					throw new Error(data.error);
				}
				if (data.response) {
					text += data.response;
					onToken(data.response);
				}
			}
		}

		buffer += decoder.decode();
		if (buffer.trim()) {
			let data = JSON.parse(buffer);
			if (data.error) {
				throw new Error(data.error);
			}
			if (data.response) {
				text += data.response;
				onToken(data.response);
			}
		}

		return {
			model,
			text,
		};
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

	async getAttachmentFullText(item) {
		let cacheFile = Zotero.Fulltext.getItemCacheFile(item).path;
		if (await IOUtils.exists(cacheFile)) {
			this.log(`Reading PDF context from full-text cache for item ${item.libraryKey}`);
			return Zotero.File.getContentsAsync(cacheFile);
		}

		if (item.isPDFAttachment()) {
			this.log(`Extracting PDF context for item ${item.libraryKey}`);
			let { text } = await Zotero.PDFWorker.getFullText(item.id, null, true);
			return text || "";
		}

		return "";
	},

	async buildPromptWithActivePDFContext(userPrompt, selectedText = null) {
		let item = this.getActiveReaderAttachment();

		if (!item || !item.isPDFAttachment()) {
			let parts = [];
			if (selectedText) parts.push("<SELECTION_CONTEXT>", selectedText, "</SELECTION_CONTEXT>");
			parts.push(this._systemPrompt, userPrompt);
			return {
				prompt: parts.join("\n"),
				contextInfo: null,
				selectedText,
			};
		}

		let text = await this.getAttachmentFullText(item);
		if (!text.trim()) {
			return {
				prompt: userPrompt,
				contextInfo: {
					title: item.getField("title") || item.libraryKey,
					missingText: true,
				},
				selectedText,
			};
		}

		let truncated = text.length > this.maxPDFContextChars;
		let context = truncated ? text.slice(0, this.maxPDFContextChars) : text;
		let title = item.getField("title") || item.libraryKey;

		let parts = [
			"You are answering a question about the currently open PDF in Zotero.",
			"Use the PDF context below when it is relevant. If the answer is not supported by the PDF context, say so.",
			`PDF title: ${title}`,
			truncated ? `PDF context note: text was truncated to the first ${this.maxPDFContextChars} characters.` : "",
			"<PDF_CONTEXT>",
			context,
			"</PDF_CONTEXT>",
		];
		if (selectedText) parts.push("<SELECTION_CONTEXT>", selectedText, "</SELECTION_CONTEXT>");
		parts.push(this._systemPrompt, "<USER_QUESTION>", userPrompt, "</USER_QUESTION>");

		return {
			prompt: parts.filter(line => line !== "").join("\n"),
			contextInfo: {
				title,
				charCount: text.length,
				truncated,
			},
			selectedText,
		};
	},

	async main() {
		this.registerItemPane();
		this.log("Hello World pane loaded");
		this._configureMarkdown();
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
			marked.use({
				extensions: [{
					name: "math",
					level: "inline",
					start(src) { return src.indexOf("$"); },
					tokenizer(src) {
						let match = src.match(/^\$\$([\s\S]+?)\$\$/) || src.match(/^\$([^$\n]+?)\$/);
						if (match) {
							return {
								type: "math",
								raw: match[0],
								text: match[1].trim(),
								display: match[0].startsWith("$$"),
							};
						}
					},
					renderer(token) {
						try {
							return katex.renderToString(token.text, {
								displayMode: token.display,
								output: "mathml",
								throwOnError: false,
							});
						}
						catch (e) {
							return `<span>${token.text}</span>`;
						}
					},
				}],
			});
		}
	},

	_renderMarkdown(text) {
		if (typeof marked === "undefined") return null;
		return marked.parse(text);
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

				let input = doc.createElement("textarea");
				input.placeholder = "Type here...";
				input.className = "llm-input";

				let submitButton = doc.createElement("button");
				submitButton.textContent = "Submit";
				submitButton.className = "llm-submit";
				submitButton.title = "Submit (⌘ Return)";

				let stopButton = doc.createElement("button");
				stopButton.textContent = "Stop";
				stopButton.className = "llm-stop";
				stopButton.disabled = true;
				stopButton.title = "Stop (⌘ ⌫)";

				let buttonRow = doc.createElement("div");
				buttonRow.className = "llm-button-row";
				buttonRow.append(submitButton, stopButton);

				let capturedSelection = null;
				input.addEventListener("focus", () => {
					let { text } = this.getReaderSelection();
					if (text) capturedSelection = text;
				});

				let cancelStream = null;
				stopButton.addEventListener("click", () => cancelStream?.());

				input.addEventListener("keydown", (e) => {
					if (!e.metaKey) return;
					if (e.code === "Enter") {
						e.preventDefault();
						if (!submitButton.disabled) submitButton.click();
					}
					else if (e.code === "Backspace") {
						e.preventDefault();
						if (!stopButton.disabled) stopButton.click();
					}
				});

				let messageList = doc.createElement("div");
				messageList.className = "llm-message-list";

				let controls = doc.createElement("div");
				controls.className = "llm-controls";

				let appendMessage = (role, text) => {
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

				submitButton.addEventListener("click", async () => {
					let prompt = input.value.trim();
					if (!prompt) {
						appendMessage("System", "Enter a prompt first.");
						return;
					}

					submitButton.disabled = true;

					try {
						let { text: liveText, info: selectionInfo } = this.getReaderSelection();
						let selectedText = liveText || capturedSelection;
						capturedSelection = null;
						let { prompt: modelPrompt, contextInfo } = await this.buildPromptWithActivePDFContext(prompt, selectedText);
						let selectionLine = selectedText
							? `Selected Text: "${selectedText.slice(0, 120)}${selectedText.length > 120 ? "…" : ""}"`
							: `Selected Text: (none — ${selectionInfo})`;
						let visiblePrompt = contextInfo
							? `${selectionLine}\nPDF: ${contextInfo.title}\n\n${prompt}`
							: `${selectionLine}\nPDF: (none)\n\n${prompt}`;
						appendMessage("You", visiblePrompt);

						if (contextInfo?.missingText) {
							appendMessage("System", `No extracted text was available for "${contextInfo.title}". Asking without PDF context.`);
						}
						else if (contextInfo) {
							appendMessage(
								"System",
								`Using PDF context from "${contextInfo.title}" (${contextInfo.charCount} characters${contextInfo.truncated ? ", truncated" : ""}).`
							);
						}
						else {
							appendMessage("System", "No active PDF reader tab found. Asking without PDF context.");
						}

						let reply = appendMessage("Ollama", "Waiting for Ollama...");
						this.log(`Submitting prompt to Ollama: ${prompt}`);
						reply.textContent = "";
						let result = await this.streamOllama(modelPrompt, (token) => {
							reply.textContent += token;
						}, {
							onReady(cancelFn) {
								cancelStream = cancelFn;
								stopButton.disabled = false;
							},
						});
						if (!result.text) {
							reply.textContent = "(No response)";
						}
						else {
							let html = this._renderMarkdown(result.text);
							if (html) {
								let rendered = doc.createElement("div");
								rendered.className = "llm-markdown";
								rendered.innerHTML = html;
								reply.replaceWith(rendered);
							}
						}
						this.log(`Received response from Ollama model ${result.model}`);
					}
					catch (e) {
						appendMessage("Ollama", `Ollama request failed: ${e.message}`);
						this.log(`Ollama request failed: ${e.message}`);
					}
					finally {
						submitButton.disabled = false;
						stopButton.disabled = true;
						cancelStream = null;
					}
				});

				controls.append(input, buttonRow);
				container.append(controls, messageList);
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
		if (this.paneID) {
			Zotero.ItemPaneManager.unregisterSection(this.paneID);
			this.paneID = null;
		}
	},
};
