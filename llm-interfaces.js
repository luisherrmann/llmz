// Talks to the actual LLM backends (Ollama, LM Studio, LiteLLM, and --
// directly, with no proxy involved -- OpenAI and Anthropic) -- listing
// available models, streaming completions, and checking vision-capability
// support. Split out from llm-chat-pane.js since this is a self-contained
// concern (which HTTP API to call and how to parse its streaming response
// format) distinct from the chat pane's own UI/rendering logic. Owns the
// provider selection state itself (_provider, _selectedModel, the base
// URLs, the API keys) since that's intrinsically part of "which model
// interface to use" -- the chat pane's UI (provider/model dropdowns, API
// key fields) reads and writes these directly, the same way it already does
// for its own settings like maxPDFContextChars.
LLMInterfaces = {
	lmStudioBaseURL: "http://127.0.0.1:1234/v1",
	liteLLMBaseURL: "http://127.0.0.1:4000/v1",
	openaiBaseURL: "https://api.openai.com/v1",
	anthropicBaseURL: "https://api.anthropic.com/v1",
	_provider: "ollama",
	_selectedModel: {},

	log(msg) {
		Zotero.debug("LLM Chat Pane [Interfaces]: " + msg);
	},

	_withTimeout(promise, ms, label) {
		return Promise.race([
			promise,
			new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
		]);
	},

	// Persisted provider/model selection, so switching providers or picking a
	// specific model doesn't need to be redone every time Zotero or the
	// plugin reloads. Unlike the API keys above, this isn't sensitive data,
	// so a plain Zotero.Prefs entry is enough -- no OS-keychain encryption
	// needed. `global: true` on every Zotero.Prefs call is required here --
	// without it, Zotero.Prefs silently prefixes the key with its own
	// extensions.zotero. branch, which isn't where this plugin's own prefs
	// (see prefs.js) live.
	_providerPref: "extensions.llm-chat-pane.provider",
	_selectedModelPref: "extensions.llm-chat-pane.selectedModels",

	loadSelection() {
		try {
			let provider = Zotero.Prefs.get(this._providerPref, true);
			if (provider) this._provider = provider;
		}
		catch (e) {
			this.log(`loadSelection: failed to read provider pref: ${e.message}`);
		}
		try {
			let json = Zotero.Prefs.get(this._selectedModelPref, true);
			if (json) this._selectedModel = JSON.parse(json);
		}
		catch (e) {
			this.log(`loadSelection: failed to read selectedModel pref: ${e.message}`);
		}
	},

	saveProvider(provider) {
		this._provider = provider;
		try {
			Zotero.Prefs.set(this._providerPref, provider, true);
		}
		catch (e) {
			this.log(`saveProvider: failed to persist provider: ${e.message}`);
		}
	},

	saveSelectedModel(provider, model) {
		this._selectedModel[provider] = model;
		try {
			Zotero.Prefs.set(this._selectedModelPref, JSON.stringify(this._selectedModel), true);
		}
		catch (e) {
			this.log(`saveSelectedModel: failed to persist selected model: ${e.message}`);
		}
	},

	// Secure, persistent storage for provider API keys (LiteLLM, OpenAI,
	// Anthropic -- LM Studio and Ollama don't need one), using the exact
	// mechanism Zotero's own sync code uses for the Zotero Web API key
	// (chrome/content/zotero/xpcom/sync/syncLocal.js): a login stored via
	// Services.logins (the same nsILoginManager backing Firefox's saved
	// website passwords, persisted in the profile across restarts), with the
	// password field holding encrypted ciphertext rather than the plaintext
	// key. Encryption goes straight through Gecko's own
	// resource://gre/modules/OSKeyStore.sys.mjs (the same module
	// nsILoginManager itself uses under the hood) rather than through
	// Zotero.OSKeyStore -- that wrapper is a recent Zotero-internal addition
	// not present in all installed Zotero versions, whereas the underlying
	// platform module ships with Gecko itself. OSKeyStore derives its
	// encryption key from the OS's own native credential storage
	// (Keychain/DPAPI/libsecret), so the plaintext key is never written to
	// disk unencrypted. A distinct "realm" string per provider distinguishes
	// the three logins under one shared host. `_apiKeys` is an in-memory
	// cache populated once via loadApiKeys() (awaited during plugin startup)
	// so the synchronous streaming code paths don't need to decrypt on every
	// request.
	_loginManagerHost: "chrome://llm-chat-pane",
	_loginManagerRealms: {
		litellm: "LLM Chat Pane LiteLLM API Key",
		openai: "LLM Chat Pane OpenAI API Key",
		anthropic: "LLM Chat Pane Anthropic API Key",
	},
	_apiKeys: { litellm: "", openai: "", anthropic: "" },
	_osKeyStorePrefix: "llmkv1:",
	_osKeyStoreModule: null,

	_loadOSKeyStore() {
		if (this._osKeyStoreModule === null) {
			try {
				let { OSKeyStore } = ChromeUtils.importESModule(
					"resource://gre/modules/OSKeyStore.sys.mjs"
				);
				this._osKeyStoreModule = OSKeyStore;
			}
			catch (e) {
				this.log(`_loadOSKeyStore failed: ${e.message}`);
				this._osKeyStoreModule = false;
			}
		}
		return this._osKeyStoreModule;
	},

	async _osKeyStoreEncrypt(plaintext) {
		let mod = this._loadOSKeyStore();
		if (!mod) throw new Error("OSKeyStore unavailable");
		return this._osKeyStorePrefix + await mod.encrypt(plaintext);
	},

	async _osKeyStoreDecrypt(value) {
		if (typeof value != "string" || !value.startsWith(this._osKeyStorePrefix)) {
			return value;
		}
		let mod = this._loadOSKeyStore();
		if (!mod) throw new Error("OSKeyStore unavailable but stored value is encrypted");
		return mod.decrypt(value.slice(this._osKeyStorePrefix.length));
	},

	_findApiKeyLogin(providerKey) {
		let realm = this._loginManagerRealms[providerKey];
		if (!realm) return null;
		try {
			let logins = Services.logins.findLogins(this._loginManagerHost, null, realm);
			return logins.length ? logins[0] : null;
		}
		catch (e) {
			this.log(`_findApiKeyLogin(${providerKey}) failed: ${e.message}`);
			return null;
		}
	},

	async loadApiKeys() {
		for (let providerKey of Object.keys(this._loginManagerRealms)) {
			let login = this._findApiKeyLogin(providerKey);
			if (!login) continue;
			try {
				this._apiKeys[providerKey] = await this._osKeyStoreDecrypt(login.password);
			}
			catch (e) {
				this.log(`loadApiKeys: failed to decrypt ${providerKey} key: ${e.message}`);
			}
		}
	},

	// Persists `value` for `providerKey` (erasing the stored login instead
	// of saving an empty one if `value` is falsy) and updates the in-memory
	// cache immediately either way.
	async setApiKey(providerKey, value) {
		let realm = this._loginManagerRealms[providerKey];
		if (!realm) throw new Error(`Unknown API key provider "${providerKey}"`);
		let oldLogin = this._findApiKeyLogin(providerKey);

		if (!value) {
			if (oldLogin) Services.logins.removeLogin(oldLogin);
			this._apiKeys[providerKey] = "";
			return;
		}

		let encrypted = await this._osKeyStoreEncrypt(value);
		let nsLoginInfo = new Components.Constructor(
			"@mozilla.org/login-manager/loginInfo;1",
			Components.interfaces.nsILoginInfo,
			"init"
		);
		let loginInfo = new nsLoginInfo(this._loginManagerHost, null, realm, "API Key", encrypted, "", "");
		if (oldLogin) {
			Services.logins.modifyLogin(oldLogin, loginInfo);
		}
		else {
			await Services.logins.addLoginAsync(loginInfo);
		}
		this._apiKeys[providerKey] = value;
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

	async getOllamaModelCapabilities(model) {
		try {
			let response = await Zotero.HTTP.request("POST", "http://127.0.0.1:11434/api/show", {
				body: JSON.stringify({ name: model }),
				headers: { "Content-Type": "application/json" },
				timeout: 10000,
			});
			let data = JSON.parse(response.responseText);
			return data.capabilities || [];
		}
		catch (e) {
			this.log(`getOllamaModelCapabilities failed: ${e.message}`);
			return [];
		}
	},

	async streamOllama(prompt, onToken, { onReady } = {}, images) {
		let model = await this.getOllamaModel();
		let body = { model, prompt, stream: true };
		if (images?.length) {
			// Ollama wants raw base64, not a data: URI
			body.images = images.map(dataUri => dataUri.split(",")[1] || dataUri);
		}
		let response = await fetch("http://127.0.0.1:11434/api/generate", {
			method: "POST",
			body: JSON.stringify(body),
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

	async streamOpenAICompatible(baseURL, apiKey, model, prompt, onToken, { onReady } = {}, images) {
		let headers = { "Content-Type": "application/json" };
		if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
		let content = images?.length
			? [
				{ type: "text", text: prompt },
				...images.map(dataUri => ({ type: "image_url", image_url: { url: dataUri } })),
			]
			: prompt;
		let response = await fetch(`${baseURL}/chat/completions`, {
			method: "POST",
			body: JSON.stringify({
				model,
				messages: [{ role: "user", content }],
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

	async streamLMStudio(prompt, onToken, opts, images) {
		let model = await this.getLMStudioModel();
		return this.streamOpenAICompatible(this.lmStudioBaseURL, null, model, prompt, onToken, opts, images);
	},

	async listLiteLLMModels() {
		return this.listOpenAICompatibleModels(this.liteLLMBaseURL, this._apiKeys.litellm || null);
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

	async liteLLMSupportsVision(model) {
		try {
			let baseURL = this.liteLLMBaseURL.replace(/\/v1$/, "");
			let headers = {};
			if (this._apiKeys.litellm) headers.Authorization = `Bearer ${this._apiKeys.litellm}`;
			let response = await Zotero.HTTP.request("GET", `${baseURL}/model_group/info`, {
				headers,
				timeout: 10000,
			});
			let data = JSON.parse(response.responseText);
			let entry = (data.data || []).find(m => m.model_group === model);
			return !!entry?.supports_vision;
		}
		catch (e) {
			this.log(`liteLLMSupportsVision failed: ${e.message}`);
			return false;
		}
	},

	async streamLiteLLM(prompt, onToken, opts, images) {
		let model = await this.getLiteLLMModel();
		return this.streamOpenAICompatible(this.liteLLMBaseURL, this._apiKeys.litellm || null, model, prompt, onToken, opts, images);
	},

	// OpenAI's own API is already OpenAI-compatible by definition, so this
	// talks to it directly (no LiteLLM proxy involved) via the same shared
	// helpers used for LM Studio/LiteLLM. The generic listOpenAICompatibleModels
	// filter (just excluding "embed") isn't enough here -- OpenAI's own
	// /v1/models list includes many non-chat model IDs (image generation,
	// speech-to-text/text-to-speech, realtime, computer-use, moderation,
	// legacy completion-only models) that would just error out of the chat
	// completions endpoint this plugin uses, so this filters those out too.
	// There's no "type" field to key off of, so this is necessarily a
	// denylist -- new non-chat model families may need to be added here.
	async listOpenAIModels() {
		let models = await this.listOpenAICompatibleModels(this.openaiBaseURL, this._apiKeys.openai || null);
		let nonChatPattern = /whisper|tts|dall-e|gpt-image|image-gen|moderation|davinci|babbage|-instruct$|realtime|transcribe|computer-use/i;
		return models.filter(m => !nonChatPattern.test(m));
	},

	async getOpenAIModel() {
		let models = await this.listOpenAIModels();
		let selected = this._selectedModel.openai;
		let model = (selected && models.includes(selected)) ? selected : models[0];
		if (!model) {
			throw new Error("No chat model found. Check your OpenAI API key.");
		}
		return model;
	},

	async streamOpenAI(prompt, onToken, opts, images) {
		let model = await this.getOpenAIModel();
		return this.streamOpenAICompatible(this.openaiBaseURL, this._apiKeys.openai || null, model, prompt, onToken, opts, images);
	},

	// Anthropic's Messages API is NOT OpenAI-compatible -- different auth
	// header (x-api-key, not Authorization: Bearer), a required
	// anthropic-version header, a required max_tokens, and a different SSE
	// event shape (named events like content_block_delta carrying
	// delta.type "text_delta"/delta.text, rather than OpenAI's
	// choices[0].delta.content) -- so this needs its own implementation
	// rather than reusing streamOpenAICompatible. Verified directly against
	// Anthropic's current API docs (docs.anthropic.com), including the
	// image content-block shape (a "source" object with type "base64",
	// media_type, and data -- as opposed to OpenAI's single data: URI).
	_anthropicVersion: "2023-06-01",
	_anthropicMaxTokens: 8192,

	async listAnthropicModels() {
		let response = await Zotero.HTTP.request("GET", `${this.anthropicBaseURL}/models`, {
			headers: {
				"x-api-key": this._apiKeys.anthropic || "",
				"anthropic-version": this._anthropicVersion,
			},
			timeout: 10000,
		});
		let data = JSON.parse(response.responseText);
		return (data.data || []).map(m => m.id);
	},

	async getAnthropicModel() {
		let models = await this.listAnthropicModels();
		let selected = this._selectedModel.anthropic;
		let model = (selected && models.includes(selected)) ? selected : models[0];
		if (!model) {
			throw new Error("No Claude model found. Check your Anthropic API key.");
		}
		return model;
	},

	// Queried per-model (like liteLLMSupportsVision) rather than assumed,
	// since the /v1/models response already reports this directly via
	// capabilities.image_input.supported -- no need for a naming-pattern
	// guess like the LM Studio/OpenAI fallback uses.
	async anthropicSupportsVision(model) {
		try {
			let response = await Zotero.HTTP.request("GET", `${this.anthropicBaseURL}/models`, {
				headers: {
					"x-api-key": this._apiKeys.anthropic || "",
					"anthropic-version": this._anthropicVersion,
				},
				timeout: 10000,
			});
			let data = JSON.parse(response.responseText);
			let entry = (data.data || []).find(m => m.id === model);
			return !!entry?.capabilities?.image_input?.supported;
		}
		catch (e) {
			this.log(`anthropicSupportsVision failed: ${e.message}`);
			return false;
		}
	},

	async streamAnthropic(prompt, onToken, { onReady } = {}, images) {
		let model = await this.getAnthropicModel();
		let content = images?.length
			? [
				...images.map((dataUri) => {
					let match = dataUri.match(/^data:([^;]+);base64,(.+)$/);
					return {
						type: "image",
						source: {
							type: "base64",
							media_type: match ? match[1] : "image/png",
							data: match ? match[2] : dataUri,
						},
					};
				}),
				{ type: "text", text: prompt },
			]
			: prompt;

		let response = await fetch(`${this.anthropicBaseURL}/messages`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": this._apiKeys.anthropic || "",
				"anthropic-version": this._anthropicVersion,
			},
			body: JSON.stringify({
				model,
				messages: [{ role: "user", content }],
				max_tokens: this._anthropicMaxTokens,
				stream: true,
			}),
		});

		if (!response.ok) {
			throw new Error(`Anthropic returned HTTP ${response.status}`);
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
			if (!payload) return;
			let data = JSON.parse(payload);
			if (data.type === "error") {
				throw new Error(data.error?.message || JSON.stringify(data.error));
			}
			if (data.type === "content_block_delta" && data.delta?.type === "text_delta") {
				text += data.delta.text;
				onToken(data.delta.text);
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

	async streamModel(prompt, onToken, opts, images) {
		if (this._provider === "lmstudio") {
			return this.streamLMStudio(prompt, onToken, opts, images);
		}
		if (this._provider === "litellm") {
			return this.streamLiteLLM(prompt, onToken, opts, images);
		}
		if (this._provider === "openai") {
			return this.streamOpenAI(prompt, onToken, opts, images);
		}
		if (this._provider === "anthropic") {
			return this.streamAnthropic(prompt, onToken, opts, images);
		}
		return this.streamOllama(prompt, onToken, opts, images);
	},

	async getCurrentModel() {
		if (this._provider === "lmstudio") return this.getLMStudioModel();
		if (this._provider === "litellm") return this.getLiteLLMModel();
		if (this._provider === "openai") return this.getOpenAIModel();
		if (this._provider === "anthropic") return this.getAnthropicModel();
		return this.getOllamaModel();
	},

	// LM Studio and OpenAI have no reliable vision-capability API (unlike
	// Ollama's /api/show capabilities, LiteLLM's /model_group/info
	// supports_vision, or Anthropic's /v1/models capabilities.image_input)
	// — fall back to matching common vision-model naming patterns.
	_visionModelNamePattern: /vision|\bvl\b|-vl-|gpt-4o|gpt-5|claude-3|claude-4|claude-sonnet|claude-opus|claude-haiku|gemini|llava|pixtral|internvl|moondream|qwen2(?:\.5)?-vl/i,

	async modelSupportsImages(model) {
		if (!model) return false;
		if (this._provider === "ollama") {
			let caps = await this.getOllamaModelCapabilities(model);
			return caps.includes("vision");
		}
		if (this._provider === "litellm") {
			return this.liteLLMSupportsVision(model);
		}
		if (this._provider === "anthropic") {
			return this.anthropicSupportsVision(model);
		}
		return this._visionModelNamePattern.test(model);
	},

	async listModels() {
		if (this._provider === "lmstudio") {
			return this.listLMStudioModels();
		}
		if (this._provider === "litellm") {
			return this.listLiteLLMModels();
		}
		if (this._provider === "openai") {
			return this.listOpenAIModels();
		}
		if (this._provider === "anthropic") {
			return this.listAnthropicModels();
		}
		return this.listOllamaModels();
	},
};
