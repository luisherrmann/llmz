LLMCitation = {
	maxCitationChunks: 1000,
	_citationIndexCache: new Map(),

	log(msg) {
		Zotero.debug("LLM Chat Pane [Citation]: " + msg);
	},

	splitIntoSentences(text) {
		return text
			.replace(/\s+/g, " ")
			.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
			.map(s => s.trim())
			.filter(s => s.length >= 20 && s.length <= 500)
			.slice(0, this.maxCitationChunks);
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

	async getEmbeddingModel() {
		let response = await Zotero.HTTP.request("GET", "http://127.0.0.1:11434/api/tags", {
			timeout: 10000,
		});
		let data = JSON.parse(response.responseText);
		let embedModel = (data.models || []).find(m => /embed/i.test(m.name))?.name;
		if (!embedModel) {
			throw new Error("No embedding model found. Pull one with `ollama pull nomic-embed-text`.");
		}
		return embedModel;
	},

	async getEmbedding(text, model) {
		this.log(`getEmbedding: model=${model} textLen=${text.length}`);
		let response = await fetch("http://127.0.0.1:11434/api/embed", {
			method: "POST",
			body: JSON.stringify({ model, input: text }),
			headers: { "Content-Type": "application/json" },
		});
		if (!response.ok) {
			let body = await response.text().catch(() => "(unreadable)");
			throw new Error(`Embedding request failed: HTTP ${response.status} — ${body}`);
		}
		let data = await response.json();
		return data.embeddings[0];
	},

	_textFingerprint(text) {
		return `${text.length}:${text.slice(0, 200)}`;
	},

	async _cacheDir() {
		let dir = PathUtils.join(Zotero.DataDirectory.dir, "llm-citation-cache");
		await IOUtils.makeDirectory(dir, { ignoreExisting: true });
		return dir;
	},

	async _loadDiskCache(item, fingerprint, model) {
		try {
			let path = PathUtils.join(await this._cacheDir(), `${item.id}.json`);
			if (!await IOUtils.exists(path)) return null;
			let raw = await IOUtils.readUTF8(path);
			let cached = JSON.parse(raw);
			if (cached.fingerprint !== fingerprint || cached.model !== model) return null;
			this.log(`_loadDiskCache: loaded ${cached.sentences.length} sentences for item ${item.id}`);
			return { sentences: cached.sentences, embeddings: cached.embeddings, model: cached.model };
		}
		catch (e) {
			this.log(`_loadDiskCache: failed for item ${item.id}: ${e.message}`);
			return null;
		}
	},

	async _saveDiskCache(item, fingerprint, index) {
		try {
			let path = PathUtils.join(await this._cacheDir(), `${item.id}.json`);
			await IOUtils.writeUTF8(path, JSON.stringify({
				fingerprint,
				model: index.model,
				sentences: index.sentences,
				embeddings: index.embeddings,
			}));
			this.log(`_saveDiskCache: saved ${index.sentences.length} sentences for item ${item.id}`);
		}
		catch (e) {
			this.log(`_saveDiskCache: failed for item ${item.id}: ${e.message}`);
		}
	},

	async getCitationIndex(item, text) {
		let cached = this._citationIndexCache.get(item.id);
		if (cached) return cached;

		let model = await this.getEmbeddingModel();
		let fingerprint = this._textFingerprint(text);

		let diskCached = await this._loadDiskCache(item, fingerprint, model);
		if (diskCached) {
			this._citationIndexCache.set(item.id, diskCached);
			return diskCached;
		}

		let sentences = this.splitIntoSentences(text);
		if (!sentences.length) return null;

		this.log(`getCitationIndex: embedding ${sentences.length} sentences with ${model}`);
		let embeddings = [];
		for (let sentence of sentences) {
			embeddings.push(await this.getEmbedding(sentence, model));
		}

		let index = { sentences, embeddings, model };
		this._citationIndexCache.set(item.id, index);
		await this._saveDiskCache(item, fingerprint, index);
		return index;
	},

	async groundCitations(text, index) {
		let pattern = /\[CITE\]\(<find:([^>]+)>\)/g;
		let matches = [...text.matchAll(pattern)];
		if (!matches.length) return text;

		let result = text;
		let counter = 1;
		for (let match of matches) {
			let [full, phrase] = match;
			let searchPhrase = phrase;
			if (index) {
				try {
					let queryEmbedding = await this.getEmbedding(phrase, index.model);
					let bestScore = -Infinity, bestIdx = -1;
					for (let i = 0; i < index.embeddings.length; i++) {
						let score = this.cosineSimilarity(queryEmbedding, index.embeddings[i]);
						if (score > bestScore) {
							bestScore = score;
							bestIdx = i;
						}
					}
					if (bestIdx >= 0) {
						searchPhrase = index.sentences[bestIdx].split(/\s+/).slice(0, 8).join(" ");
					}
				}
				catch (e) {
					this.log(`groundCitations: failed to ground "${phrase}": ${e.message}`);
				}
			}
			result = result.replace(full, () => `[${counter}](<find:${searchPhrase}>)`);
			counter++;
		}
		return result;
	},

	navigateToText(query) {
		if (!Zotero.Reader) return;
		let win = Zotero.getMainWindow();
		let selectedID = win?.Zotero_Tabs?.selectedID;
		if (!selectedID) return;
		let reader = Zotero.Reader.getByTabID(selectedID);
		if (!reader) return;
		let iwin = reader._iframeWindow;
		if (!iwin) return;
		let fc = iwin.wrappedJSObject?._reader?._primaryView?._findController;
		if (!fc) {
			this.log("navigateToText: _findController not found");
			return;
		}
		let params = Components.utils.cloneInto({
			type: "find",
			query,
			phraseSearch: true,
			caseSensitive: false,
			entireWord: false,
			highlightAll: false,
			findPrevious: false,
		}, iwin);
		fc.find(params);
	},
};
