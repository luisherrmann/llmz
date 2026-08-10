// Talks to the actual LLM backends (Ollama, LM Studio, LiteLLM, and --
// directly, with no proxy involved -- OpenAI and Anthropic) -- listing
// available models, streaming completions, and checking vision-capability
// support. Split out from chat-pane.js since this is a self-contained
// concern (which HTTP API to call and how to parse its streaming response
// format) distinct from the chat pane's own UI/rendering logic. Owns the
// provider selection state itself (_provider, _selectedModel, the base
// URLs, the API keys) since that's intrinsically part of "which model
// interface to use" -- the chat pane's UI (provider/model dropdowns, API
// key fields) reads and writes these directly, the same way it already does
// for its own settings like maxPDFContextChars.
LLMInterfaces = {
	openaiBaseURL: "https://api.openai.com/v1",
	anthropicBaseURL: "https://api.anthropic.com/v1",
	_provider: "ollama",
	_selectedModel: {},

	log(msg) {
		Zotero.debug("LLM Chat Pane [Interfaces]: " + msg);
	},

	// Every `images` entry is either a plain data URI string (the common
	// case -- a single pasted image, or one attached figure, where there's
	// nothing to disambiguate) or a { label, dataUri } object -- used by a
	// caller batching SEVERAL images into one call that need explicit
	// correspondence to their own place in the prompt text (e.g.
	// tools/table-export.js, one image per table). Normalizing here once
	// keeps streamOpenAICompatible/streamAnthropic's own content-array-
	// building code below from each re-deriving this same "is it a string
	// or a labeled object" check.
	_normalizeImage(image) {
		return typeof image === "string" ? { label: null, dataUri: image } : image;
	},

	// User-configurable host/port for the three backends that run as a local
	// (or at least self-hosted, for LiteLLM) server rather than a fixed
	// cloud endpoint -- OpenAI/Anthropic have no equivalent, since
	// openaiBaseURL/anthropicBaseURL above are always the real hosted API.
	// Not a secret (unlike the API keys below), so this is a plain
	// Zotero.Prefs entry -- see loadServerSettings/saveServerSetting --
	// rather than going through OSKeyStore/Services.logins.
	_serverDefaults: {
		ollama: { host: "127.0.0.1", port: 11434 },
		lmstudio: { host: "127.0.0.1", port: 1234 },
		litellm: { host: "127.0.0.1", port: 4000 },
	},
	_serverSettings: null,
	_serverSettingsPref: "extensions.llm-chat-pane.serverSettings",

	// Populates _serverSettings from _serverDefaults, overlaid with anything
	// previously saved -- called once at startup (see bootstrap.js), same as
	// loadSelection(). Must run before the Providers panel (ui/providers.js)
	// renders, since it reads _serverSettings directly to pre-fill the
	// host/port fields with the current settings.
	loadServerSettings() {
		this._serverSettings = {
			ollama: { ...this._serverDefaults.ollama },
			lmstudio: { ...this._serverDefaults.lmstudio },
			litellm: { ...this._serverDefaults.litellm },
		};
		try {
			let json = Zotero.Prefs.get(this._serverSettingsPref, true);
			if (!json) return;
			let saved = JSON.parse(json);
			for (let key of Object.keys(this._serverSettings)) {
				if (saved[key]) Object.assign(this._serverSettings[key], saved[key]);
			}
		}
		catch (e) {
			this.log(`loadServerSettings: failed to read pref: ${e.message}`);
		}
	},

	saveServerSetting(providerKey, field, value) {
		if (!this._serverSettings[providerKey]) return;
		this._serverSettings[providerKey][field] = value;
		// host/port feed the base URLs every cached listing is keyed by
		// (see _cachedModelList) -- a stale entry would otherwise keep
		// answering for the OLD server after the user repoints it.
		this.clearModelListCache();
		try {
			Zotero.Prefs.set(this._serverSettingsPref, JSON.stringify(this._serverSettings), true);
		}
		catch (e) {
			this.log(`saveServerSetting: failed to persist ${providerKey}.${field}: ${e.message}`);
		}
	},

	// Ollama's native API (as opposed to the OpenAI-compatible /v1/chat/completions
	// shape LM Studio/LiteLLM/OpenAI share) has no /v1 prefix -- endpoints are
	// appended directly, e.g. `${this.ollamaBaseURL}/api/generate`.
	get ollamaBaseURL() {
		let { host, port } = this._serverSettings.ollama;
		return `http://${host}:${port}`;
	},

	// Getters (not plain properties, like openaiBaseURL/anthropicBaseURL
	// above) so every existing `this.lmStudioBaseURL`/`this.liteLLMBaseURL`
	// read stays correct without needing to change any call site, even
	// though the underlying host/port can now change at any time via the
	// Providers panel.
	get lmStudioBaseURL() {
		let { host, port } = this._serverSettings.lmstudio;
		return `http://${host}:${port}/v1`;
	},

	get liteLLMBaseURL() {
		let { host, port } = this._serverSettings.litellm;
		return `http://${host}:${port}/v1`;
	},

	_withTimeout(promise, ms, label) {
		return Promise.race([
			promise,
			new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
		]);
	},

	// Cached model listings, keyed by "<what>|<endpoint>|<apiKey>" (see each
	// list* caller below for the exact key it builds).
	//
	// Every chat request resolves its model through get<Provider>Model(),
	// which listed the provider's models FRESH each time purely to check the
	// configured model still exists (falling back to models[0] if not) --
	// one extra HTTP round trip per message, for an answer that essentially
	// never changes between messages. That was a real failure source, not
	// just waste: confirmed concretely that a chat request died outright
	// with "Tool lookup failed: Request timed out after 10000 ms" because
	// this listing GET queued behind embedBatched's own 8 concurrent
	// embedding POSTs to the SAME host (see llm/embeddings.js's own
	// `concurrency`) and blew its 10s cap -- while the actual chat call it
	// was preparing for would have been fine.
	//
	// The PROMISE is cached, not the resolved array, so concurrent callers
	// (e.g. a chat request and an embedding request resolving their models
	// at the same moment) collapse onto ONE in-flight request instead of
	// racing separate ones -- which is exactly the pile-up above.
	//
	// Failures are deliberately NOT cached (the entry is dropped on
	// rejection): a transient timeout must not poison model resolution for
	// the whole TTL, and a key/host the user is actively fixing should be
	// retried on the next attempt, not after a five-minute wait.
	_modelListCache: new Map(),
	// Five minutes -- long enough that a burst of messages (and their
	// embedding calls) all reuse one listing, short enough that a model
	// pulled/added server-side (Ollama/LM Studio, where the user really
	// does add models mid-session) shows up without restarting Zotero. The
	// provider/model dropdown doesn't wait for it either way: it forces a
	// refresh explicitly (see listModels' own `force` parameter).
	_modelListTTLMs: 5 * 60 * 1000,

	async _cachedModelList(key, fetchFn, force = false) {
		let now = Date.now();
		let entry = this._modelListCache.get(key);
		if (!force && entry && entry.expires > now) return entry.promise;
		let promise = fetchFn().catch((e) => {
			// Only drop the entry if it's still OURS -- a newer forced
			// refresh may have replaced it while this one was in flight.
			if (this._modelListCache.get(key)?.promise === promise) {
				this._modelListCache.delete(key);
			}
			throw e;
		});
		this._modelListCache.set(key, { expires: now + this._modelListTTLMs, promise });
		return promise;
	},

	// Called whenever something that would change what a listing returns is
	// edited -- an API key (setApiKey) or a self-hosted host/port
	// (saveServerSetting). Clears everything rather than just the affected
	// provider's entries: this runs on an explicit user settings edit (not
	// per request), so the cost is one extra listing per provider at most,
	// and precise per-provider key matching would have to duplicate each
	// caller's own key-building logic here.
	clearModelListCache() {
		this._modelListCache.clear();
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

	// Same persisted-selection pattern as _provider/_selectedModel above, but
	// for the EMBEDDING provider/model (see ui/advanced.js's "Embeddings"
	// section) -- deliberately a separate selection, not reusing
	// _provider/_selectedModel, since the best chat model and the best
	// embedding model are rarely the same one, and a user may not even want
	// them on the same provider (e.g. Anthropic for chat, since it has no
	// embeddings API at all -- see listEmbeddingModels' own comment -- paired
	// with Ollama for local embeddings). Anthropic is deliberately not a
	// valid value here.
	_embeddingProvider: "ollama",
	_selectedEmbeddingModel: {},
	_embeddingProviderPref: "extensions.llm-chat-pane.embeddingProvider",
	_selectedEmbeddingModelPref: "extensions.llm-chat-pane.selectedEmbeddingModels",

	loadEmbeddingSelection() {
		try {
			let provider = Zotero.Prefs.get(this._embeddingProviderPref, true);
			if (provider) this._embeddingProvider = provider;
		}
		catch (e) {
			this.log(`loadEmbeddingSelection: failed to read embedding provider pref: ${e.message}`);
		}
		try {
			let json = Zotero.Prefs.get(this._selectedEmbeddingModelPref, true);
			if (json) this._selectedEmbeddingModel = JSON.parse(json);
		}
		catch (e) {
			this.log(`loadEmbeddingSelection: failed to read selectedEmbeddingModel pref: ${e.message}`);
		}
	},

	saveEmbeddingProvider(provider) {
		this._embeddingProvider = provider;
		try {
			Zotero.Prefs.set(this._embeddingProviderPref, provider, true);
		}
		catch (e) {
			this.log(`saveEmbeddingProvider: failed to persist embedding provider: ${e.message}`);
		}
	},

	saveSelectedEmbeddingModel(provider, model) {
		this._selectedEmbeddingModel[provider] = model;
		try {
			Zotero.Prefs.set(this._selectedEmbeddingModelPref, JSON.stringify(this._selectedEmbeddingModel), true);
		}
		catch (e) {
			this.log(`saveSelectedEmbeddingModel: failed to persist selected embedding model: ${e.message}`);
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
		// The key is part of every cached listing's own key (see
		// _cachedModelList) -- drop the cache so the next listing actually
		// re-authenticates rather than serving what the OLD key returned.
		this.clearModelListCache();

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

	async listOllamaModels(force = false) {
		return this._cachedModelList(`ollama-chat|${this.ollamaBaseURL}|`, async () => {
			let response = await Zotero.HTTP.request("GET", `${this.ollamaBaseURL}/api/tags`, {
				timeout: 10000,
			});
			let data = JSON.parse(response.responseText);
			return (data.models || []).filter(m => !/embed/i.test(m.name)).map(m => m.name);
		}, force);
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

	// Inverse of listOllamaModels' own filter -- INCLUDES only names matching
	// /embed/i (Ollama has no separate "type" field to key off of either, so
	// this is the same naming-convention heuristic LLMCitation.getEmbeddingModel
	// used before this module owned embedding-model listing).
	async listOllamaEmbeddingModels(force = false) {
		return this._cachedModelList(`ollama-embedding|${this.ollamaBaseURL}|`, async () => {
			let response = await Zotero.HTTP.request("GET", `${this.ollamaBaseURL}/api/tags`, {
				timeout: 10000,
			});
			let data = JSON.parse(response.responseText);
			return (data.models || []).filter(m => /embed/i.test(m.name)).map(m => m.name);
		}, force);
	},

	async getOllamaEmbeddingModel() {
		let models = await this.listOllamaEmbeddingModels();
		let selected = this._selectedEmbeddingModel.ollama;
		let model = (selected && models.includes(selected)) ? selected : models[0];
		if (!model) {
			throw new Error("No embedding model found. Pull one with `ollama pull nomic-embed-text`.");
		}
		return model;
	},

	async getOllamaModelCapabilities(model) {
		try {
			let response = await Zotero.HTTP.request("POST", `${this.ollamaBaseURL}/api/show`, {
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

	// /api/chat (not /api/generate, the previous, single-shot-only
	// endpoint) -- the difference matters for conversation history:
	// /api/generate takes a single raw `prompt` string with no concept of
	// roles/turns at all (it does have an experimental token-level
	// `context` passthrough, but Ollama's own docs steer away from it for
	// anything conversational), while /api/chat takes a
	// `messages: [{role, content}, ...]` array, same shape as OpenAI's
	// Chat Completions -- which is what lets `messages` here carry prior
	// turns, not just the current one. Like every other backend, Ollama's
	// server itself is still stateless -- it remembers nothing between
	// calls, so the full history has to be resent every time (see
	// llm/request.js, which builds `messages`).
	// `tools` (same normalized [{name, description, schema}] shape as
	// streamOpenAICompatible/streamAnthropic take) has been supported by
	// Ollama's native /api/chat since 2024 -- confirmed against
	// https://ollama.com/blog/tool-support and ollama-js's own
	// examples/tools/calculator.ts, using the exact same OpenAI-shaped
	// {type:"function", function:{name, description, parameters}} tool
	// definitions the OpenAI-compatible providers already use. llm/intent.js
	// (the only caller) always passes `tools` unconditionally now -- an
	// earlier per-model capability gate was tried and removed after
	// confirming empirically it was never once needed across every model
	// actually used with this plugin. This function itself doesn't gate on
	// anything either way -- it just forwards whatever `tools` it's given.
	async streamOllama(messages, onToken, { onReady, systemPrompt, tools } = {}, images) {
		let model = await this.getOllamaModel();

		let ollamaMessages = [];
		if (systemPrompt) {
			ollamaMessages.push({ role: "system", content: systemPrompt });
		}
		for (let i = 0; i < messages.length; i++) {
			let m = messages[i];
			let entry = { role: m.role, content: m.content };
			// Only the LAST message (the current turn) can carry images --
			// see llm/request.js, which only ever attaches pasted images to the
			// newest prompt; historical turns' images were never persisted
			// anywhere reusable (chat.exportTranscript() only tracks text).
			if (i === messages.length - 1 && images?.length) {
				// Ollama wants raw base64, not a data: URI. Unlike
				// streamOpenAICompatible/streamAnthropic, there's no way to
				// interleave a text label between images here -- Ollama's
				// native /api/chat protocol has no content-block array at
				// all, just a flat `images` list alongside the message's own
				// plain-string `content`, with no mechanism to anchor image
				// N to any particular point in the text. A labeled { label,
				// dataUri } entry (see _normalizeImage) still works here,
				// its label is just silently dropped -- only the dataUri is
				// ever used.
				entry.images = images.map((image) => {
					let { dataUri } = this._normalizeImage(image);
					return dataUri.split(",")[1] || dataUri;
				});
			}
			ollamaMessages.push(entry);
		}

		let body = { model, messages: ollamaMessages, stream: true };
		if (tools?.length) {
			body.tools = tools.map(t => ({
				type: "function",
				function: { name: t.name, description: t.description, parameters: t.schema },
			}));
		}

		let response = await fetch(`${this.ollamaBaseURL}/api/chat`, {
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

		// Unlike streamOpenAICompatible/streamAnthropic's SSE protocols
		// (where a tool call's arguments stream in as INCREMENTAL raw-JSON-
		// string fragments across many chunks, needing _finalizeToolCalls'
		// accumulate-then-parse dance), Ollama's /api/show-documented
		// message.tool_calls[].function.arguments arrives as an ALREADY-
		// PARSED JSON object, and (consistent with local inference not
		// being able to emit a tool call before the whole thing has been
		// generated) each qualifying chunk carries the complete tool_calls
		// array already, not a partial fragment of it -- so this just keeps
		// the latest non-empty one seen rather than accumulating anything.
		let toolCalls = [];

		// /api/chat's streamed lines carry each token as message.content,
		// not response (/api/generate's shape) -- everything else about
		// the line-delimited-JSON streaming protocol is the same.
		let processLine = (line) => {
			if (!line.trim()) return;
			let data = JSON.parse(line);
			if (data.error) {
				throw new Error(data.error);
			}
			let token = data.message?.content;
			if (token) {
				text += token;
				onToken(token);
			}
			if (data.message?.tool_calls?.length) {
				toolCalls = data.message.tool_calls.map(tc => ({
					id: tc.id ?? null,
					name: tc.function?.name ?? null,
					arguments: tc.function?.arguments ?? null,
					argumentsJSON: JSON.stringify(tc.function?.arguments ?? null),
				}));
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
			toolCalls,
		};
	},

	async listOpenAICompatibleModels(baseURL, apiKey, force = false) {
		return this._cachedModelList(`openai-compatible-chat|${baseURL}|${apiKey || ""}`, async () => {
			let headers = {};
			if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
			let response = await Zotero.HTTP.request("GET", `${baseURL}/models`, {
				headers,
				timeout: 10000,
			});
			let data = JSON.parse(response.responseText);
			return (data.data || []).filter(m => !/embed/i.test(m.id)).map(m => m.id);
		}, force);
	},

	// Inverse of listOpenAICompatibleModels' own filter -- INCLUDES only
	// names matching /embed/i, shared by LM Studio/LiteLLM/OpenAI's own
	// listXEmbeddingModels below the same way listOpenAICompatibleModels
	// is already shared by their chat-model listing. Same /v1/models
	// listing endpoint either way -- only the filter direction differs.
	async listOpenAICompatibleEmbeddingModels(baseURL, apiKey, force = false) {
		return this._cachedModelList(`openai-compatible-embedding|${baseURL}|${apiKey || ""}`, async () => {
			let headers = {};
			if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
			let response = await Zotero.HTTP.request("GET", `${baseURL}/models`, {
				headers,
				timeout: 10000,
			});
			let data = JSON.parse(response.responseText);
			return (data.data || []).filter(m => /embed/i.test(m.id)).map(m => m.id);
		}, force);
	},

	// `messages` is [{role: "user"|"assistant", content: string}, ...] --
	// see llm/request.js, which builds this from chat.exportTranscript() (prior
	// turns, when LLMPrompt.useMessageHistory is on) plus the current
	// turn's full context-stuffed prompt as the last entry. The server
	// itself is stateless regardless of provider -- resending the whole
	// array on every request is what makes this a "conversation" at all,
	// not something OpenAI-compatible endpoints do on their own.
	// `tools`, if given, is this plugin's own normalized shape --
	// [{name, description, schema}], `schema` a plain JSON Schema object --
	// translated below into OpenAI's wire format
	// (tools: [{type:"function", function:{name, description, parameters}}]).
	// Shared by every provider that routes through this function (OpenAI,
	// LiteLLM, LM Studio -- see streamOpenAI/streamLiteLLM/streamLMStudio
	// below), unlike Anthropic, which needs its own translation (see
	// streamAnthropic) since its Messages API isn't OpenAI-shaped at all.
	async streamOpenAICompatible(baseURL, apiKey, model, messages, onToken, { onReady, systemPrompt, tools } = {}, images) {
		let headers = { "Content-Type": "application/json" };
		if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

		let apiMessages = [];
		if (systemPrompt) {
			apiMessages.push({ role: "system", content: systemPrompt });
		}
		for (let i = 0; i < messages.length; i++) {
			let m = messages[i];
			// Only the LAST message (the current turn) can carry images --
			// see llm/request.js, which only ever attaches pasted images to the
			// newest prompt; historical turns' images were never persisted
			// anywhere reusable (chat.exportTranscript() only tracks text).
			if (i === messages.length - 1 && images?.length) {
				// Each image is preceded by its own { type: "text" } label
				// block, if it has one (see _normalizeImage) -- rather than
				// bunching every image together in one flat list AFTER the
				// whole text block, with nothing anchoring image N to its
				// own place in the prompt. Confirmed concretely that this
				// bunched-with-no-anchor shape measurably hurt output once
				// several images were batched into one call (e.g. a multi-
				// table CSV export): the model has to track a purely
				// positional correspondence between two separately-listed,
				// equally long sequences (the text tuples, then the images),
				// rather than reading each image right where it's referenced.
				let content = [{ type: "text", text: m.content }];
				for (let image of images) {
					let { label, dataUri } = this._normalizeImage(image);
					if (label) content.push({ type: "text", text: label });
					content.push({ type: "image_url", image_url: { url: dataUri } });
				}
				apiMessages.push({ role: m.role, content });
			}
			else {
				apiMessages.push({ role: m.role, content: m.content });
			}
		}

		let body = {
			model,
			messages: apiMessages,
			stream: true,
		};
		if (tools?.length) {
			body.tools = tools.map(t => ({
				type: "function",
				function: { name: t.name, description: t.description, parameters: t.schema },
			}));
		}

		let response = await fetch(`${baseURL}/chat/completions`, {
			method: "POST",
			body: JSON.stringify(body),
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

		// A tool call streams in as several chunks, keyed by `index` (a
		// model can request more than one call in the same response, e.g.
		// two SINGLE reference lookups from one message) -- the first chunk
		// for a given index usually carries `id`/`function.name`, while
		// `function.arguments` streams in as incremental JSON-string
		// fragments across many subsequent chunks that have to be
		// concatenated before the whole thing is valid JSON. Accumulated
		// here rather than exposed incrementally to the caller (unlike
		// `text`/onToken) -- a half-formed tool call isn't actionable the
		// way a partial text token is, so there's no equivalent streaming
		// callback for it.
		let toolCallsByIndex = new Map();

		let processLine = (line) => {
			line = line.trim();
			if (!line.startsWith("data:")) return;
			let payload = line.slice(5).trim();
			if (!payload || payload === "[DONE]") return;
			let data = JSON.parse(payload);
			if (data.error) {
				throw new Error(data.error.message || JSON.stringify(data.error));
			}
			let delta = data.choices?.[0]?.delta;
			if (delta?.content) {
				text += delta.content;
				onToken(delta.content);
			}
			for (let tc of delta?.tool_calls || []) {
				let entry = toolCallsByIndex.get(tc.index) || { id: null, name: null, argumentsJSON: "" };
				if (tc.id) entry.id = tc.id;
				if (tc.function?.name) entry.name = tc.function.name;
				if (tc.function?.arguments) entry.argumentsJSON += tc.function.arguments;
				toolCallsByIndex.set(tc.index, entry);
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
			toolCalls: this._finalizeToolCalls(toolCallsByIndex),
		};
	},

	// Shared by streamOpenAICompatible/streamAnthropic below -- both
	// accumulate one tool call's arguments as a raw JSON string across many
	// stream chunks (see either function's own comment for why), keyed by
	// each provider's own stream-assigned index, and need the exact same
	// "parse what's there, keep going even if a single call's JSON came out
	// malformed" finalization once the stream ends. Returns
	// [{id, name, arguments, argumentsJSON}] in index order -- `arguments`
	// is the parsed object (or null if parsing failed, in which case
	// `argumentsJSON` -- always present -- is the caller's only recourse).
	_finalizeToolCalls(byIndex) {
		return [...byIndex.entries()]
			.sort((a, b) => a[0] - b[0])
			.map(([, entry]) => {
				let args = null;
				try {
					args = JSON.parse(entry.argumentsJSON || "{}");
				}
				catch (e) {
					this.log(`_finalizeToolCalls: failed to parse arguments for tool "${entry.name}": ${e.message}`);
				}
				return { id: entry.id, name: entry.name, arguments: args, argumentsJSON: entry.argumentsJSON };
			});
	},

	async listLMStudioModels(force = false) {
		return this.listOpenAICompatibleModels(this.lmStudioBaseURL, null, force);
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

	async listLMStudioEmbeddingModels(force = false) {
		return this.listOpenAICompatibleEmbeddingModels(this.lmStudioBaseURL, null, force);
	},

	async getLMStudioEmbeddingModel() {
		let models = await this.listLMStudioEmbeddingModels();
		let selected = this._selectedEmbeddingModel.lmstudio;
		let model = (selected && models.includes(selected)) ? selected : models[0];
		if (!model) {
			throw new Error("No embedding model found. Load one in LM Studio first.");
		}
		return model;
	},

	async streamLMStudio(messages, onToken, opts, images) {
		let model = await this.getLMStudioModel();
		return this.streamOpenAICompatible(this.lmStudioBaseURL, null, model, messages, onToken, opts, images);
	},

	async listLiteLLMModels(force = false) {
		return this.listOpenAICompatibleModels(this.liteLLMBaseURL, this._apiKeys.litellm || null, force);
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

	async listLiteLLMEmbeddingModels(force = false) {
		return this.listOpenAICompatibleEmbeddingModels(this.liteLLMBaseURL, this._apiKeys.litellm || null, force);
	},

	async getLiteLLMEmbeddingModel() {
		let models = await this.listLiteLLMEmbeddingModels();
		let selected = this._selectedEmbeddingModel.litellm;
		let model = (selected && models.includes(selected)) ? selected : models[0];
		if (!model) {
			throw new Error("No embedding model found. Configure one in your LiteLLM proxy config.");
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

	async streamLiteLLM(messages, onToken, opts, images) {
		let model = await this.getLiteLLMModel();
		return this.streamOpenAICompatible(this.liteLLMBaseURL, this._apiKeys.litellm || null, model, messages, onToken, opts, images);
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
	async listOpenAIModels(force = false) {
		let models = await this.listOpenAICompatibleModels(this.openaiBaseURL, this._apiKeys.openai || null, force);
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

	// No denylist needed here (unlike listOpenAIModels' own nonChatPattern)
	// -- OpenAI's real embedding models (text-embedding-3-small/-large,
	// text-embedding-ada-002) all match /embed/i cleanly, and the INCLUDE-
	// only filter already excludes every non-embedding model family (image
	// generation, TTS, etc.) on its own.
	async listOpenAIEmbeddingModels(force = false) {
		return this.listOpenAICompatibleEmbeddingModels(this.openaiBaseURL, this._apiKeys.openai || null, force);
	},

	async getOpenAIEmbeddingModel() {
		let models = await this.listOpenAIEmbeddingModels();
		let selected = this._selectedEmbeddingModel.openai;
		let model = (selected && models.includes(selected)) ? selected : models[0];
		if (!model) {
			throw new Error("No embedding model found. Check your OpenAI API key.");
		}
		return model;
	},

	async streamOpenAI(messages, onToken, opts, images) {
		let model = await this.getOpenAIModel();
		return this.streamOpenAICompatible(this.openaiBaseURL, this._apiKeys.openai || null, model, messages, onToken, opts, images);
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

	async listAnthropicModels(force = false) {
		return this._cachedModelList(`anthropic-chat|${this.anthropicBaseURL}|${this._apiKeys.anthropic || ""}`, async () => {
			let response = await Zotero.HTTP.request("GET", `${this.anthropicBaseURL}/models`, {
				headers: {
					"x-api-key": this._apiKeys.anthropic || "",
					"anthropic-version": this._anthropicVersion,
				},
				timeout: 10000,
			});
			let data = JSON.parse(response.responseText);
			return (data.data || []).map(m => m.id);
		}, force);
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

	// `messages` is [{role: "user"|"assistant", content: string}, ...] --
	// same shape/source as streamOpenAICompatible's own `messages` (see
	// llm/request.js). `systemPrompt`, unlike the OpenAI-compatible backends
	// (which get it prepended as a {role: "system"} message), goes in
	// Anthropic's own dedicated top-level `system` field instead -- its
	// Messages API has no "system" role within `messages` at all. `tools`
	// is the same normalized [{name, description, schema}] shape
	// streamOpenAICompatible takes -- translated below into Anthropic's own
	// wire format (tools: [{name, description, input_schema}]), a plain
	// top-level array rather than OpenAI's {type:"function", function:{...}}
	// wrapper.
	async streamAnthropic(messages, onToken, { onReady, systemPrompt, tools } = {}, images) {
		let model = await this.getAnthropicModel();

		let apiMessages = messages.map((m, i) => {
			// Only the LAST message (the current turn) can carry images --
			// see llm/request.js, which only ever attaches pasted images to the
			// newest prompt; historical turns' images were never persisted
			// anywhere reusable (chat.exportTranscript() only tracks text).
			if (i !== messages.length - 1 || !images?.length) {
				return { role: m.role, content: m.content };
			}
			return {
				role: m.role,
				content: [
					// Each image is preceded by its own { type: "text" }
					// label block, if it has one (see _normalizeImage) --
					// same reasoning as streamOpenAICompatible's own content
					// array: bunching several images together with nothing
					// anchoring image N to its own place in the prompt
					// measurably hurt output once several images were
					// batched into one call. Anthropic's Messages API
					// supports arbitrary text/image block ordering within
					// `content`, same as OpenAI's.
					...images.flatMap((image) => {
						let { label, dataUri } = this._normalizeImage(image);
						let match = dataUri.match(/^data:([^;]+);base64,(.+)$/);
						let block = {
							type: "image",
							source: {
								type: "base64",
								media_type: match ? match[1] : "image/png",
								data: match ? match[2] : dataUri,
							},
						};
						return label ? [{ type: "text", text: label }, block] : [block];
					}),
					{ type: "text", text: m.content },
				],
			};
		});

		let body = {
			model,
			messages: apiMessages,
			max_tokens: this._anthropicMaxTokens,
			stream: true,
		};
		if (systemPrompt) {
			body.system = systemPrompt;
		}
		if (tools?.length) {
			body.tools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.schema }));
		}

		let response = await fetch(`${this.anthropicBaseURL}/messages`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": this._apiKeys.anthropic || "",
				"anthropic-version": this._anthropicVersion,
			},
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			throw new Error(`Anthropic returned HTTP ${response.status}`);
		}

		let reader = response.body.getReader();
		onReady?.(() => reader.cancel());

		let decoder = new TextDecoder();
		let buffer = "";
		let text = "";

		// Same accumulate-then-finalize approach as streamOpenAICompatible's
		// own toolCallsByIndex (see _finalizeToolCalls, shared by both), but
		// keyed and shaped differently since Anthropic's streaming protocol
		// for a tool_use block is structured differently from OpenAI's:
		// `content_block_start` (keyed by `data.index`) carries the tool's
		// `id`/`name` up front in a single event, and its `input` (the
		// arguments) then streams in as raw JSON-string fragments via
		// `content_block_delta` events of type "input_json_delta" --
		// `delta.partial_json` -- rather than being split across the same
		// kind of event that also carries `name`.
		let toolCallsByIndex = new Map();

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
			else if (data.type === "content_block_start" && data.content_block?.type === "tool_use") {
				toolCallsByIndex.set(data.index, {
					id: data.content_block.id,
					name: data.content_block.name,
					argumentsJSON: "",
				});
			}
			else if (data.type === "content_block_delta" && data.delta?.type === "input_json_delta") {
				let entry = toolCallsByIndex.get(data.index);
				if (entry) entry.argumentsJSON += data.delta.partial_json || "";
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
			toolCalls: this._finalizeToolCalls(toolCallsByIndex),
		};
	},

	// `messages` accepts either a plain string (wrapped into a single
	// {role: "user"} entry below, for backward compatibility with every
	// one-off/classification-style caller -- tools/reference-retrieval.js's
	// _callModel, and llm/prompt.js's several selectXWithLLM helpers --
	// none of which are part of the visible chat conversation and
	// shouldn't carry history or a custom system prompt) or an array of
	// {role, content} entries (llm/request.js's actual chat flow, built from
	// chat.exportTranscript() plus the current turn).
	// `opts.tools`, if given, is passed straight through to whichever
	// provider function ends up handling this call -- normalized
	// [{name, description, schema}] (schema a plain JSON Schema object),
	// translated into each provider's own wire format by
	// streamOpenAICompatible (OpenAI/LiteLLM/LM Studio), streamAnthropic,
	// or streamOllama (all four support it). Every path's
	// result is `{model, text, toolCalls}` --
	// `toolCalls` is `[{id, name, arguments, argumentsJSON}]`, empty unless
	// the model actually decided to call something.
	async streamModel(messages, onToken, opts, images) {
		if (typeof messages === "string") {
			messages = [{ role: "user", content: messages }];
		}
		if (this._provider === "lmstudio") {
			return this.streamLMStudio(messages, onToken, opts, images);
		}
		if (this._provider === "litellm") {
			return this.streamLiteLLM(messages, onToken, opts, images);
		}
		if (this._provider === "openai") {
			return this.streamOpenAI(messages, onToken, opts, images);
		}
		if (this._provider === "anthropic") {
			return this.streamAnthropic(messages, onToken, opts, images);
		}
		return this.streamOllama(messages, onToken, opts, images);
	},

	async getCurrentModel() {
		if (this._provider === "lmstudio") return this.getLMStudioModel();
		if (this._provider === "litellm") return this.getLiteLLMModel();
		if (this._provider === "openai") return this.getOpenAIModel();
		if (this._provider === "anthropic") return this.getAnthropicModel();
		return this.getOllamaModel();
	},

	// Human-readable display name for a chat provider ID -- shared by
	// llm/request.js's own reply-bubble labeling and any other caller (e.g.
	// chat-pane.js's onLoadConversation) that needs to show which
	// provider/model a plugin-generated status bubble is "speaking as",
	// rather than each call site keeping its own copy of this mapping.
	getProviderLabel(provider) {
		let providerLabels = { ollama: "Ollama", lmstudio: "LM Studio", litellm: "LiteLLM", openai: "OpenAI", anthropic: "Anthropic" };
		return providerLabels[provider] || "Ollama";
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

	// `force` bypasses the model-list cache (see _cachedModelList) -- passed
	// by the provider/model dropdown, which is exactly the moment the user
	// expects to see models added server-side since the cache was filled.
	// Every other caller (the per-request get<Provider>Model resolvers) uses
	// the cached path.
	async listModels(force = false) {
		if (this._provider === "lmstudio") {
			return this.listLMStudioModels(force);
		}
		if (this._provider === "litellm") {
			return this.listLiteLLMModels(force);
		}
		if (this._provider === "openai") {
			return this.listOpenAIModels(force);
		}
		if (this._provider === "anthropic") {
			return this.listAnthropicModels(force);
		}
		return this.listOllamaModels(force);
	},

	// Same four-provider dispatch as listModels/getCurrentModel above, but
	// against _embeddingProvider/_selectedEmbeddingModel instead of
	// _provider/_selectedModel -- no "anthropic" case, since Anthropic has
	// no embeddings API of its own (confirmed directly against Anthropic's
	// own docs: they explicitly recommend a third-party provider, Voyage AI,
	// instead -- a genuinely separate integration this doesn't cover, not
	// just a missing case here). ui/advanced.js's Embeddings provider
	// dropdown only ever offers the other four, so _embeddingProvider should
	// never actually BE "anthropic" in practice.
	async listEmbeddingModels(force = false) {
		if (this._embeddingProvider === "lmstudio") {
			return this.listLMStudioEmbeddingModels(force);
		}
		if (this._embeddingProvider === "litellm") {
			return this.listLiteLLMEmbeddingModels(force);
		}
		if (this._embeddingProvider === "openai") {
			return this.listOpenAIEmbeddingModels(force);
		}
		return this.listOllamaEmbeddingModels(force);
	},

	async getCurrentEmbeddingModel() {
		if (this._embeddingProvider === "lmstudio") return this.getLMStudioEmbeddingModel();
		if (this._embeddingProvider === "litellm") return this.getLiteLLMEmbeddingModel();
		if (this._embeddingProvider === "openai") return this.getOpenAIEmbeddingModel();
		return this.getOllamaEmbeddingModel();
	},

	// Computes one embedding vector per entry of `texts`, IN ORDER, using a
	// single request -- both embedding endpoints below accept a batched
	// `input` (a string OR an array of strings), not just one text at a
	// time, so batching multiple chunks into one request is both faster
	// (one round trip instead of N) and cheaper than embedding one at a
	// time. See LLMCitation.embedBatched for the concurrency-limited
	// batch-splitting/dispatch built on top of this (used by citation.js/
	// document/figures.js's own embedding loops) -- this method itself does
	// NOT cap how many texts it sends in one request, so callers are
	// responsible for keeping batches within whatever size a given
	// provider/model can actually handle in one request.
	//
	// `model`/`provider`, if given, override the CURRENT embedding
	// selection -- needed by citation.js to re-embed a query against
	// whichever provider+model an already-built citation index was actually
	// embedded with (see its own comment), since embeddings from two
	// different models (or the same model name under two different
	// providers) aren't comparable via cosine similarity, and the user may
	// have switched their embedding selection since that index was built.
	// Defaults to the CURRENT selection (resolving the model via
	// getCurrentEmbeddingModel) when building a NEW index instead.
	//
	// Ollama uses its own native /api/embed (confirmed working already --
	// see this plugin's prior Ollama-only implementation); LM Studio/
	// LiteLLM/OpenAI all speak the same OpenAI-compatible POST
	// {baseURL}/embeddings endpoint ({model, input} -> {data:
	// [{embedding, index}]}), the same compatibility this plugin already
	// relies on for their /chat/completions endpoints.
	async getEmbeddings(texts, model, provider) {
		provider = provider || this._embeddingProvider;
		if (!texts.length) return [];
		if (!model) {
			let saved = this._embeddingProvider;
			this._embeddingProvider = provider;
			try {
				model = await this.getCurrentEmbeddingModel();
			}
			finally {
				this._embeddingProvider = saved;
			}
		}

		if (provider === "ollama") {
			this.log(`getEmbeddings: provider=ollama model=${model} count=${texts.length}`);
			let response = await fetch(`${this.ollamaBaseURL}/api/embed`, {
				method: "POST",
				body: JSON.stringify({ model, input: texts }),
				headers: { "Content-Type": "application/json" },
			});
			if (!response.ok) {
				let body = await response.text().catch(() => "(unreadable)");
				throw new Error(`Embedding request failed: HTTP ${response.status} — ${body}`);
			}
			let data = await response.json();
			return data.embeddings;
		}

		if (provider === "anthropic") {
			throw new Error("Anthropic has no embeddings API of its own -- choose a different Embeddings provider in Advanced settings.");
		}

		let baseURL = provider === "lmstudio" ? this.lmStudioBaseURL
			: provider === "litellm" ? this.liteLLMBaseURL
			: this.openaiBaseURL;
		let apiKey = provider === "litellm" ? this._apiKeys.litellm
			: provider === "openai" ? this._apiKeys.openai
			: null;
		this.log(`getEmbeddings: provider=${provider} model=${model} count=${texts.length}`);
		let headers = { "Content-Type": "application/json" };
		if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
		let response = await fetch(`${baseURL}/embeddings`, {
			method: "POST",
			body: JSON.stringify({ model, input: texts }),
			headers,
		});
		if (!response.ok) {
			let body = await response.text().catch(() => "(unreadable)");
			throw new Error(`Embedding request failed: HTTP ${response.status} — ${body}`);
		}
		let data = await response.json();
		// Sorted by `index` -- not every OpenAI-compatible backend is
		// guaranteed to return entries in request order.
		return data.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
	},

	// Single-text convenience wrapper over getEmbeddings above.
	async getEmbedding(text, model, provider) {
		let [embedding] = await this.getEmbeddings([text], model, provider);
		return embedding;
	},
};
