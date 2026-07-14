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

	// Plain-text progress bar for a Logs entry (see llm/request.js's
	// onEmbeddingStart) -- e.g. "[████████░░░░░░░░░░░░] 42/120 (35%)". Just
	// arithmetic + two Unicode block characters, not worth pulling in a
	// library for. Shared with document/figures.js's own embedding loop.
	_formatProgressBar(current, total, width = 20) {
		let ratio = total > 0 ? current / total : 0;
		let filled = Math.round(ratio * width);
		let bar = "█".repeat(filled) + "░".repeat(width - filled);
		return `[${bar}] ${current}/${total} (${Math.round(ratio * 100)}%)`;
	},

	// Thin delegating wrappers over LLMEmbeddings (llm/embeddings.js), which owns
	// the actual embedding-provider dispatch, batching/concurrency, and
	// batch-size persistence -- kept here under their original names so
	// _getIndex/getRelevantChunks/groundCitations below, and every external
	// caller (document/tables.js, document/figures.js, llm/request.js,
	// semantic-history.js, ui/index-all.js), don't need to change a single
	// call site.
	async getEmbeddingModel() {
		return LLMEmbeddings.getEmbeddingModel();
	},

	async getEmbedding(text, model, provider) {
		return LLMEmbeddings.getEmbedding(text, model, provider);
	},

	async embedBatched(texts, model, provider, options) {
		return LLMEmbeddings.embedBatched(texts, model, provider, options);
	},

	async getEmbeddings(texts, model, provider) {
		return LLMEmbeddings.getEmbeddings(texts, model, provider);
	},

	cosineSimilarity(a, b) {
		return LLMEmbeddings.cosineSimilarity(a, b);
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
		let embeddings = await this.embedBatched(sentences, model, provider, {
			onProgress: (completed, total) => progress?.setProgress?.(completed, total),
		});
		if (progress) progress.textContent = `Recomputed ${embeddings.length} ${kind} embedding${embeddings.length === 1 ? "" : "s"} using ${provider} ${model}.`;

		let index = { sentences, embeddings, model, provider };
		this._citationIndexCache.set(cacheKey, index);
		await this._saveDiskCache(item, fingerprint, index, kind);
		return index;
	},

	// Sentence-level index, used ONLY as document/citations.js's
	// LLMCitationPosition.resolvePositions' embedding-based FALLBACK for a
	// citation phrase that its primary, fast, exact SDT-text match failed
	// to find -- a real paraphrase (not hallucinated, just not verbatim)
	// has no exact match to find no matter how the text is normalized, but
	// IS close in embedding space to the real sentence it's paraphrasing.
	// The matched sentence is then re-resolved through the same exact SDT
	// matcher (since it's real extracted text, that succeeds), so the
	// fallback still ends up with a real position, not just a plausible
	// sentence with nowhere to navigate to.
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

	// Cheap existence check (file presence only, no content read or
	// fingerprint/model/provider validation -- unlike _loadDiskCache's own
	// check) for ui/advanced.js's "library index status" bar under Cache.
	// Deliberately checks the SENTENCE index only, not paragraph (paragraph
	// is only ever built conditionally, for a PDF long enough to need
	// chunked context -- see ui/index-all.js's own _indexItem comment -- so
	// a short PDF with only a sentence index is still fully indexed for
	// RAG purposes). Also deliberately doesn't validate the cache is still
	// fresh for the CURRENTLY selected embedding provider/model: "has this
	// PDF ever been indexed" is a more useful/stable signal for a
	// library-wide readout than "is it valid right now," which would flip
	// for the whole library every time the user switches models.
	async hasCache(item) {
		let dir = await this._cacheDir();
		return IOUtils.exists(PathUtils.join(dir, `${item.id}-sentence.json`));
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

	// Numbers each [CITE](<find:phrase>) token in order -- [1], [2], etc,
	// per the system prompt's "numbering is assigned automatically". Used
	// to also try replacing `phrase` with the "nearest" sentence found by
	// embedding similarity against the whole document -- removed not
	// because those calls were sequential (that was a real cost too, but
	// batching via Promise.all would have fixed just the latency) but
	// because SDT-structure-based resolution (see document/citations.js's
	// LLMCitationPosition, used for BOTH navigation and verification, per
	// llm/request.js's synchronous resolvePositions call before rendering) is
	// a strictly better check to begin with: exact presence in the PDF's
	// real text rather than semantic similarity (which can be "close"
	// without the cited text actually being there), no network dependency
	// or API cost, and faster even batched. `phrase` itself is left
	// exactly as the model wrote it -- verification now happens downstream
	// of this function, not inside it.
	groundCitations(text) {
		// Lazy match up to the literal ">)" close, not just any bare ">" --
		// the citation phrase is copied verbatim from the PDF (per the system
		// prompt) and can itself contain a literal ">" (e.g. "values >20"),
		// which would otherwise terminate the match early and leave the
		// whole [CITE](<find:...>) token completely unmatched (silently
		// left as literal, un-grounded text). That alone isn't quite enough
		// though -- now that citations quote a full verbatim sentence (see
		// llm/prompt.js's citation format instructions), a phrase can also
		// contain the literal TWO-character sequence ">)" itself (e.g. "...
		// the effect (>)5 in most cases..."), which would truncate the
		// match at that false terminator instead of the real one. The
		// trailing lookahead requires whatever follows a candidate ">)" to
		// actually look like a token boundary (whitespace, sentence
		// punctuation, a new "[" link starting, or end of string) --
		// combined with the LAZY quantifier, the regex engine keeps
		// extending the match past any ">)" that ISN'T followed by such a
		// boundary (e.g. followed by a digit or letter continuing the
		// sentence) until it finds the real one. Same pattern (and same
		// reasoning) in llm/request.js's citation-position query extraction and
		// chat-pane.js's _renderMarkdown -- keep all three in sync.
		let pattern = /\[CITE\]\(<find:([\s\S]+?)>\)(?=[\s.,;:!?)\]]|\[|$)/g;
		let matches = [...text.matchAll(pattern)];
		if (!matches.length) return text;

		let result = text;
		let counter = 1;
		for (let match of matches) {
			let [full, phrase] = match;
			result = result.replace(full, () => `[${counter}](<find:${phrase}>)`);
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

	// Directly re-applies the reader's own highlight state (bypassing its
	// _highlightPosition wrapper method, not calling it) -- best-effort
	// reach into live reader internals, same pattern as
	// chat-pane.js's getReaderPageText/getReaderFullText. Silently
	// gives up if the reader's internal shape doesn't match what's
	// expected (e.g. a future Zotero version renames/restructures it).
	_reapplyHighlight(reader, position) {
		try {
			let view = reader._iframeWindow?.wrappedJSObject?._reader?._primaryView;
			if (!view) return;
			view._highlightedPosition = position;
			view._render();
		}
		catch (e) {
			this.log(`_reapplyHighlight failed: ${e.message}`);
		}
	},

	// Navigates to (and briefly highlights) a specific region on a page, given
	// a position in the reader's native format: { pageIndex, rects: [[x0,y0,x1,y1]] }
	// in bottom-up PDF space. Used for figures/tables, where we already know the
	// exact region from extraction — more precise than navigateToText's caption
	// search, and works regardless of whether the PDF has named destinations.
	//
	// The highlight itself is the reader's own transient flash (pdf-view.js's
	// _highlightPosition, hardcoded ~2s, no public way to reconfigure or make
	// persistent -- tried both, see git history if revisiting this). Its
	// visible duration is inconsistent on its own though: reader.navigate()
	// starts that flash's 2s timer immediately, but the SCROLL to the target
	// page (especially a distant one) can itself take a noticeable, variable
	// amount of time to finish rendering, eating into the same 2s window
	// before the user can actually see anything -- so a citation far from
	// the current page can flash for well under 2s. Re-applying the
	// highlight once more, timed to land just after the reader's own
	// auto-clear fires, gives a full-length flash AFTER scrolling has
	// settled instead. This second flash isn't truly persistent (something
	// in the reader's own render cycle eventually clears it too, just not
	// on a fixed schedule we can predict) but is consistently visible for
	// the full ~2s, which is what actually matters here.
	async navigateToPosition(position) {
		if (!Zotero.Reader || !position) return;
		let win = Zotero.getMainWindow();
		let selectedID = win?.Zotero_Tabs?.selectedID;
		if (!selectedID) return;
		let reader = Zotero.Reader.getByTabID(selectedID);
		if (!reader) return;
		await reader.navigate({ position });
		// 50ms past the reader's own uncancellable 2000ms auto-clear --
		// enough margin to reliably land after it fires without an
		// unnecessarily long gap.
		setTimeout(() => this._reapplyHighlight(reader, position), 2050);
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
