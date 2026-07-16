LLMCitation = {
	maxCitationChunks: 1000,
	_indexCache: new Map(), // item.id -> { sentences, paragraphs, model, provider }

	log(msg) {
		Zotero.debug("LLM Chat Pane [Citation]: " + msg);
	},

	// Layers this module's OWN length filter (20-500 chars, tuned for
	// standalone citation-chunk selection) and count cap on top of
	// LLMPatterns.splitSentences' shared raw boundary-split (see
	// scripts/shared-patterns.js) -- a caller that wants the literal
	// sentence adjacent to something, unfiltered, should call
	// LLMPatterns.splitSentences directly instead (see e.g.
	// scripts/extract_equations.js's own equation-context extraction).
	splitIntoSentences(text) {
		return LLMPatterns.splitSentences(text)
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
	// getTextIndex/getRelevantChunks/groundCitations below, and every external
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
		let dir = PathUtils.join(Zotero.DataDirectory.dir, "LLMz", "cache", "text");
		await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
		return dir;
	},

	// Fingerprint is the ONLY staleness check needed here -- unlike the old
	// per-kind cache files, this joint file carries no `model`/`provider`
	// fields at all (see _saveDiskCache below): the chunk TEXT itself
	// doesn't depend on which embedding model/provider is active, only the
	// EMBEDDINGS do, and those live solely in the embeddings DB (one .sqlite
	// file per model under LLMz/cache/embeddings/, see embeddings-db.js) --
	// see getTextIndex's own hasEmbeddings check for that half. The cache
	// file also carries no `embeddings` field -- the embeddings DB
	// is the sole store for the actual vectors now that retrieval
	// (getRelevantChunks/getNearestSentences) only ever queries the DB,
	// never reads them back off a loaded disk cache.
	async _loadDiskCache(item, fingerprint) {
		try {
			let path = PathUtils.join(await this._cacheDir(), `${item.id}.json`);
			if (!await IOUtils.exists(path)) return null;
			let cached = JSON.parse(await IOUtils.readUTF8(path));
			if (cached.fingerprint !== fingerprint) return null;
			this.log(`_loadDiskCache: loaded ${cached.sentences.length} sentences, ${cached.paragraphs.length} paragraphs for item ${item.id}`);
			return { sentences: cached.sentences, paragraphs: cached.paragraphs };
		}
		catch (e) {
			this.log(`_loadDiskCache: failed for item ${item.id}: ${e.message}`);
			return null;
		}
	},

	async _saveDiskCache(item, fingerprint, sentences, paragraphs) {
		try {
			let path = PathUtils.join(await this._cacheDir(), `${item.id}.json`);
			await IOUtils.writeUTF8(path, JSON.stringify({ fingerprint, sentences, paragraphs }, null, 2));
			this.log(`_saveDiskCache: saved ${sentences.length} sentences, ${paragraphs.length} paragraphs for item ${item.id}`);
		}
		catch (e) {
			this.log(`_saveDiskCache: failed for item ${item.id}: ${e.message}`);
		}
	},

	// Builds (or returns an already-cached) combined sentence+paragraph text
	// index for `item` -- both kinds are always built, disk-cached, and
	// embedded TOGETHER in one pass, never independently. Previously,
	// getCitationIndex/getParagraphIndex each drove their own separate
	// per-kind build/cache/DB-sync, which meant a caller that only ever
	// needed one kind (e.g. document/citations.js's resolvePositions
	// fallback, sentence-only) would silently leave the OTHER kind unbuilt
	// -- which mattered concretely for getCrossLibraryChunks below, since it
	// only ever searches source:"paragraph" embeddings: a paper short enough
	// to never need its OWN paragraph-chunked context (see llm/prompt.js's
	// buildPromptWithActivePDFContext) still needs one for cross-library
	// search to ever find it, so ui/index-all.js's _indexItem ended up
	// manually calling both anyway. Building both here unconditionally, in
	// one call, removes the need for callers to remember that -- and halves
	// the number of embedBatched round trips a paper needing both otherwise
	// pays.
	//
	// getCitationIndex/getParagraphIndex below are thin views over this,
	// each returning just their own half in the {sentences, model, provider,
	// paperId, source} shape retrieval (getRelevantChunks/getNearestSentences)
	// already expects -- unchanged from before, so neither of those, nor any
	// other caller, needed to change.
	//
	// Whether the DB already has this paper's embeddings for EACH kind is
	// checked via a cheap COUNT(*) (hasEmbeddings) against the plain
	// `embeddings` table, NOT a fetch of the vectors themselves -- fetching
	// every vector by rowid turned out to be very slow against a model's
	// own embeddings file once it's accumulated enough delete/reinsert churn
	// (see replaceForPaper's own comment) to fragment sqlite-vec's chunked
	// storage, which a plain COUNT(*) never touches. A count mismatch on
	// EITHER kind (no rows yet, or a failed previous sync) rebuilds BOTH --
	// keeping this always-both invariant means there's never a partial
	// "sentences embedded, paragraphs not" state to reason about.
	//
	// `onEmbeddingStart(provider, model)`, if given, is called ONLY when a
	// cache miss/staleness actually forces a real recompute -- not on every
	// call -- and may return a value (e.g. a Logs entry's content element)
	// that gets passed to onEmbeddingDone below so the caller can update the
	// SAME message in place with a completion line, rather than the two
	// ever appearing as separate messages.
	async getTextIndex(item, text, onEmbeddingStart, onMessage) {
		// Resolved BEFORE the memory-cache check below (not just passed to
		// _loadDiskCache further down) -- switching provider/model
		// mid-session must invalidate an already-loaded memory-cached index
		// too, since disk/DB checks further down are only ever consulted on
		// a memory-cache MISS.
		let provider = LLMInterfaces._embeddingProvider;
		let model = await this.getEmbeddingModel();

		let cached = this._indexCache.get(item.id);
		if (cached && cached.provider === provider && cached.model === model) return cached;

		let fingerprint = this._textFingerprint(text);

		let diskCached = await this._loadDiskCache(item, fingerprint);
		let sentences = diskCached ? diskCached.sentences : this.splitIntoSentences(text);
		let paragraphs = diskCached ? diskCached.paragraphs : this.splitIntoParagraphs(text);
		if (!sentences.length) return null;

		let [sentenceDbCount, paragraphDbCount] = await Promise.all([
			LLMEmbeddingsDB.hasEmbeddings(item.id, model, { source: "sentence" }).then(r => r.count).catch((e) => {
				this.log(`getTextIndex: DB lookup failed (sentence) for item ${item.id}: ${e.message}`);
				return 0;
			}),
			LLMEmbeddingsDB.hasEmbeddings(item.id, model, { source: "paragraph" }).then(r => r.count).catch((e) => {
				this.log(`getTextIndex: DB lookup failed (paragraph) for item ${item.id}: ${e.message}`);
				return 0;
			}),
		]);

		if (sentenceDbCount === sentences.length && paragraphDbCount === paragraphs.length) {
			let index = { sentences, paragraphs, model, provider };
			this._indexCache.set(item.id, index);
			// The DB already has everything needed for retrieval, but if the
			// disk cache is what's actually MISSING here (e.g. a failed prior
			// write, or a JSON file deleted/moved outside this plugin), this
			// is the only remaining place that would ever rewrite it. Without
			// this, hasCache() (Library Index Status) and _loadParagraphs
			// (cross-library retrieval's text lookup) silently keep treating
			// this paper as unindexed forever, even though the embeddings DB
			// has full embeddings for it -- confirmed concretely once (see
			// git history): a paper whose text/ disk cache was gone still had
			// matching sentence/paragraph rows in the DB from an earlier run,
			// and every subsequent "Index" click took this shortcut without
			// ever restoring the JSON file.
			if (!diskCached) {
				await this._saveDiskCache(item, fingerprint, sentences, paragraphs);
			}
			this.log(`getTextIndex: found ${sentenceDbCount} sentence / ${paragraphDbCount} paragraph embeddings in the embeddings DB for item ${item.id}`);
			return index;
		}

		let progress = onEmbeddingStart?.(provider, model);
		let total = sentences.length + paragraphs.length;
		this.log(`getTextIndex: embedding ${sentences.length} sentences + ${paragraphs.length} paragraphs with ${provider}/${model}`);
		// Two sequential embedBatched calls (not one merged array) -- keeps
		// each kind's own chunk-to-embedding correspondence trivial to zip
		// back together below, and `total`/the running offset here give a
		// single combined 0..total progress readout across both phases
		// rather than two separate bars.
		let sentenceEmbeddings = await this.embedBatched(sentences, model, provider, {
			onProgress: completed => progress?.setProgress?.(completed, total),
		});
		let paragraphEmbeddings = await this.embedBatched(paragraphs, model, provider, {
			onProgress: completed => progress?.setProgress?.(sentences.length + completed, total),
		});
		let embeddedCount = sentenceEmbeddings.length + paragraphEmbeddings.length;
		if (progress) progress.textContent = `Recomputed ${sentenceEmbeddings.length} sentence and ${paragraphEmbeddings.length} paragraph embedding${embeddedCount === 1 ? "" : "s"} using ${provider} ${model}.`;

		let index = { sentences, paragraphs, model, provider };
		this._indexCache.set(item.id, index);
		await this._saveDiskCache(item, fingerprint, sentences, paragraphs);
		try {
			await LLMEmbeddingsDB.replaceForPaper(item.id, model, "sentence", sentences.map((s, i) => ({ sourceId: i, embedding: sentenceEmbeddings[i] })));
			await LLMEmbeddingsDB.replaceForPaper(item.id, model, "paragraph", paragraphs.map((p, i) => ({ sourceId: i, embedding: paragraphEmbeddings[i] })));
			onMessage?.(`Synced ${sentenceEmbeddings.length} sentence and ${paragraphEmbeddings.length} paragraph embedding${embeddedCount === 1 ? "" : "s"} to the embeddings DB for item ${item.id}.`);
		}
		catch (e) {
			this.log(`getTextIndex: failed to sync to embeddings DB: ${e.message}`);
			onMessage?.(`Failed to sync sentence/paragraph embeddings to the embeddings DB for item ${item.id}: ${e.message}`);
		}
		return index;
	},

	// Sentence-level view over getTextIndex, used ONLY as document/citations.js's
	// LLMCitationPosition.resolvePositions' embedding-based FALLBACK for a
	// citation phrase that its primary, fast, exact SDT-text match failed
	// to find -- a real paraphrase (not hallucinated, just not verbatim)
	// has no exact match to find no matter how the text is normalized, but
	// IS close in embedding space to the real sentence it's paraphrasing.
	// The matched sentence is then re-resolved through the same exact SDT
	// matcher (since it's real extracted text, that succeeds), so the
	// fallback still ends up with a real position, not just a plausible
	// sentence with nowhere to navigate to.
	async getCitationIndex(item, text, onEmbeddingStart, onMessage) {
		let index = await this.getTextIndex(item, text, onEmbeddingStart, onMessage);
		if (!index) return null;
		return { sentences: index.sentences, model: index.model, provider: index.provider, paperId: item.id, source: "sentence" };
	},

	// Paragraph-level view over getTextIndex, used by llm/prompt.js's
	// buildPromptWithActivePDFContext for a PDF too long to fit whole.
	async getParagraphIndex(item, text, onEmbeddingStart, onMessage) {
		let index = await this.getTextIndex(item, text, onEmbeddingStart, onMessage);
		if (!index) return null;
		return { sentences: index.paragraphs, model: index.model, provider: index.provider, paperId: item.id, source: "paragraph" };
	},

	// Debug affordance ("Clear Cache" in Advanced, under the "Text"
	// checkbox) -- drops the memory cache, the joint disk cache file, AND
	// both embeddings sources for this item UNDER THE CURRENTLY SELECTED
	// embedding model, so the next getTextIndex call actually re-embeds
	// from scratch rather than reusing a possibly-stale result. Scoped to
	// the current model only (one .sqlite file per model now, see
	// embeddings-db.js's own header comment) -- a paper's embeddings under
	// some PREVIOUSLY used model, if any, are simply left in that model's
	// own file untouched; Clear Cache is about resetting what you're
	// CURRENTLY working with, not hunting down every model ever used.
	// Without the DB half of this, getTextIndex's own DB-count shortcut
	// (see its comment) would find the current model's file still fully
	// populated on the very next Index click and skip re-embedding
	// entirely -- Clear Cache would only ever delete the JSON, never force
	// an actual recompute (confirmed concretely: this is what left a
	// paper's text/ disk cache permanently missing despite the DB already
	// having full sentence/paragraph rows for it).
	async clearCache(item) {
		this._indexCache.delete(item.id);
		try {
			let dir = await this._cacheDir();
			await IOUtils.remove(PathUtils.join(dir, `${item.id}.json`), { ignoreAbsent: true });
			let model = await this.getEmbeddingModel();
			await LLMEmbeddingsDB.deleteForPaper(item.id, model, { source: "sentence" });
			await LLMEmbeddingsDB.deleteForPaper(item.id, model, { source: "paragraph" });
			this.log(`clearCache: cleared for item ${item.id}`);
		}
		catch (e) {
			this.log(`clearCache: failed: ${e.message}`);
		}
	},

	// Cheap existence check (file presence only, no content read or
	// fingerprint/model/provider validation -- unlike _loadDiskCache's own
	// check) for ui/advanced.js's "library index status" bar under Cache
	// ("Text" checkbox/section). One joint file now covers both sentence and
	// paragraph chunks together (see getTextIndex/_saveDiskCache), so its
	// mere presence is enough to tell whether this paper has ever been
	// indexed for RAG purposes at all. Also deliberately doesn't validate
	// the cache is still fresh for the CURRENTLY selected embedding
	// provider/model: "has this PDF ever been indexed" is a more useful/
	// stable signal for a library-wide readout than "is it valid right
	// now," which would flip for the whole library every time the user
	// switches models.
	async hasCache(item) {
		let dir = await this._cacheDir();
		return IOUtils.exists(PathUtils.join(dir, `${item.id}.json`));
	},

	// Ranks via a direct sqlite-vec MATCH query against the embeddings DB
	// (LLMEmbeddingsDB.query) rather than pulling every paragraph's
	// embedding into JS and scanning cosineSimilarity over all of them --
	// `index` (from getParagraphIndex) carries no embeddings array of its
	// own precisely so this is the only ranking path. `query()` returns
	// nearest-first; re-sorted back to original paragraph order (`sourceId`
	// ascending) here so the joined chunks read in document order, same as
	// the old JS-side top.sort((a, b) => a.i - b.i) did.
	async getRelevantChunks(index, query, topK) {
		let queryEmbedding = await this.getEmbedding(query, index.model, index.provider);
		let results = await LLMEmbeddingsDB.query(index.model, queryEmbedding, topK, {
			paperId: index.paperId,
			source: index.source,
		});
		return results
			.sort((a, b) => a.sourceId - b.sourceId)
			.map(r => index.sentences[r.sourceId]);
	},

	// Batched counterpart to getRelevantChunks above, for document/
	// citations.js's resolvePositions embedding fallback -- that caller
	// needs the single nearest sentence (top-1, not a top-K join) for EACH
	// of potentially several unresolved citation queries in one turn, so
	// this takes an ARRAY of already-computed query embeddings (batched via
	// embedBatched by the caller, same as before this moved to the DB) and
	// resolves all of them in one LLMEmbeddingsDB.queryBatch round trip --
	// one db.py subprocess invocation total, not one per unresolved
	// citation (see queryBatch's own comment for why that's the part worth
	// batching: sqlite-vec's MATCH itself takes one query vector at a time
	// either way, but the subprocess's own fixed startup cost does not need
	// to be paid per query). A falsy entry in `queryEmbeddings` (embedBatched
	// can fail for an individual text) is skipped rather than sent to the
	// DB, same as the caller's own old `if (!queryEmbedding) continue`
	// check before this moved here. Returns one sentence string (or null,
	// for a skipped/no-match query) per entry in `queryEmbeddings`, same
	// order/length.
	async getNearestSentences(index, queryEmbeddings) {
		let validIndices = [];
		let queries = [];
		queryEmbeddings.forEach((embedding, i) => {
			if (!embedding) return;
			validIndices.push(i);
			queries.push({ embedding, topK: 1, paperId: index.paperId, source: index.source });
		});
		let sentences = new Array(queryEmbeddings.length).fill(null);
		if (!queries.length) return sentences;
		let results = await LLMEmbeddingsDB.queryBatch(index.model, queries);
		results.forEach((rows, qi) => {
			let best = rows[0];
			if (best) sentences[validIndices[qi]] = index.sentences[best.sourceId];
		});
		return sentences;
	},

	// Reads just the `paragraphs` field of ANOTHER paper's joint text disk
	// cache -- none of getTextIndex's fingerprint/staleness machinery, since
	// that requires the paper's freshly-extracted full text, which
	// getCrossLibraryChunks below has no reason to re-extract for every
	// candidate paper it might cite. A cross-library chunk is supplementary
	// context, not the primary paper, so a missing/unreadable cache entry
	// (e.g. a paper indexed before this cache existed, or one whose text
	// changed since) is just skipped by the caller rather than triggering a
	// recompute.
	async _loadParagraphs(paperId) {
		try {
			let path = PathUtils.join(await this._cacheDir(), `${paperId}.json`);
			if (!await IOUtils.exists(path)) return null;
			let raw = await IOUtils.readUTF8(path);
			return JSON.parse(raw).paragraphs || null;
		}
		catch (e) {
			this.log(`_loadParagraphs: failed for paper ${paperId}: ${e.message}`);
			return null;
		}
	},

	// Same institutional-vs-personal-name handling as export.js's own
	// _formatCreatorName -- duplicated rather than shared since it's three
	// lines and pulling in a whole other module for it isn't worth it.
	_formatCreatorName(creator) {
		if (creator.name) return creator.name;
		return [creator.firstName, creator.lastName].filter(Boolean).join(" ");
	},

	// Cross-library retrieval for llm/prompt.js's <CROSS_LIBRARY_CONTEXT> --
	// ranks paragraphs from EVERY OTHER paper in the library (excludePaperId
	// is always the currently active PDF) against `query`, via the same
	// sqlite-vec MATCH path getRelevantChunks uses above, then resolves each
	// hit's paper_id back to that paper's own paragraph text (its disk
	// cache -- see _loadParagraphs) and Zotero metadata. `paperId`
	// here is always a PDF ATTACHMENT's item.id, same as everywhere else in
	// this file -- its own title/creator fields are usually just generic
	// translator-assigned values, not the real paper's, so metadata is read
	// from the PARENT item instead (same `item.parentItem || item` pattern
	// as export.js's own paperItem).
	//
	// Returned already ranked nearest-first (unlike getRelevantChunks, which
	// re-sorts back to paragraph position order -- that only makes sense
	// within a SINGLE paper's own paragraph sequence; across different
	// papers there's no shared position to sort by, so relevance rank is
	// the only meaningful order here). Silently skips any hit whose paper no
	// longer exists in the library, or whose paragraph cache is missing/
	// unreadable -- both are exactly the kind of stale state a
	// supplementary cross-library chunk should just drop, not fail the
	// whole request over -- so the returned list can be shorter than topK.
	async getCrossLibraryChunks(query, model, provider, topK, excludePaperId) {
		let queryEmbedding = await this.getEmbedding(query, model, provider);
		let results = await LLMEmbeddingsDB.query(model, queryEmbedding, topK, {
			source: "paragraph",
			excludePaperId,
		});

		let chunks = [];
		let sentencesByPaperId = new Map();
		for (let result of results) {
			let sentences = sentencesByPaperId.get(result.paperId);
			if (sentences === undefined) {
				sentences = await this._loadParagraphs(result.paperId);
				sentencesByPaperId.set(result.paperId, sentences);
			}
			let text = sentences?.[result.sourceId];
			if (!text) continue;

			let attachment = Zotero.Items.get(result.paperId);
			if (!attachment) continue;
			let paperItem = attachment.parentItem || attachment;
			let title = paperItem.getField("title") || paperItem.libraryKey;
			let authors = paperItem.getCreatorsJSON().map(c => this._formatCreatorName(c)).filter(Boolean).join(", ");

			chunks.push({ paperId: result.paperId, title, authors, text });
		}
		return chunks;
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

	// Opens a DIFFERENT paper (not the one in the current reader tab) --
	// used for cross-library citation links (see chat-pane.js's
	// _renderMarkdown, ref:library:PAPER_ID) so a paper the model pulled
	// into <CROSS_LIBRARY_CONTEXT> (see getCrossLibraryChunks above) can be
	// opened directly by clicking its title in the response, the same way
	// clicking a table/figure/reference link jumps straight to it instead
	// of leaving the user to go find it themselves. `paperId` is always a
	// PDF ATTACHMENT's item.id (same convention as getCrossLibraryChunks'
	// own `paperId`, not a parent regular item) -- opens it as a reader tab
	// directly when it's still a real PDF attachment, falling back to
	// selecting its parent (or itself) in the library pane otherwise (e.g.
	// the file was removed since this response was generated). Silently
	// no-ops if the item no longer exists at all -- same "stale link,
	// nothing to do" tolerance navigateToAnnotation/navigateToPosition
	// already have for a deleted target.
	async openLibraryItem(paperId) {
		let win = Zotero.getMainWindow();
		if (!win) return;
		let attachment = Zotero.Items.get(paperId);
		if (!attachment) return;
		if (attachment.isPDFAttachment?.()) {
			await Zotero.Reader.open(attachment.id);
			return;
		}
		let item = attachment.parentItem || attachment;
		await win.ZoteroPane.selectItem(item.id);
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
