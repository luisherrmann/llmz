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

	// Plain-text progress bar for a Logs entry (see request.js's
	// onEmbeddingStart) -- e.g. "[████████░░░░░░░░░░░░] 42/120 (35%)". Just
	// arithmetic + two Unicode block characters, not worth pulling in a
	// library for. Shared with document/figures.js's own embedding loop.
	_formatProgressBar(current, total, width = 20) {
		let ratio = total > 0 ? current / total : 0;
		let filled = Math.round(ratio * width);
		let bar = "█".repeat(filled) + "░".repeat(width - filled);
		return `[${bar}] ${current}/${total} (${Math.round(ratio * 100)}%)`;
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

	// Thin wrappers over LLMInterfaces' own embedding-provider dispatch (see
	// its own comments) -- this module owns citation-index building/caching
	// and cosine-similarity search, not provider/model selection itself
	// (that's shared with ui/advanced.js's Embeddings section). Kept as
	// methods here (rather than every call site below switching to
	// LLMInterfaces directly) so _getIndex/getRelevantChunks/groundCitations
	// don't need to change their own call shape.
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

	_textFingerprint(text) {
		return `${text.length}:${text.slice(0, 200)}`;
	},

	async _cacheDir() {
		let dir = PathUtils.join(Zotero.DataDirectory.dir, "LLMz", "cache", "citation");
		await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
		return dir;
	},

	// `provider` is checked alongside `model` -- a stale cache built under a
	// DIFFERENT embedding provider (but coincidentally the same model name)
	// must still be invalidated, since embeddings from two different
	// providers/backends aren't comparable via cosine similarity even if
	// the model name happens to match (see _getIndex's own comment).
	async _loadDiskCache(item, fingerprint, model, provider, kind) {
		try {
			let path = PathUtils.join(await this._cacheDir(), `${item.id}-${kind}.json`);
			if (!await IOUtils.exists(path)) return null;
			let raw = await IOUtils.readUTF8(path);
			let cached = JSON.parse(raw);
			if (cached.fingerprint !== fingerprint || cached.model !== model || cached.provider !== provider) return null;
			this.log(`_loadDiskCache(${kind}): loaded ${cached.sentences.length} chunks for item ${item.id}`);
			return { sentences: cached.sentences, embeddings: cached.embeddings, model: cached.model, provider: cached.provider };
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
				provider: index.provider,
				sentences: index.sentences,
				embeddings: index.embeddings,
			}));
			this.log(`_saveDiskCache(${kind}): saved ${index.sentences.length} chunks for item ${item.id}`);
		}
		catch (e) {
			this.log(`_saveDiskCache(${kind}): failed for item ${item.id}: ${e.message}`);
		}
	},

	// `onEmbeddingStart(provider, model)`, if given, is called ONLY when a
	// cache miss/staleness (see _loadDiskCache) actually forces a real
	// recompute -- not on every call -- and may return a value (e.g. a Logs
	// entry's content element) that gets passed to onEmbeddingDone below so
	// the caller can update the SAME message in place with a completion
	// line, rather than the two ever appearing as separate messages.
	async _getIndex(item, text, kind, chunkFn, onEmbeddingStart) {
		let cacheKey = `${item.id}:${kind}`;

		// Captured alongside the model, not just the model name alone --
		// see _loadDiskCache's own comment. Resolved BEFORE the memory-cache
		// check below (not just passed to _loadDiskCache further down) --
		// switching provider/model mid-session must invalidate an
		// already-loaded memory-cached index too, since that check would
		// otherwise never even run (the disk cache is only consulted on a
		// memory-cache MISS).
		let provider = LLMInterfaces._embeddingProvider;
		let model = await this.getEmbeddingModel();

		let cached = this._citationIndexCache.get(cacheKey);
		if (cached && cached.provider === provider && cached.model === model) return cached;

		let fingerprint = this._textFingerprint(text);

		let diskCached = await this._loadDiskCache(item, fingerprint, model, provider, kind);
		if (diskCached) {
			this._citationIndexCache.set(cacheKey, diskCached);
			return diskCached;
		}

		let sentences = chunkFn(text);
		if (!sentences.length) return null;

		let progress = onEmbeddingStart?.(provider, model);
		this.log(`_getIndex(${kind}): embedding ${sentences.length} chunks with ${provider}/${model}`);
		let embeddings = [];
		for (let i = 0; i < sentences.length; i++) {
			embeddings.push(await this.getEmbedding(sentences[i], model, provider));
			progress?.setProgress?.(i + 1, sentences.length);
		}
		if (progress) progress.textContent = `Recomputed ${embeddings.length} ${kind} embedding${embeddings.length === 1 ? "" : "s"} using ${provider} ${model}.`;

		let index = { sentences, embeddings, model, provider };
		this._citationIndexCache.set(cacheKey, index);
		await this._saveDiskCache(item, fingerprint, index, kind);
		return index;
	},

	async getCitationIndex(item, text, onEmbeddingStart) {
		return this._getIndex(item, text, "sentence", t => this.splitIntoSentences(t), onEmbeddingStart);
	},

	async getParagraphIndex(item, text, onEmbeddingStart) {
		return this._getIndex(item, text, "paragraph", t => this.splitIntoParagraphs(t), onEmbeddingStart);
	},

	// Debug affordance ("Clear Cache" in Advanced) -- drops both the memory
	// and disk cache (sentence AND paragraph indices -- see _getIndex's
	// `kind`) for this item, so the next getCitationIndex/getParagraphIndex
	// call re-embeds from scratch rather than reusing a possibly-stale
	// result. Same pattern as document/tables.js's clearCache etc., except
	// this module caches two files per item (one per `kind`), not one.
	async clearCache(item) {
		this._citationIndexCache.delete(`${item.id}:sentence`);
		this._citationIndexCache.delete(`${item.id}:paragraph`);
		try {
			let dir = await this._cacheDir();
			await IOUtils.remove(PathUtils.join(dir, `${item.id}-sentence.json`), { ignoreAbsent: true });
			await IOUtils.remove(PathUtils.join(dir, `${item.id}-paragraph.json`), { ignoreAbsent: true });
			this.log(`clearCache: cleared for item ${item.id}`);
		}
		catch (e) {
			this.log(`clearCache: failed: ${e.message}`);
		}
	},

	async getRelevantChunks(index, query, topK) {
		let queryEmbedding = await this.getEmbedding(query, index.model, index.provider);
		let scored = index.embeddings.map((embedding, i) => ({
			i,
			score: this.cosineSimilarity(queryEmbedding, embedding),
		}));
		scored.sort((a, b) => b.score - a.score);
		let top = scored.slice(0, topK).sort((a, b) => a.i - b.i);
		return top.map(({ i }) => index.sentences[i]);
	},

	async groundCitations(text, index) {
		// Lazy match up to the literal ">)" close, not just any bare ">" --
		// the citation phrase is copied verbatim from the PDF (per the system
		// prompt) and can itself contain a literal ">" (e.g. "values >20"),
		// which would otherwise terminate the match early and leave the
		// whole [CITE](<find:...>) token completely unmatched (silently
		// left as literal, un-grounded text) -- see llm-chat-pane.js's
		// _renderMarkdown for the matching fix on the other regex that
		// processes this same token format downstream.
		let pattern = /\[CITE\]\(<find:([\s\S]+?)>\)/g;
		let matches = [...text.matchAll(pattern)];
		if (!matches.length) return text;

		let result = text;
		let counter = 1;
		for (let match of matches) {
			let [full, phrase] = match;
			let searchPhrase = phrase;
			if (index) {
				try {
					let queryEmbedding = await this.getEmbedding(phrase, index.model, index.provider);
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

	// Scrolls to a specific page, given `pageNum` in the same 1-based
	// physical-page-number convention used elsewhere in this plugin (e.g.
	// getReaderPageText's pageNum, from PDFViewerApplication.page) --
	// navigate({ pageIndex }) (0-based) is used rather than navigate({
	// pageNumber }), which reader.js's pdf-view.js first tries to match
	// against the PDF's own PRINTED page labels (e.g. roman numerals, or an
	// offset from front matter) before falling back to a physical index --
	// that could silently jump to the wrong page if a label happens to
	// string-match the number. pageIndex is unambiguous: always the Nth
	// physical page.
	async navigateToPage(pageNum) {
		if (!Zotero.Reader || !pageNum) return;
		let win = Zotero.getMainWindow();
		let selectedID = win?.Zotero_Tabs?.selectedID;
		if (!selectedID) return;
		let reader = Zotero.Reader.getByTabID(selectedID);
		if (!reader) return;
		await reader.navigate({ pageIndex: pageNum - 1 });
	},
};
