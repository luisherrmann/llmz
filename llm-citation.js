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

	splitIntoParagraphs(text, sentencesPerParagraph = 5) {
		let sentences = this.splitIntoSentences(text);
		let paragraphs = [];
		for (let i = 0; i < sentences.length; i += sentencesPerParagraph) {
			paragraphs.push(sentences.slice(i, i + sentencesPerParagraph).join(" "));
		}
		return paragraphs;
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

	async _loadDiskCache(item, fingerprint, model, kind) {
		try {
			let path = PathUtils.join(await this._cacheDir(), `${item.id}-${kind}.json`);
			if (!await IOUtils.exists(path)) return null;
			let raw = await IOUtils.readUTF8(path);
			let cached = JSON.parse(raw);
			if (cached.fingerprint !== fingerprint || cached.model !== model) return null;
			this.log(`_loadDiskCache(${kind}): loaded ${cached.sentences.length} chunks for item ${item.id}`);
			return { sentences: cached.sentences, embeddings: cached.embeddings, model: cached.model };
		}
		catch (e) {
			this.log(`_loadDiskCache(${kind}): failed for item ${item.id}: ${e.message}`);
			return null;
		}
	},

	async _saveDiskCache(item, fingerprint, index, kind) {
		try {
			let path = PathUtils.join(await this._cacheDir(), `${item.id}-${kind}.json`);
			await IOUtils.writeUTF8(path, JSON.stringify({
				fingerprint,
				model: index.model,
				sentences: index.sentences,
				embeddings: index.embeddings,
			}));
			this.log(`_saveDiskCache(${kind}): saved ${index.sentences.length} chunks for item ${item.id}`);
		}
		catch (e) {
			this.log(`_saveDiskCache(${kind}): failed for item ${item.id}: ${e.message}`);
		}
	},

	async _getIndex(item, text, kind, chunkFn) {
		let cacheKey = `${item.id}:${kind}`;
		let cached = this._citationIndexCache.get(cacheKey);
		if (cached) return cached;

		let model = await this.getEmbeddingModel();
		let fingerprint = this._textFingerprint(text);

		let diskCached = await this._loadDiskCache(item, fingerprint, model, kind);
		if (diskCached) {
			this._citationIndexCache.set(cacheKey, diskCached);
			return diskCached;
		}

		let sentences = chunkFn(text);
		if (!sentences.length) return null;

		this.log(`_getIndex(${kind}): embedding ${sentences.length} chunks with ${model}`);
		let embeddings = [];
		for (let sentence of sentences) {
			embeddings.push(await this.getEmbedding(sentence, model));
		}

		let index = { sentences, embeddings, model };
		this._citationIndexCache.set(cacheKey, index);
		await this._saveDiskCache(item, fingerprint, index, kind);
		return index;
	},

	async getCitationIndex(item, text) {
		return this._getIndex(item, text, "sentence", t => this.splitIntoSentences(t));
	},

	async getParagraphIndex(item, text) {
		return this._getIndex(item, text, "paragraph", t => this.splitIntoParagraphs(t));
	},

	async getRelevantChunks(index, query, topK) {
		let queryEmbedding = await this.getEmbedding(query, index.model);
		let scored = index.embeddings.map((embedding, i) => ({
			i,
			score: this.cosineSimilarity(queryEmbedding, embedding),
		}));
		scored.sort((a, b) => b.score - a.score);
		let top = scored.slice(0, topK).sort((a, b) => a.i - b.i);
		return top.map(({ i }) => index.sentences[i]);
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
						searchPhrase = index.sentences[bestIdx];
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

	// Navigates to (and briefly highlights) a specific region on a page, given
	// a position in the reader's native format: { pageIndex, rects: [[x0,y0,x1,y1]] }
	// in bottom-up PDF space. Used for figures/tables, where we already know the
	// exact region from extraction — more precise than navigateToText's caption
	// search, and works regardless of whether the PDF has named destinations.
	async navigateToPosition(position) {
		if (!Zotero.Reader || !position) return;
		let win = Zotero.getMainWindow();
		let selectedID = win?.Zotero_Tabs?.selectedID;
		if (!selectedID) return;
		let reader = Zotero.Reader.getByTabID(selectedID);
		if (!reader) return;
		await reader.navigate({ position });
	},

	// Like navigateToPosition, but for an annotation specifically (`key` is
	// the Zotero item key, e.g. from LLMNotes.formatAnnotation()'s
	// `item.key`) -- navigate({ annotationID }) is reader.js's own mechanism
	// for "select the annotation instead of just scrolling to a position"
	// (see reader/src/common/reader.js's navigate(): "Select the annotation
	// instead of just navigating when navigation is triggered externally"),
	// so this reproduces exactly what clicking the annotation in the reader
	// itself does -- scroll AND select/highlight it, not just scroll.
	async navigateToAnnotation(key) {
		if (!Zotero.Reader || !key) return;
		let win = Zotero.getMainWindow();
		let selectedID = win?.Zotero_Tabs?.selectedID;
		if (!selectedID) return;
		let reader = Zotero.Reader.getByTabID(selectedID);
		if (!reader) return;
		await reader.navigate({ annotationID: key });
	},
};
