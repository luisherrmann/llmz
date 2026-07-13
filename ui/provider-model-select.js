// The provider + model dropdown row (e.g. "OpenAI" + "gpt-5.4" + a refresh
// button) at the top of the chat pane's controls. Split out of
// llm-chat-pane.js's onRender for the same reason as ui/logs.js/ui/chat.js --
// self-contained DOM + behavior that only needs LLMInterfaces (the
// provider/model registry + persisted selection), not anything else in the
// pane.
LLMUIProviderModelSelect = {
	log(msg) {
		Zotero.debug("LLM Chat Pane [ProviderModelSelect]: " + msg);
	},

	_modelGroupLabels: {
		openai: "OpenAI",
		anthropic: "Anthropic",
		ollama: "Ollama",
		ollama_chat: "Ollama",
		gemini: "Gemini",
		vertex_ai: "Vertex AI",
		xai: "XAI",
		vllm: "VLLM",
		fireworks_ai: "Fireworks AI",
	},

	_addModelOption(doc, parent, name) {
		let option = doc.createElement("option");
		option.value = name;
		option.textContent = name;
		parent.appendChild(option);
	},

	// Extracts the leading dotted/dashed version run (e.g. "5" from "gpt-5-pro",
	// [4, 5] from "claude-sonnet-4-5") as an array of numeric components, so models
	// sort newest-version-first without relying on provider metadata (which turned
	// out to be a fake placeholder, not real dates).
	_modelVersionParts(name) {
		let match = name.match(/\d+(?:[.-]\d+)*/);
		if (!match) return [];
		return match[0].split(/[.-]/).map(n => parseInt(n, 10));
	},

	_pathDepth(name) {
		return (name.match(/\//g) || []).length;
	},

	_compareModelNames(a, b) {
		let depthDiff = this._pathDepth(a) - this._pathDepth(b); // ascending: shorter paths first
		if (depthDiff !== 0) return depthDiff;
		let va = this._modelVersionParts(a);
		let vb = this._modelVersionParts(b);
		let len = Math.max(va.length, vb.length);
		for (let i = 0; i < len; i++) {
			let diff = (vb[i] || 0) - (va[i] || 0); // descending: higher version first
			if (diff !== 0) return diff;
		}
		return a.localeCompare(b);
	},

	_populateModelOptions(doc, modelSelect, models) {
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
		ungrouped.sort((a, b) => this._compareModelNames(a, b));
		for (let name of ungrouped) this._addModelOption(doc, modelSelect, name);
		for (let [prefix, names] of groups) {
			names.sort((a, b) => this._compareModelNames(a, b));
			let optgroup = doc.createElement("optgroup");
			optgroup.label = this._modelGroupLabels[prefix] || (prefix.charAt(0).toUpperCase() + prefix.slice(1));
			for (let name of names) this._addModelOption(doc, optgroup, name);
			modelSelect.appendChild(optgroup);
		}
	},

	// Builds the provider+model dropdown row for one item-pane render.
	// `refreshIconURL` is a plain file:/jar: URL (see llm-chat-pane.js's
	// onRender, rootURI + "icons/refresh_*.svg"), rendered via the shared
	// CSS mask-image .llm-icon class (see style.css) -- same technique as
	// ui/past-conversations.js's edit/done_outline toggle icons.
	// All the state hooks (`getProvider`/`saveProvider`/`getSelectedModel`/
	// `saveSelectedModel`/`listModels`) default to LLMInterfaces' CHAT
	// provider/model state, so existing call sites (llm-chat-pane.js's
	// Settings row) need no changes. ui/advanced.js's Embeddings section
	// passes the `_embeddingProvider`/`_selectedEmbeddingModel` equivalents
	// instead, so the exact same row (options list, sorting, refresh
	// behavior) can be reused for embedding-model selection without
	// duplicating any of this file.
	// Returns:
	//   element   -- the row <div> (provider select, model select, refresh
	//                button) to place in the pane's controls
	//   refresh() -- re-fetches and repopulates the model dropdown for
	//                whichever provider is currently selected (also called
	//                once internally on creation, and again on provider
	//                change/refresh-button click)
	create(doc, {
		refreshIconURL,
		providerOptions = [
			{ value: "ollama", label: "Ollama" },
			{ value: "lmstudio", label: "LM Studio" },
			{ value: "litellm", label: "API (LiteLLM)" },
			{ value: "openai", label: "OpenAI" },
			{ value: "anthropic", label: "Anthropic" },
		],
		providerTitle = "Model provider",
		modelTitle = "Model",
		getProvider = () => LLMInterfaces._provider,
		saveProvider = provider => LLMInterfaces.saveProvider(provider),
		getSelectedModel = provider => LLMInterfaces._selectedModel[provider],
		saveSelectedModel = (provider, model) => LLMInterfaces.saveSelectedModel(provider, model),
		listModels = () => LLMInterfaces.listModels(),
		// Fires with (provider, model) whenever the selected pair actually
		// changes -- both from an explicit model pick (modelSelect's own
		// "change" listener below) and from switching provider (which
		// auto-selects a model as part of refreshModelOptions below, with no
		// separate modelSelect "change" event of its own). Undefined by
		// default so the Embeddings row (ui/advanced.js, which reuses this
		// same create() with its own get/save hooks) stays a no-op here --
		// only the main chat Settings row (llm-chat-pane.js's onRender)
		// passes this, to keep LLMPrompt's per-(provider,model) advanced
		// settings in sync with whichever pair is actually selected.
		onChange,
	} = {}) {
		let providerSelect = doc.createElement("select");
		providerSelect.className = "llm-provider-select";
		providerSelect.title = providerTitle;
		for (let { value, label } of providerOptions) {
			let option = doc.createElement("option");
			option.value = value;
			option.textContent = label;
			providerSelect.appendChild(option);
		}
		providerSelect.value = getProvider();

		let modelSelect = doc.createElement("select");
		modelSelect.className = "llm-model-select";
		modelSelect.title = modelTitle;
		modelSelect.disabled = true;

		let modelRefreshButton = doc.createElement("button");
		modelRefreshButton.className = "llm-model-refresh";
		modelRefreshButton.title = "Refresh model list";
		modelRefreshButton.append(LLMUIIcon.create(doc, refreshIconURL), doc.createTextNode("Refresh"));

		let refreshModelOptions = async () => {
			let provider = getProvider();
			modelSelect.disabled = true;
			modelSelect.replaceChildren();
			let loadingOption = doc.createElement("option");
			loadingOption.textContent = "Loading models…";
			modelSelect.appendChild(loadingOption);
			try {
				let models = await LLMInterfaces._withTimeout(listModels(), 15000, "listModels");
				if (provider !== getProvider()) return; // provider changed while fetching
				modelSelect.replaceChildren();
				if (!models.length) {
					let emptyOption = doc.createElement("option");
					emptyOption.textContent = "No models found";
					modelSelect.appendChild(emptyOption);
					return;
				}
				this._populateModelOptions(doc, modelSelect, models);
				let selected = getSelectedModel(provider);
				modelSelect.value = models.includes(selected) ? selected : models[0];
				saveSelectedModel(provider, modelSelect.value);
				onChange?.(provider, modelSelect.value);
				modelSelect.disabled = false;
			}
			catch (e) {
				if (provider !== getProvider()) return;
				modelSelect.replaceChildren();
				let errorOption = doc.createElement("option");
				errorOption.textContent = "Unavailable";
				modelSelect.appendChild(errorOption);
				this.log(`Failed to list models for ${provider}: ${e.message}`);
			}
		};

		providerSelect.addEventListener("change", () => {
			saveProvider(providerSelect.value);
			refreshModelOptions();
		});
		modelSelect.addEventListener("change", () => {
			saveSelectedModel(getProvider(), modelSelect.value);
			onChange?.(getProvider(), modelSelect.value);
		});
		modelRefreshButton.addEventListener("click", () => refreshModelOptions());
		refreshModelOptions();

		let element = doc.createElement("div");
		element.className = "llm-model-row";
		element.append(providerSelect, modelSelect, modelRefreshButton);

		return { element, refresh: refreshModelOptions };
	},
};
