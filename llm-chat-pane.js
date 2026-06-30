LLMChatPane = {
	id: null,
	version: null,
	rootURI: null,
	initialized: false,
	paneID: null,
	maxPDFContextChars: 60000,
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

	async streamOllama(prompt, onToken) {
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

	async buildPromptWithActivePDFContext(userPrompt) {
		let item = this.getActiveReaderAttachment();
		if (!item || !item.isPDFAttachment()) {
			return {
				prompt: userPrompt,
				contextInfo: null,
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
			};
		}

		let truncated = text.length > this.maxPDFContextChars;
		let context = truncated ? text.slice(0, this.maxPDFContextChars) : text;
		let title = item.getField("title") || item.libraryKey;

		return {
			prompt: [
				"You are answering a question about the currently open PDF in Zotero.",
				"Use the PDF context below when it is relevant. If the answer is not supported by the PDF context, say so.",
				"",
				`PDF title: ${title}`,
				truncated ? `PDF context note: text was truncated to the first ${this.maxPDFContextChars} characters.` : "",
				"",
				"<PDF_CONTEXT>",
				context,
				"</PDF_CONTEXT>",
				"",
				"<USER_QUESTION>",
				userPrompt,
				"</USER_QUESTION>",
			].filter(line => line !== "").join("\n"),
			contextInfo: {
				title,
				charCount: text.length,
				truncated,
			},
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
		if (typeof marked === "undefined" || typeof hljs === "undefined") return;
		marked.setOptions({
			highlight(code, lang) {
				let language = hljs.getLanguage(lang) ? lang : "plaintext";
				return hljs.highlight(code, { language }).value;
			},
			langPrefix: "hljs language-",
		});
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
				if (section && scrollContainer) {
					section.style.minHeight = `${scrollContainer.clientHeight}px`;
				}
				body.style.display = "flex";
				body.style.flex = "1";

				let container = doc.createElement("div");
				container.style.display = "flex";
				container.style.flexDirection = "column";
				container.style.gap = "8px";
				container.style.boxSizing = "border-box";
				container.style.flex = "1";
				container.style.minHeight = "100%";
				container.style.padding = "8px 0 16px";

				let greeting = doc.createElement("div");
				greeting.textContent = "Hello World!";

				let input = doc.createElement("textarea");
				input.placeholder = "Type here...";
				input.style.boxSizing = "border-box";
				input.style.minHeight = "88px";
				input.style.width = "100%";
				input.style.resize = "vertical";

				let submitButton = doc.createElement("button");
				submitButton.textContent = "Submit";
				submitButton.style.alignSelf = "flex-start";

				let messageList = doc.createElement("div");
				messageList.style.display = "flex";
				messageList.style.flexDirection = "column";
				messageList.style.gap = "8px";
				messageList.style.flex = "1";
				messageList.style.minHeight = "0";
				messageList.style.overflow = "auto";

				let controls = doc.createElement("div");
				controls.style.display = "flex";
				controls.style.flexDirection = "column";
				controls.style.gap = "8px";
				controls.style.flex = "0 0 auto";

				let appendMessage = (role, text) => {
					let message = doc.createElement("div");
					message.style.boxSizing = "border-box";
					message.style.padding = "8px";
					message.style.wordBreak = "break-word";

					let label = doc.createElement("div");
					label.style.fontWeight = "600";
					label.style.marginBottom = "4px";
					label.textContent = role;

					let content = doc.createElement("pre");
					content.style.margin = "0";
					content.style.whiteSpace = "pre-wrap";
					content.style.fontFamily = "inherit";
					content.textContent = text;

					message.append(label, content);
					messageList.appendChild(message);
					message.scrollIntoView({ block: "nearest" });
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
						let { prompt: modelPrompt, contextInfo } = await this.buildPromptWithActivePDFContext(prompt);
						let visiblePrompt = contextInfo
							? `PDF: ${contextInfo.title}\n\n${prompt}`
							: `PDF: (none)\n\n${prompt}`;
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
							reply.parentElement.scrollIntoView({ block: "nearest" });
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
								rendered.parentElement?.scrollIntoView({ block: "nearest" });
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
					}
				});

				controls.append(input, submitButton);
				container.append(greeting, messageList, controls);
				body.appendChild(container);
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
