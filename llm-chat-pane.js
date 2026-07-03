LLMChatPane = {
	id: null,
	version: null,
	rootURI: null,
	initialized: false,
	paneID: null,
	maxPDFContextChars: 60000,
	maxPageContextChars: 5000,
	chunkContextTopK: 10,
	lmStudioBaseURL: "http://127.0.0.1:1234/v1",
	liteLLMBaseURL: "http://127.0.0.1:4000/v1",
	_liteLLMApiKey: "",
	_css: null,
	_provider: "ollama",
	_selectedModel: {},
	_systemPrompt: [
		"You are a helpful research assistant.",
		"Always express mathematical formulas and equations using LaTeX notation.",
		"Wrap every mathematical formula in latex notation as $<formula>$.",
		"For display math, you MUST wrap the formula in double dollar signs: $$<formula>$$. The opening $$ and closing $$ are mandatory.",
		"Always format tables as display math: $$\\begin{array}{|c|c|}\\hline ... \\\\\\hline\\end{array}$$.",
		"The opening $$ and closing $$ around \\begin{array} are mandatory. Never use \\begin{tabular}.",
		"When you state facts or findings from the PDF, add a citation link immediately after the claim.",
		"Citation format: [CITE](<find:exact phrase>). Always use the literal token [CITE] — numbering is assigned automatically.",
		"The exact phrase is 4–8 consecutive words copied verbatim from the <PDF_CONTEXT> — no paraphrasing.",
		"The angle brackets around find: are mandatory.",
		"Example: 'The mutation rate increases [CITE](<find:error-prone DNA polymerases to increase>).'",
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

	async listOllamaModels() {
		let response = await Zotero.HTTP.request("GET", "http://127.0.0.1:11434/api/tags", {
			timeout: 10000,
		});
		let data = JSON.parse(response.responseText);
		return (data.models || []).filter(m => !/embed/i.test(m.name)).map(m => m.name);
	},

	async getOllamaModel() {
		let models = await this.listOllamaModels();
		let selected = this._selectedModel.ollama;
		let model = (selected && models.includes(selected)) ? selected : models[0];
		if (!model) {
			throw new Error("No chat model found. Pull one with `ollama pull <model>` first.");
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

	async listOpenAICompatibleModels(baseURL, apiKey) {
		let headers = {};
		if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
		let response = await Zotero.HTTP.request("GET", `${baseURL}/models`, {
			headers,
			timeout: 10000,
		});
		let data = JSON.parse(response.responseText);
		return (data.data || []).filter(m => !/embed/i.test(m.id)).map(m => m.id);
	},

	async streamOpenAICompatible(baseURL, apiKey, model, prompt, onToken, { onReady } = {}) {
		let headers = { "Content-Type": "application/json" };
		if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
		let response = await fetch(`${baseURL}/chat/completions`, {
			method: "POST",
			body: JSON.stringify({
				model,
				messages: [{ role: "user", content: prompt }],
				stream: true,
			}),
			headers,
		});

		if (!response.ok) {
			throw new Error(`Request to ${baseURL} returned HTTP ${response.status}`);
		}

		let reader = response.body.getReader();
		onReady?.(() => reader.cancel());

		let decoder = new TextDecoder();
		let buffer = "";
		let text = "";

		let processLine = (line) => {
			line = line.trim();
			if (!line.startsWith("data:")) return;
			let payload = line.slice(5).trim();
			if (!payload || payload === "[DONE]") return;
			let data = JSON.parse(payload);
			if (data.error) {
				throw new Error(data.error.message || JSON.stringify(data.error));
			}
			let delta = data.choices?.[0]?.delta?.content;
			if (delta) {
				text += delta;
				onToken(delta);
			}
		};

		while (true) {
			let { value, done } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			let lines = buffer.split("\n");
			buffer = lines.pop();

			for (let line of lines) processLine(line);
		}

		buffer += decoder.decode();
		if (buffer.trim()) processLine(buffer);

		return {
			model,
			text,
		};
	},

	async listLMStudioModels() {
		return this.listOpenAICompatibleModels(this.lmStudioBaseURL, null);
	},

	async getLMStudioModel() {
		let models = await this.listLMStudioModels();
		let selected = this._selectedModel.lmstudio;
		let model = (selected && models.includes(selected)) ? selected : models[0];
		if (!model) {
			throw new Error("No chat model found. Load one in LM Studio first.");
		}
		return model;
	},

	async streamLMStudio(prompt, onToken, opts) {
		let model = await this.getLMStudioModel();
		return this.streamOpenAICompatible(this.lmStudioBaseURL, null, model, prompt, onToken, opts);
	},

	_withTimeout(promise, ms, label) {
		return Promise.race([
			promise,
			new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
		]);
	},

	async listLiteLLMModels() {
		return this.listOpenAICompatibleModels(this.liteLLMBaseURL, this._liteLLMApiKey || null);
	},

	async getLiteLLMModel() {
		let models = await this.listLiteLLMModels();
		let selected = this._selectedModel.litellm;
		let model = (selected && models.includes(selected)) ? selected : models[0];
		if (!model) {
			throw new Error("No chat model found. Configure a model in your LiteLLM proxy config.");
		}
		return model;
	},

	async streamLiteLLM(prompt, onToken, opts) {
		let model = await this.getLiteLLMModel();
		return this.streamOpenAICompatible(this.liteLLMBaseURL, this._liteLLMApiKey || null, model, prompt, onToken, opts);
	},

	async streamModel(prompt, onToken, opts) {
		if (this._provider === "lmstudio") {
			return this.streamLMStudio(prompt, onToken, opts);
		}
		if (this._provider === "litellm") {
			return this.streamLiteLLM(prompt, onToken, opts);
		}
		return this.streamOllama(prompt, onToken, opts);
	},

	async listModels() {
		if (this._provider === "lmstudio") {
			return this.listLMStudioModels();
		}
		if (this._provider === "litellm") {
			return this.listLiteLLMModels();
		}
		return this.listOllamaModels();
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
			if (text && text.length > this.maxPageContextChars) {
				text = text.slice(0, this.maxPageContextChars);
			}
			return { text: text || null, pageNum, info: `page ${pageNum ?? "?"}` };
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

	async buildPromptWithActivePDFContext(userPrompt, selectedText = null, pageText = null) {
		let item = this.getActiveReaderAttachment();

		if (!item || !item.isPDFAttachment()) {
			let parts = [];
			if (pageText) parts.push("<PAGE_CONTEXT>", pageText, "</PAGE_CONTEXT>");
			if (selectedText) parts.push("<SELECTION_CONTEXT>", selectedText, "</SELECTION_CONTEXT>");
			parts.push(this._systemPrompt, userPrompt);
			return {
				prompt: parts.join("\n"),
				contextInfo: null,
				selectedText,
				item: null,
				citationIndex: null,
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
				item,
				citationIndex: null,
			};
		}

		let title = item.getField("title") || item.libraryKey;

		let citationIndex = null;
		try {
			citationIndex = await LLMCitation.getCitationIndex(item, text);
		}
		catch (e) {
			this.log(`getCitationIndex failed: ${e.message}`);
		}

		let context, retrieved = false, truncated = false, chunkCount = 0;
		if (text.length <= this.maxPDFContextChars) {
			// Full PDF fits within budget — use it as-is, no chunking needed.
			context = text;
		}
		else {
			try {
				let paragraphIndex = await LLMCitation.getParagraphIndex(item, text);
				if (paragraphIndex) {
					let chunks = await LLMCitation.getRelevantChunks(paragraphIndex, userPrompt, this.chunkContextTopK);
					if (chunks.length) {
						context = chunks.join("\n\n");
						retrieved = true;
						chunkCount = chunks.length;
					}
				}
			}
			catch (e) {
				this.log(`getParagraphIndex/getRelevantChunks failed: ${e.message}`);
			}
			if (!retrieved) {
				truncated = true;
				context = text.slice(0, this.maxPDFContextChars);
			}
		}

		let parts = [
			"You are answering a question about the currently open PDF in Zotero.",
			"Use the PDF context below when it is relevant. If the answer is not supported by the PDF context, say so.",
			`PDF title: ${title}`,
			retrieved
				? `PDF context note: the full PDF was too large for the context budget; showing the ${chunkCount} paragraphs most relevant to your question, retrieved by embedding similarity.`
				: (truncated ? `PDF context note: text was truncated to the first ${this.maxPDFContextChars} characters.` : ""),
			"<PDF_CONTEXT>",
			context,
			"</PDF_CONTEXT>",
		];
		if (pageText) parts.push("<PAGE_CONTEXT>", pageText, "</PAGE_CONTEXT>");
		if (selectedText) parts.push("<SELECTION_CONTEXT>", selectedText, "</SELECTION_CONTEXT>");
		parts.push(this._systemPrompt, "<USER_QUESTION>", userPrompt, "</USER_QUESTION>");

		return {
			prompt: parts.filter(line => line !== "").join("\n"),
			contextInfo: {
				title,
				charCount: text.length,
				truncated,
				retrieved,
				chunkCount,
			},
			selectedText,
			item,
			citationIndex,
		};
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
		// Convert [label](<find:query>) to HTML anchors before marked parses,
		// so spaces and special chars in the query don't break markdown link parsing.
		let processed = text.replace(
			/\[([^\]]+)\]\(<find:([^>]+)>\)/g,
			(_, label, query) => {
				let escaped = query.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
				return `<a class="llm-find-link" data-query="${escaped}" title="${escaped}">${label}</a>`;
			}
		);
		return marked.parse(processed);
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

				let providerSelect = doc.createElement("select");
				providerSelect.className = "llm-provider-select";
				providerSelect.title = "Model provider";
				let providerOptions = [
					{ value: "ollama", label: "Ollama" },
					{ value: "lmstudio", label: "LM Studio" },
					{ value: "litellm", label: "API (LiteLLM)" },
				];
				for (let { value, label } of providerOptions) {
					let option = doc.createElement("option");
					option.value = value;
					option.textContent = label;
					providerSelect.appendChild(option);
				}
				providerSelect.value = this._provider;

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
					let provider = this._provider;
					modelSelect.disabled = true;
					modelSelect.replaceChildren();
					let loadingOption = doc.createElement("option");
					loadingOption.textContent = "Loading models…";
					modelSelect.appendChild(loadingOption);
					try {
						let models = await this._withTimeout(this.listModels(), 15000, "listModels");
						if (provider !== this._provider) return; // provider changed while fetching
						modelSelect.replaceChildren();
						if (!models.length) {
							let emptyOption = doc.createElement("option");
							emptyOption.textContent = "No models found";
							modelSelect.appendChild(emptyOption);
							return;
						}
						populateModelOptions(models);
						let selected = this._selectedModel[provider];
						modelSelect.value = models.includes(selected) ? selected : models[0];
						this._selectedModel[provider] = modelSelect.value;
						modelSelect.disabled = false;
					}
					catch (e) {
						if (provider !== this._provider) return;
						modelSelect.replaceChildren();
						let errorOption = doc.createElement("option");
						errorOption.textContent = "Unavailable";
						modelSelect.appendChild(errorOption);
						this.log(`Failed to list models for ${provider}: ${e.message}`);
					}
				};

				let apiKeyInput = doc.createElement("input");
				apiKeyInput.type = "password";
				apiKeyInput.className = "llm-api-key-input";
				apiKeyInput.placeholder = "API key (optional)";
				apiKeyInput.title = "LiteLLM proxy API key — kept in memory only, not saved to disk; re-enter after restarting Zotero";
				apiKeyInput.value = this._liteLLMApiKey;
				apiKeyInput.addEventListener("input", () => {
					this._liteLLMApiKey = apiKeyInput.value;
				});

				let apiKeyRow = doc.createElement("div");
				apiKeyRow.className = "llm-api-key-row";
				apiKeyRow.append(apiKeyInput);
				apiKeyRow.hidden = this._provider !== "litellm";

				providerSelect.addEventListener("change", () => {
					this._provider = providerSelect.value;
					apiKeyRow.hidden = this._provider !== "litellm";
					refreshModelOptions();
				});
				modelSelect.addEventListener("change", () => {
					this._selectedModel[this._provider] = modelSelect.value;
				});
				modelRefreshButton.addEventListener("click", () => refreshModelOptions());
				refreshModelOptions();

				let modelRow = doc.createElement("div");
				modelRow.className = "llm-model-row";
				modelRow.append(providerSelect, modelSelect, modelRefreshButton);

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
					let providerLabels = { ollama: "Ollama", lmstudio: "LM Studio", litellm: "LiteLLM" };
					let providerLabel = providerLabels[this._provider] || "Ollama";

					try {
						let { text: liveText, info: selectionInfo } = this.getReaderSelection();
						let selectedText = liveText || capturedSelection;
						capturedSelection = null;
						let { text: pageText, pageNum, info: pageInfo } = await this.getReaderPageText();
						let { prompt: modelPrompt, contextInfo, item: pdfItem, citationIndex } = await this.buildPromptWithActivePDFContext(prompt, selectedText, pageText);
						let tableIndexPromise = pdfItem
							? LLMTables.getTableIndex(pdfItem).catch((e) => {
								this.log(`getTableIndex failed: ${e.message}`);
								return { error: e.message };
							})
							: Promise.resolve(null);
						if (pdfItem) {
							LLMFigures.getFigureIndex(pdfItem).catch((e) => {
								this.log(`getFigureIndex failed: ${e.message}`);
							});
						}
						let selectionLine = selectedText
							? `Selected Text: "${selectedText.slice(0, 120)}${selectedText.length > 120 ? "…" : ""}"`
							: `Selected Text: (none — ${selectionInfo})`;
						let pageLine = pageText
							? `Page Context: page ${pageNum}`
							: `Page Context: (none — ${pageInfo})`;
						let visiblePrompt = contextInfo
							? `${selectionLine}\n${pageLine}\nPDF: ${contextInfo.title}\n\n${prompt}`
							: `${selectionLine}\n${pageLine}\nPDF: (none)\n\n${prompt}`;
						appendMessage("You", visiblePrompt);

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
						if (tableIndex === null) {
							appendMessage("System", "Table extraction: no PDF attached.");
						}
						else if (tableIndex.error) {
							appendMessage("System", `Table extraction failed: ${tableIndex.error}`);
						}
						else {
							let { tables } = tableIndex;
							let tableList = tables.map(t => {
								let [header, ...rows] = t.data;
								let cols = header?.length || 0;
								let sep = header ? "| " + header.map(() => "---").join(" | ") + " |" : "";
								let mdHeader = header ? "| " + header.join(" | ") + " |" : "";
								let mdRows = rows.map(r => "| " + r.join(" | ") + " |").join("\n");
								return `**[p.${t.page_num}] ${t.label}:** ${t.caption}\n${mdHeader}\n${sep}\n${mdRows}`;
							}).join("\n\n");
							appendMessage("System",
								`Extracted ${tables.length} table${tables.length === 1 ? "" : "s"} from PDF:\n\n${tableList}`
							);
						}

						let reply = appendMessage(providerLabel, `Waiting for ${providerLabel}...`);
						this.log(`Submitting prompt to ${providerLabel}: ${prompt}`);
						reply.textContent = "";
						let result = await this.streamModel(modelPrompt, (token) => {
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
							let groundedText = await LLMCitation.groundCitations(result.text, citationIndex);
							let html = this._renderMarkdown(groundedText);
							if (html) {
								let rendered = doc.createElement("div");
								rendered.className = "llm-markdown";
								rendered.innerHTML = html;
								rendered.addEventListener("click", (e) => {
									let anchor = e.target.closest(".llm-find-link");
									if (!anchor) return;
									e.preventDefault();
									LLMCitation.navigateToText(anchor.dataset.query);
								});
								reply.replaceWith(rendered);
							}
						}
						this.log(`Received response from ${providerLabel} model ${result.model}`);
					}
					catch (e) {
						appendMessage(providerLabel, `${providerLabel} request failed: ${e.message}`);
						this.log(`${providerLabel} request failed: ${e.message}`);
					}
					finally {
						submitButton.disabled = false;
						stopButton.disabled = true;
						cancelStream = null;
					}
				});

				controls.append(modelRow, apiKeyRow, input, buttonRow);
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
