LLMChatPane = {
	id: null,
	version: null,
	rootURI: null,
	initialized: false,
	paneID: null,

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

	async submitToOllama(prompt) {
		let model = await this.getOllamaModel();
		let response = await Zotero.HTTP.request("POST", "http://127.0.0.1:11434/api/generate", {
			body: JSON.stringify({
				model,
				prompt,
				stream: false,
			}),
			headers: {
				"Content-Type": "application/json",
			},
			timeout: 120000,
		});
		let data = JSON.parse(response.responseText);
		return {
			model,
			text: data.response || "",
		};
	},

	async main() {
		this.registerItemPane();
		this.log("Hello World pane loaded");
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
				setEnabled(!!item);
			},
			onRender: ({ doc, body }) => {
				body.replaceChildren();
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
				input.style.flex = "1";
				input.style.minHeight = "160px";
				input.style.width = "100%";
				input.style.resize = "vertical";

				let submitButton = doc.createElement("button");
				submitButton.textContent = "Submit";
				submitButton.style.alignSelf = "flex-start";

				let output = doc.createElement("pre");
				output.style.boxSizing = "border-box";
				output.style.margin = "0";
				output.style.padding = "8px";
				output.style.whiteSpace = "pre-wrap";
				output.style.wordBreak = "break-word";

				submitButton.addEventListener("click", async () => {
					let prompt = input.value.trim();
					if (!prompt) {
						output.textContent = "Enter a prompt first.";
						return;
					}

					submitButton.disabled = true;
					output.textContent = "Waiting for Ollama...";

					try {
						this.log(`Submitting prompt to Ollama: ${prompt}`);
						let result = await this.submitToOllama(prompt);
						output.textContent = result.text || "(No response)";
						this.log(`Received response from Ollama model ${result.model}`);
					}
					catch (e) {
						output.textContent = `Ollama request failed: ${e.message}`;
						this.log(`Ollama request failed: ${e.message}`);
					}
					finally {
						submitButton.disabled = false;
					}
				});

				container.append(greeting, input, submitButton, output);
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
