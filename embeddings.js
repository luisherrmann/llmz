// Generic text-embedding API: which backend/model to embed with, batched+
// concurrent embedding requests, and cosine similarity -- split out of
// llm-citation.js, which now just DELEGATES to this module for the widely-
// used methods (getEmbedding/getEmbeddings/embedBatched/cosineSimilarity/
// getEmbeddingModel stay as thin wrappers there, so document/tables.js,
// document/figures.js, semantic-history.js, request.js etc. don't need to
// change a single call site) while keeping citation-index building/caching
// (getCitationIndex/getParagraphIndex/getRelevantChunks/groundCitations),
// which is a genuinely different, citation-specific concern, in
// llm-citation.js itself.
LLMEmbeddings = {
	// Default batch size for embedBatched below -- exposed as an Advanced
	// setting (ui/advanced.js's Embeddings section). Persisted per
	// (embedding provider, embedding model) pair -- same
	// load/apply/save-per-pair pattern as LLMPrompt's own advanced settings
	// (see its own comment for the fuller rationale), just keyed off
	// LLMInterfaces' EMBEDDING provider/model state instead of its chat
	// one, since batch size is a property of whichever backend embeddings
	// actually get requested from, not the chat model.
	embedBatchSize: 1024,
	_advancedSettingKeys: ["embedBatchSize"],
	_advancedSettingDefaults: { embedBatchSize: 1024 },
	_advancedSettingsByPair: {},
	// Deliberately UNCHANGED from when this setting lived on LLMCitation --
	// renaming it would silently orphan anyone's already-saved batch size
	// (a fresh pref key reads back empty, reverting to the default) for no
	// real benefit, since the pref's own content has nothing to do with
	// which JS object happens to own the code that reads it.
	_advancedSettingsPref: "extensions.llm-chat-pane.citationAdvancedSettings",

	log(msg) {
		Zotero.debug("LLM Chat Pane [Embeddings]: " + msg);
	},

	// Populates _advancedSettingsByPair from disk, then applies whatever's
	// saved for the CURRENTLY selected embedding provider/model
	// (LLMInterfaces.loadEmbeddingSelection() must have already run -- see
	// bootstrap.js's call ordering) onto this object's own properties.
	// Called once at startup, same as LLMPrompt.loadAdvancedSettings().
	loadAdvancedSettings() {
		try {
			let json = Zotero.Prefs.get(this._advancedSettingsPref, true);
			if (json) this._advancedSettingsByPair = JSON.parse(json);
		}
		catch (e) {
			this.log(`loadAdvancedSettings: failed to read pref: ${e.message}`);
		}
		this.applyAdvancedSettingsFor(LLMInterfaces._embeddingProvider, LLMInterfaces._selectedEmbeddingModel[LLMInterfaces._embeddingProvider]);
	},

	// Overwrites this object's own advanced-setting properties with
	// whichever value is saved for (provider, model), falling back to
	// _advancedSettingDefaults for any key that pair has never customized.
	// Called from loadAdvancedSettings above at startup, and again whenever
	// the EMBEDDING provider/model selection changes (see
	// ui/provider-model-select.js's onChange, wired up in ui/advanced.js's
	// Embeddings section) so switching embedding models mid-session
	// immediately switches to that model's own tuned batch size.
	applyAdvancedSettingsFor(provider, model) {
		let saved = this._advancedSettingsByPair[`${provider}:${model}`] || {};
		for (let key of this._advancedSettingKeys) {
			this[key] = saved[key] !== undefined ? saved[key] : this._advancedSettingDefaults[key];
		}
	},

	// Persists ONE advanced setting under the CURRENTLY selected embedding
	// provider/model pair, and updates this object's own live property so
	// the change takes effect immediately -- called from ui/advanced.js's
	// "Batch size" row `set` callback instead of a plain direct assignment.
	saveAdvancedSetting(key, value) {
		this[key] = value;
		let pairKey = `${LLMInterfaces._embeddingProvider}:${LLMInterfaces._selectedEmbeddingModel[LLMInterfaces._embeddingProvider]}`;
		if (!this._advancedSettingsByPair[pairKey]) this._advancedSettingsByPair[pairKey] = {};
		this._advancedSettingsByPair[pairKey][key] = value;
		try {
			Zotero.Prefs.set(this._advancedSettingsPref, JSON.stringify(this._advancedSettingsByPair), true);
		}
		catch (e) {
			this.log(`saveAdvancedSetting: failed to persist ${key}: ${e.message}`);
		}
	},

	async getEmbeddingModel() {
		return LLMInterfaces.getCurrentEmbeddingModel();
	},

	// `model`/`provider`, if given, override the current selection -- see
	// LLMInterfaces.getEmbedding's own comment for why (re-embedding a query
	// against whatever an already-built index was actually embedded with,
	// not necessarily the user's current selection).
	async getEmbedding(text, model, provider) {
		return LLMInterfaces.getEmbedding(text, model, provider);
	},

	// Thin wrapper over LLMInterfaces.getEmbeddings, same rationale as
	// getEmbedding/getEmbeddingModel above.
	async getEmbeddings(texts, model, provider) {
		return LLMInterfaces.getEmbeddings(texts, model, provider);
	},

	// Embeds `texts` IN ORDER, splitting into `batchSize`-sized requests
	// (both embedding endpoints accept a batched `input` -- see
	// LLMInterfaces.getEmbeddings) and running up to `concurrency` of those
	// requests at once, rather than either one giant request or a fully
	// sequential one-at-a-time loop. `batchSize` is kept modest (not e.g.
	// hundreds) since different providers/models cap how many inputs (or
	// how many total tokens) a single request can hold, and this plugin
	// talks to several different backends (local and hosted) with no single
	// reliable limit to target. `onProgress(completed, total)`, if given, is
	// called after each batch finishes (not per-text -- batches can finish
	// out of order under concurrency, but `completed` only ever increases).
	async embedBatched(texts, model, provider, { batchSize = this.embedBatchSize, concurrency = 8, onProgress } = {}) {
		if (!texts.length) return [];
		let batches = [];
		for (let i = 0; i < texts.length; i += batchSize) {
			batches.push({ start: i, texts: texts.slice(i, i + batchSize) });
		}
		let results = new Array(texts.length);
		let completed = 0;
		let nextBatch = 0;
		let worker = async () => {
			while (nextBatch < batches.length) {
				let batch = batches[nextBatch++];
				let embeddings = await this.getEmbeddings(batch.texts, model, provider);
				for (let i = 0; i < embeddings.length; i++) {
					results[batch.start + i] = embeddings[i];
				}
				completed += embeddings.length;
				onProgress?.(completed, texts.length);
			}
		};
		await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, () => worker()));
		return results;
	},

	cosineSimilarity(a, b) {
		let dot = 0, normA = 0, normB = 0;
		for (let i = 0; i < a.length; i++) {
			dot += a[i] * b[i];
			normA += a[i] * a[i];
			normB += b[i] * b[i];
		}
		return dot / (Math.sqrt(normA) * Math.sqrt(normB));
	},
};
