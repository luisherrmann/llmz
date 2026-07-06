// Talks to the actual LLM backends (Ollama, LM Studio, LiteLLM) -- listing
// available models, streaming completions, and checking vision-capability
// support. Split out from llm-chat-pane.js since this is a self-contained
// concern (which HTTP API to call and how to parse its streaming response
// format) distinct from the chat pane's own UI/rendering logic. Owns the
// provider selection state itself (_provider, _selectedModel, the base
// URLs, the LiteLLM API key) since that's intrinsically part of "which
// model interface to use" -- the chat pane's UI (provider/model dropdowns,
// API key field) reads and writes these directly, the same way it already
// does for its own settings like maxPDFContextChars.
LLMInterfaces = {
	lmStudioBaseURL: "http://127.0.0.1:1234/v1",
	liteLLMBaseURL: "http://127.0.0.1:4000/v1",
	_liteLLMApiKey: "",
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

	async liteLLMSupportsVision(model) {
		try {
			let baseURL = this.liteLLMBaseURL.replace(/\/v1$/, "");
			let headers = {};
			if (this._liteLLMApiKey) headers.Authorization = `Bearer ${this._liteLLMApiKey}`;
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
		return this.streamOpenAICompatible(this.liteLLMBaseURL, this._liteLLMApiKey || null, model, prompt, onToken, opts, images);
	},

	async streamModel(prompt, onToken, opts, images) {
		if (this._provider === "lmstudio") {
			return this.streamLMStudio(prompt, onToken, opts, images);
		}
		if (this._provider === "litellm") {
			return this.streamLiteLLM(prompt, onToken, opts, images);
		}
		return this.streamOllama(prompt, onToken, opts, images);
	},

	async getCurrentModel() {
		if (this._provider === "lmstudio") return this.getLMStudioModel();
		if (this._provider === "litellm") return this.getLiteLLMModel();
		return this.getOllamaModel();
	},

	// LM Studio has no reliable vision-capability API (unlike Ollama's /api/show
	// capabilities or LiteLLM's /model_group/info supports_vision) — fall back to
	// matching common vision-model naming patterns.
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
		return this._visionModelNamePattern.test(model);
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
};
