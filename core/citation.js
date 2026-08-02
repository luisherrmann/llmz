LLMCitation = {
	maxCitationChunks: 1000,
	_indexCache: new Map(), // item.id -> { sentences, paragraphs, model, provider }
	// Bump whenever the disk-cached sentence/paragraph CONTENT itself would
	// come out different for the same PDF -- not just when the schema
	// shape changes (see tables.js's/figures.js's/equations.js's own
	// _cacheVersion, same convention). _loadDiskCache's own fingerprint
	// check alone can't detect this: the fingerprint is still based on
	// Zotero's own linear text (see _textFingerprint), which hasn't
	// changed, even though _buildSentencesAndParagraphsFromStructure now
	// derives the actual sentences/paragraphs from the SDT structure
	// instead -- so a stale cache from before that change would otherwise
	// keep being treated as fresh forever. Bumped once, here, for exactly
	// that switch.
	_cacheVersion: 3,

	log(msg) {
		Zotero.debug("LLM Chat Pane [Citation]: " + msg);
	},

	// Layers this module's OWN length filter (20-500 chars, tuned for
	// standalone citation-chunk selection) and count cap on top of
	// LLMPatterns.splitSentences' shared raw boundary-split (see
	// scripts/shared-patterns.js) -- a caller that wants the literal
	// sentence adjacent to something, unfiltered, should call
	// LLMPatterns.splitSentences directly instead (see e.g.
	// scripts/extract-equations.js's own equation-context extraction).
	splitIntoSentences(text) {
		return LLMPatterns.splitSentences(text)
			.filter(s => s.length >= 20 && s.length <= 500)
			.slice(0, this.maxCitationChunks);
	},

	// Recursively concatenates one SDT block's own leaf .text nodes -- same
	// shape as extract-equations.js's/document/figures.js's own flattenText,
	// duplicated here rather than shared since it's five lines (same
	// reasoning as _formatCreatorName below). Used ONLY on a single block at
	// a time (never across blocks), so -- unlike LLMCitationPosition's own
	// _buildFullTextWithOffsetMap, which walks EVERY block in
	// structure.content and inserts a separator BETWEEN them -- this never
	// introduces a synthetic character that isn't literally present in that
	// one block's own source text.
	_flattenBlockText(node) {
		if (!node) return "";
		if (typeof node.text === "string") return node.text;
		if (Array.isArray(node.content)) return node.content.map(child => this._flattenBlockText(child)).join("");
		return "";
	},

	// Collapses whitespace runs to a single space and trims, same net
	// effect as `.replace(/\s+/g, " ").trim()` -- but also returns `map`,
	// where map[i] is the RAW-text index that collapsed `text[i]` came
	// from, so a caller that computes sentence offsets against `text` (the
	// same collapsed string splitIntoSentences/LLMPatterns.splitSentences
	// itself works from) can translate those offsets back into the raw
	// offsetMap buildBlockTextIndex() returns -- LLMCitationPosition's own
	// _getRectsForNodeRange already skips literal space characters when
	// building its per-node char map, so precision here only actually
	// matters at non-whitespace boundaries (i.e. exactly where sentences
	// start/end).
	_collapseWhitespaceWithMap(rawText) {
		let n = rawText.length;
		let start = 0;
		while (start < n && /\s/.test(rawText[start])) start++;
		let end = n;
		while (end > start && /\s/.test(rawText[end - 1])) end--;

		let text = "";
		let map = [];
		let inWhitespace = false;
		for (let i = start; i < end; i++) {
			let ch = rawText[i];
			if (/\s/.test(ch)) {
				if (!inWhitespace) {
					text += " ";
					map.push(i);
				}
				inWhitespace = true;
			}
			else {
				inWhitespace = false;
				text += ch;
				map.push(i);
			}
		}
		return { text, map };
	},

	// Resolves a [start, end) range in a _collapseWhitespaceWithMap `text`
	// back to a position via LLMCitationPosition.getPositionForRange -- the
	// SAME per-character rect precision a citation click gets
	// (_resolveQueryAgainstTextIndex), instead of one shared position for
	// the whole block. Returns null (same as getPositionForRange itself)
	// when nothing can be resolved -- e.g. a block whose textMap is
	// missing/malformed -- rather than falling back to a coarser
	// approximation; _textRecord already treats a null position as
	// "unlocated" (pageIndex: null, rects: []).
	_resolveRangePosition(map, offsetMap, start, end) {
		if (!map.length) return null;
		let rawStart = map[Math.max(0, Math.min(start, map.length - 1))];
		let rawEnd = map[Math.max(0, Math.min(end, map.length) - 1)] + 1;
		return LLMCitationPosition.getPositionForRange(offsetMap, rawStart, rawEnd);
	},

	_textRecord(text, position) {
		return {
			text,
			pageIndex: position?.pageIndex ?? null,
			rects: position?.rects || [],
		};
	},

	// Builds `sentences`/`paragraphs` from the SDT structure's own
	// 'paragraph'-type blocks, in document order -- the single source of
	// truth for BOTH citation-index content AND LLMCitationPosition's own
	// exact/fuzzy text-matching index (_buildFullTextWithOffsetMap walks the
	// SAME structure.content), so a sentence/paragraph produced here is
	// guaranteed to be a literal, contiguous substring of that OTHER index,
	// making citation re-anchoring an exact match instead of depending on
	// the fuzzy tier to bridge two independently-extracted texts. Replaces
	// splitIntoSentences' own PREVIOUS text source (Zotero's linear
	// PDF-text extraction, LLMPrompt.getAttachmentFullText) -- that
	// pipeline's own reading-order for stacked math notation (combining
	// tildes/dots-above, sub+superscript ordering) routinely diverges from
	// the SDT's own, which caused math-heavy citations to fail re-anchoring.
	//
	// Deliberately scoped PER BLOCK, not over a flattened cross-block list
	// of every paragraph's sentences -- chunking within one block only means
	// a sentence AND a paragraph chunk can never straddle two different SDT
	// blocks (e.g. bridging over an intervening 'math'/'table'/'figure'
	// block the way Zotero's own linear extraction's period-splitting did),
	// which is the actual root cause this whole change exists to eliminate.
	// `maxCitationChunks` is applied ONCE, to the final combined sentence
	// list, not per block, which would let a single pathological block
	// alone reach the cap.
	async _buildSentencesAndParagraphsFromStructure(structure, sentencesPerParagraph = 5) {
		let sentences = [];
		let paragraphs = [];
		// 'list' blocks are expanded into their OWN 'listitem' children here
		// rather than processed as one unit -- tried combining them into one
		// unit first, but that both blends together items that happen to
		// share one SDT list block even when they're not really related
		// (e.g. this plugin's own test paper merges a page's footnotes and
		// its "protocols are emerging" bullets into ONE list block) AND can
		// silently DROP content outright: listitems, unlike a paragraph's
		// own internal text flow, often lack the trailing punctuation
		// splitIntoSentences' boundary regex needs to split at all (e.g. a
		// footnote ending "...position at Intuit" with no period) -- several
		// such items then merge into one oversized "sentence" that fails the
		// 20-500 char length filter and gets dropped entirely, confirmed
		// concretely on this plugin's own test paper. Per-item processing
		// below avoids both problems: each listitem gets its own
		// independent sentence split and position, identical to how a
		// top-level 'paragraph' block already works. 'preformatted' blocks
		// are indexed as a single unit, same as 'paragraph' -- no
		// separator/length-cap issue there, since each is already one
		// contiguous node rather than several sibling items joined together.
		let blocks = [];
		for (let block of structure.content) {
			if (block.type === "paragraph" || block.type === "preformatted") {
				blocks.push(block);
			}
			else if (block.type === "list") {
				for (let item of block.content) {
					if (item.type === "listitem") blocks.push(item);
				}
			}
		}
		for (let block of blocks) {
			let { text: rawText, offsetMap } = LLMCitationPosition.buildBlockTextIndex(block);
			let { text: collapsedText, map } = this._collapseWhitespaceWithMap(rawText);
			if (!collapsedText) continue;
			let blockSentences = this.splitIntoSentences(collapsedText);
			if (!blockSentences.length) continue;
			let searchOffset = 0;
			let sentenceRanges = blockSentences.map((sentence) => {
				let start = collapsedText.indexOf(sentence, searchOffset);
				if (start === -1) return null;
				let end = start + sentence.length;
				searchOffset = end;
				return { sentence, start, end };
			});
			let sentenceRecords = sentenceRanges.map((range, i) => {
				let position = range ? this._resolveRangePosition(map, offsetMap, range.start, range.end) : null;
				return this._textRecord(blockSentences[i], position);
			});
			sentences.push(...sentenceRecords);
			for (let i = 0; i < blockSentences.length; i += sentencesPerParagraph) {
				let chunkRanges = sentenceRanges.slice(i, i + sentencesPerParagraph);
				let chunkSentences = blockSentences.slice(i, i + sentencesPerParagraph);
				let resolvedRanges = chunkRanges.filter(Boolean);
				let position = resolvedRanges.length
					? this._resolveRangePosition(
						map, offsetMap,
						resolvedRanges[0].start,
						resolvedRanges[resolvedRanges.length - 1].end
					)
					: null;
				paragraphs.push(this._textRecord(chunkSentences.join(" "), position));
			}
		}
		sentences = sentences.slice(0, this.maxCitationChunks);
		return { sentences, paragraphs };
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

	// Fingerprint + _cacheVersion are the only staleness checks needed here
	// -- unlike the old per-kind cache files, this joint file carries no
	// `model`/`provider` fields at all (see _saveDiskCache below): the
	// chunk TEXT itself doesn't depend on which embedding model/provider is
	// active, only the EMBEDDINGS do, and those live solely in the
	// embeddings DB (one .sqlite file per model under
	// LLMz/cache/embeddings/, see embeddings-db.js) -- see getTextIndex's
	// own hasEmbeddings check for that half. The cache file also carries
	// no `embeddings` field -- the embeddings DB is the sole store for the
	// actual vectors now that retrieval (getRelevantChunks/
	// getNearestSentences) only ever queries the DB, never reads them back
	// off a loaded disk cache. `cacheVersion` catches the OTHER kind of
	// staleness fingerprint alone can't -- the same Zotero-extracted text
	// producing DIFFERENT sentences/paragraphs because HOW they're derived
	// from it changed (see _cacheVersion's own comment).
	async _loadDiskCache(item, fingerprint) {
		try {
			let path = PathUtils.join(await this._cacheDir(), `${item.id}.json`);
			if (!await IOUtils.exists(path)) return null;
			let cached = JSON.parse(await IOUtils.readUTF8(path));
			if (cached.cacheVersion !== this._cacheVersion) {
				this.log(`_loadDiskCache: stale (cacheVersion changed) for item ${item.id}`);
				return null;
			}
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
			await IOUtils.writeUTF8(path, JSON.stringify({ cacheVersion: this._cacheVersion, fingerprint, sentences, paragraphs }, null, 2));
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
		let sentences, paragraphs;
		if (diskCached) {
			({ sentences, paragraphs } = diskCached);
		}
		else {
			// SDT structure is the single source of truth for the actual
			// sentence/paragraph TEXT now (see
			// _buildSentencesAndParagraphsFromStructure's own comment) --
			// `text`/`fingerprint` above are still used only for the disk
			// cache's own staleness check, same as before. Returns null
			// (same as the `!sentences.length` guard below already does for
			// an empty result) if the structure itself isn't available at
			// all -- e.g. no PDF file on this attachment -- rather than
			// falling back to the old Zotero-text-based splitting, since
			// that's exactly the divergent-extraction source this change
			// exists to stop depending on.
			let structure = await LLMCitationPosition._getStructure(item);
			if (!structure) return null;
			({ sentences, paragraphs } = await this._buildSentencesAndParagraphsFromStructure(structure));
		}
		if (!sentences.length) return null;

		let [sentenceDbStatus, paragraphDbStatus] = await Promise.all([
			LLMEmbeddingsDB.hasEmbeddings(item.id, model, { source: "sentence" }).catch((e) => {
				this.log(`getTextIndex: DB lookup failed (sentence) for item ${item.id}: ${e.message}`);
				return { count: 0 };
			}),
			LLMEmbeddingsDB.hasEmbeddings(item.id, model, { source: "paragraph" }).catch((e) => {
				this.log(`getTextIndex: DB lookup failed (paragraph) for item ${item.id}: ${e.message}`);
				return { count: 0 };
			}),
		]);
		let sentenceDbCount = sentenceDbStatus.count;
		let paragraphDbCount = paragraphDbStatus.count;

		if (sentenceDbCount === sentences.length && paragraphDbCount === paragraphs.length) {
			let index = { sentences, paragraphs, model, provider };
			this._indexCache.set(item.id, index);
			// The DB already has everything needed for retrieval, but if the
			// disk cache is what's actually MISSING here (e.g. a failed prior
			// write, or a JSON file deleted/moved outside this plugin), this
			// is the only remaining place that would ever rewrite it. Without
			// this, hasCache() (Library Index Status) and _loadParagraphs
			// (cross-library retrieval's text lookup) would silently keep
			// treating this paper as unindexed forever, even with full
			// embeddings already in the DB.
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
		let sentenceEmbeddings = await this.embedBatched(sentences.map(s => s.text), model, provider, {
			onProgress: completed => progress?.setProgress?.(completed, total),
		});
		let paragraphEmbeddings = await this.embedBatched(paragraphs.map(p => p.text), model, provider, {
			onProgress: completed => progress?.setProgress?.(sentences.length + completed, total),
		});
		let embeddedCount = sentenceEmbeddings.length + paragraphEmbeddings.length;
		if (progress) progress.textContent = `Recomputed ${sentenceEmbeddings.length} sentence and ${paragraphEmbeddings.length} paragraph embedding${embeddedCount === 1 ? "" : "s"} using ${provider} ${model}.`;

		let index = { sentences, paragraphs, model, provider };
		this._indexCache.set(item.id, index);
		await this._saveDiskCache(item, fingerprint, sentences, paragraphs);
		try {
			await LLMEmbeddingsDB.replaceForPaper(item.id, model, "sentence",
				sentences.map((s, i) => ({ sourceId: i, embedding: sentenceEmbeddings[i] })));
			await LLMEmbeddingsDB.replaceForPaper(item.id, model, "paragraph",
				paragraphs.map((p, i) => ({ sourceId: i, embedding: paragraphEmbeddings[i] })));
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

	// "Embeddings" cache checkbox -- true if this item has ANY sentence OR
	// paragraph embeddings in the DB under the CURRENTLY selected model. A
	// disk check (like hasCache above) would be meaningless here -- the
	// embeddings themselves live in embeddings-db.js's own per-model
	// .sqlite file, not a JSON blob under this module's own _cacheDir.
	async hasEmbeddingsCache(item) {
		let model = await this.getEmbeddingModel();
		let [sentenceCount, paragraphCount] = await Promise.all([
			LLMEmbeddingsDB.hasEmbeddings(item.id, model, { source: "sentence" }).then(r => r.count).catch(() => 0),
			LLMEmbeddingsDB.hasEmbeddings(item.id, model, { source: "paragraph" }).then(r => r.count).catch(() => 0),
		]);
		return sentenceCount > 0 || paragraphCount > 0;
	},

	// "Text" cache checkbox's own clear action -- drops the memory index
	// cache and the joint disk cache file (sentences + paragraphs), but
	// deliberately leaves this item's embeddings DB rows untouched (see
	// clearEmbeddingsCache below, now the "Embeddings" checkbox's own
	// action). Forces the next getTextIndex call to re-derive
	// sentences/paragraphs from the SDT structure -- but since the
	// structure itself hasn't changed, the re-derived text comes out
	// byte-for-byte identical, so getTextIndex's own DB-count shortcut (see
	// its own comment) finds the existing embeddings still valid and just
	// rewrites the disk cache, paying no re-embedding API cost. Useful for
	// recovering from a corrupted/deleted disk file without redoing the
	// (expensive) embedding step.
	async clearTextCache(item) {
		this._indexCache.delete(item.id);
		try {
			let dir = await this._cacheDir();
			await IOUtils.remove(PathUtils.join(dir, `${item.id}.json`), { ignoreAbsent: true });
			this.log(`clearTextCache: cleared disk text cache for item ${item.id}`);
		}
		catch (e) {
			this.log(`clearTextCache: failed: ${e.message}`);
		}
	},

	// "Embeddings" cache checkbox's own clear action -- drops the memory
	// index cache and this item's embeddings DB rows (sentence AND
	// paragraph) UNDER THE CURRENTLY SELECTED embedding model only (a
	// paper's embeddings under some PREVIOUSLY used model, if any, are
	// simply left in that model's own file untouched -- same "current
	// model only" scoping clearCache always used), but leaves disk
	// text.json untouched. Forces the next getTextIndex call to re-embed
	// from the still-cached sentences/paragraphs, without redoing
	// SDT-derived sentence splitting.
	async clearEmbeddingsCache(item) {
		this._indexCache.delete(item.id);
		try {
			let model = await this.getEmbeddingModel();
			await LLMEmbeddingsDB.deleteForPaper(item.id, model, { source: "sentence" });
			await LLMEmbeddingsDB.deleteForPaper(item.id, model, { source: "paragraph" });
			this.log(`clearEmbeddingsCache: cleared embeddings DB rows for item ${item.id}`);
		}
		catch (e) {
			this.log(`clearEmbeddingsCache: failed: ${e.message}`);
		}
	},

	// Debug affordance ("Clear All" in Advanced) -- both of the above
	// together, so the next getTextIndex call actually re-embeds from
	// scratch rather than reusing a possibly-stale result. Without the
	// embeddings half of this, getTextIndex's own DB-count shortcut (see
	// its comment) would find the current model's file still fully
	// populated on the very next Index click and skip re-embedding
	// entirely, even if the disk cache file itself is what's actually
	// missing.
	async clearCache(item) {
		await this.clearTextCache(item);
		await this.clearEmbeddingsCache(item);
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
	// the old JS-side top.sort((a, b) => a.i - b.i) did. Returns the full
	// paragraph objects ({text, pageIndex, rects}), not just bare text --
	// llm/prompt.js's buildPromptWithActivePDFContext needs each chunk's own
	// position to find overlapping highlight/underline notes, the same way
	// it already can for the full-PDF (unchunked) paragraph list.
	async getRelevantChunks(index, query, topK) {
		let queryEmbedding = await this.getEmbedding(query, index.model, index.provider);
		let results = await LLMEmbeddingsDB.query(index.model, queryEmbedding, topK, {
			paperId: index.paperId,
			source: index.source,
		});
		return results
			.sort((a, b) => a.sourceId - b.sourceId)
			.map(r => index.sentences[r.sourceId])
			.filter(Boolean);
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
	// check before this moved here. Returns one { text, distance } (or
	// null, for a skipped/no-match query) per entry in `queryEmbeddings`,
	// same order/length -- `distance` (cosine distance, 0 = identical) is
	// exposed alongside `text` so a caller can log/inspect match quality,
	// not just consume the winning sentence blindly.
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
			if (best) sentences[validIndices[qi]] = { text: index.sentences[best.sourceId]?.text, distance: best.distance };
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
			let paragraphs = JSON.parse(raw).paragraphs || null;
			return paragraphs?.map(p => p.text) || null;
		}
		catch (e) {
			this.log(`_loadParagraphs: failed for paper ${paperId}: ${e.message}`);
			return null;
		}
	},

	// Same shape/rationale as _loadParagraphs above (reads just one field of
	// ANOTHER paper's disk cache, no staleness/fingerprint checks, a miss is
	// just skipped by the caller), generalized to the other three DB
	// `source` kinds getCrossLibraryChunks below can now resolve a hit
	// against -- reads straight from document/tables.js's/figures.js's/
	// equations.js's own cache dir rather than duplicating their shape here.
	async _loadTables(paperId) {
		try {
			let path = PathUtils.join(await LLMTables._cacheDir(), `${paperId}.json`);
			if (!await IOUtils.exists(path)) return null;
			return JSON.parse(await IOUtils.readUTF8(path)).tables || null;
		}
		catch (e) {
			this.log(`_loadTables: failed for paper ${paperId}: ${e.message}`);
			return null;
		}
	},

	// Kind config shared by cross-library element meta-extraction
	// (_elementCrossLibraryMeta below, used by _crossLibrarySourceResolvers'
	// own getMeta entries) and click-time position resolution
	// (resolveCrossLibraryElementPosition) -- maps a "kind" (table/figure/
	// equation) to how to load that paper's own disk cache, the id field
	// that finds a specific record within it (same .find()-not-index
	// convention _crossLibrarySourceResolvers' own comment explains), and
	// its own numbered/"extra" field pair. Table/figure share the same
	// numbered/extraNum naming; equation's second series is called
	// "formula" instead (see extract-equations.js's own header comment for
	// why -- a genuinely different word, not "equationExtra", so its own
	// ref: type reflects that too: ref:PAPER_ID:formula:N, not
	// ref:PAPER_ID:equationExtra:N -- see chat-pane.js's _renderMarkdown).
	_crossLibraryElementKinds: {
		table: {
			load: paperId => LLMCitation._loadTables(paperId),
			idField: "table_id", numField: "table_num", extraField: "table_extra_num",
		},
		figure: {
			load: paperId => LLMCitation._loadFigures(paperId),
			idField: "figure_id", numField: "figure_num", extraField: "figure_extra_num",
		},
		equation: {
			load: paperId => LLMCitation._loadEquations(paperId),
			idField: "equation_id", numField: "equation_num", extraField: "formula_num",
		},
	},

	// Extracts the citation-relevant fields for a cross-library hit of the
	// given `kind` -- `num` (the paper's own real printed number, e.g.
	// "Table 3") if it has one, else `extraNum` (an SDT-only-detected/
	// unlabeled element -- an appendix-lettered caption, or a synthetic
	// heading-derived label, see extract-tables-sdt.js/
	// extract-figures-sdt.js/extract-equations.js), same num/extraNum
	// split _formatTableMarkdown/buildLinkIndex already use for a
	// SAME-paper link. Used by _crossLibrarySourceResolvers' own getMeta
	// entries (getText resolves the TEXT shown to the model; this resolves
	// what the model needs to cite it with a ref:PAPER_ID:<kind>:N/
	// ref:PAPER_ID:<kind>Extra:N (or .../formula:N for equations) link --
	// see llm/prompt.js's own _formatCrossLibraryContext). Returns null if
	// no record matches `sourceId`.
	_elementCrossLibraryMeta(kind, records, sourceId) {
		let config = this._crossLibraryElementKinds[kind];
		let record = records?.find(r => r[config.idField] === sourceId);
		if (!record) return null;
		return { kind, num: record[config.numField], extraNum: record[config.extraField], label: record.label };
	},

	// Caption + cell content together for one table record, joined by a
	// blank line -- used by BOTH _crossLibrarySourceResolvers' table_caption
	// and table_content entries (see their own comment) so a cross-library
	// table chunk always shows the full table, not just whichever half its
	// matching embedding happened to be computed from. Either half can be
	// legitimately absent (a table with no caption still embeds/matches on
	// content alone, and vice versa) -- filtered out rather than left as an
	// empty line. Returns null only if the table_id itself isn't found.
	_tableCombinedText(records, sourceId) {
		let t = records?.find(r => r.table_id === sourceId);
		if (!t) return null;
		let parts = [];
		if (t.caption) parts.push(`${t.label}: ${t.caption}`);
		if (t.contentText) parts.push(t.contentText);
		return parts.join("\n\n") || null;
	},

	// Resolves a cross-library element link's highlight region at CLICK
	// time, not render time -- unlike a SAME-paper link (resolved up front
	// via buildLinkIndex, from the index already in memory for the PDF
	// that's actually open), this needs reading ANOTHER paper's own disk
	// cache (see _crossLibraryElementKinds' own `load`), an async file read
	// render-time HTML generation (chat-pane.js's _renderMarkdown) can't do
	// synchronously -- so the rendered link only carries paperId+kind+num/
	// extraNum (see its own data-cross-* attributes), and this is called
	// from the click handler instead (llm/request.js's/ui/chat.js's
	// rendered.addEventListener click, both already async). Exactly one of
	// num/extraNum should be given, matching whichever ref: variant the
	// link used. Returns null (silently, same "stale link" tolerance every
	// other navigateTo*/openLibraryItem already has) if `kind` isn't
	// recognized, the paper's own cache is missing/unreadable, or no
	// record matches.
	async resolveCrossLibraryElementPosition(paperId, kind, { num, extraNum } = {}) {
		let config = this._crossLibraryElementKinds[kind];
		if (!config) return null;
		let records = await config.load(paperId);
		if (!records) return null;
		let record = num != null
			? records.find(r => r[config.numField] === num)
			: records.find(r => r[config.extraField] === extraNum);
		return record?.position || null;
	},

	async _loadFigures(paperId) {
		try {
			let path = PathUtils.join(await LLMFigures._cacheDir(), `${paperId}.json`);
			if (!await IOUtils.exists(path)) return null;
			return JSON.parse(await IOUtils.readUTF8(path)).figures || null;
		}
		catch (e) {
			this.log(`_loadFigures: failed for paper ${paperId}: ${e.message}`);
			return null;
		}
	},

	async _loadEquations(paperId) {
		try {
			let path = PathUtils.join(await LLMEquations._cacheDir(), `${paperId}.json`);
			if (!await IOUtils.exists(path)) return null;
			return JSON.parse(await IOUtils.readUTF8(path)).equations || null;
		}
		catch (e) {
			this.log(`_loadEquations: failed for paper ${paperId}: ${e.message}`);
			return null;
		}
	},

	// Maps a DB `source` value (see embeddings-db.js's schema comment) to
	// how a (paperId, sourceId) hit resolves back to real, displayable
	// text -- which loader above reads that kind's own disk cache, and how
	// sourceId locates a record within it. Paragraphs are matched by raw
	// array POSITION -- sourceId literally IS the array index (see this
	// file's own DB sync: `paragraphs.map((p, i) => ({ sourceId: i, ... }))`)
	// -- but a table/figure/equation hit instead carries that record's own
	// stable 1-based table_id/figure_id/equation_id (see each module's own
	// DB sync), NOT a raw array position, so those are resolved via .find()
	// against that field instead of direct indexing -- the same convention
	// selectTablesWithLLM/selectFiguresWithLLM already use to resolve an
	// id back to a record, robust regardless of whether the on-disk array
	// still happens to be in id order. getText returns the same text each
	// kind's own embedding was actually computed from (see e.g.
	// document/figures.js's `${fig.label}: ${fig.caption}` or
	// document/equations.js's preceding/text/following join), so a
	// retrieved chunk always reads consistently with whatever made it
	// match in the first place -- EXCEPT table_caption/table_content below,
	// which both deliberately return caption+content together regardless of
	// which one matched (see their own comment).
	_crossLibrarySourceResolvers: {
		paragraph: {
			load: paperId => LLMCitation._loadParagraphs(paperId),
			getText: (records, sourceId) => records?.[sourceId] || null,
		},
		// table_caption and table_content are separate DB `source` rows (see
		// document/tables.js's own _addTextEmbeddings) so a query can match
		// EITHER a table's caption wording or its cell content wording, but
		// they resolve back to the SAME table record (both keyed by
		// table_id/sourceId) -- so regardless of which one a query actually
		// matched, getText below returns caption AND content together
		// (_tableCombinedText), rather than just whichever half happened to
		// score highest. getCrossLibraryChunks' own seenTables dedup below
		// then collapses a table that matched on BOTH into one chunk, not
		// two near-duplicate ones.
		table_caption: {
			load: paperId => LLMCitation._loadTables(paperId),
			getText: (records, sourceId) => LLMCitation._tableCombinedText(records, sourceId),
			getMeta: (records, sourceId) => LLMCitation._elementCrossLibraryMeta("table", records, sourceId),
		},
		table_content: {
			load: paperId => LLMCitation._loadTables(paperId),
			getText: (records, sourceId) => LLMCitation._tableCombinedText(records, sourceId),
			getMeta: (records, sourceId) => LLMCitation._elementCrossLibraryMeta("table", records, sourceId),
		},
		figure_caption: {
			load: paperId => LLMCitation._loadFigures(paperId),
			getText: (records, sourceId) => {
				let f = records?.find(fig => fig.figure_id === sourceId);
				return f ? `${f.label}: ${f.caption}` : null;
			},
			getMeta: (records, sourceId) => LLMCitation._elementCrossLibraryMeta("figure", records, sourceId),
		},
		equation_context: {
			load: paperId => LLMCitation._loadEquations(paperId),
			getText: (records, sourceId) => {
				let eq = records?.find(e => e.equation_id === sourceId);
				if (!eq) return null;
				return [eq.preceding_sentence, eq.text, eq.following_sentence].filter(Boolean).join(" ") || null;
			},
			getMeta: (records, sourceId) => LLMCitation._elementCrossLibraryMeta("equation", records, sourceId),
		},
	},

	// Same institutional-vs-personal-name handling as export.js's own
	// _formatCreatorName -- duplicated rather than shared since it's three
	// lines and pulling in a whole other module for it isn't worth it.
	_formatCreatorName(creator) {
		if (creator.name) return creator.name;
		return [creator.firstName, creator.lastName].filter(Boolean).join(" ");
	},

	// "(FirstAuthor et al., Year)" -- used by chat-pane.js's _renderMarkdown
	// to build the visible label for a cross-library element link
	// (ref:PAPER_ID:table:N/figure:N/equation:N/etc.), REPLACING the
	// model's own numeric PAPER_ID placeholder in its label with this,
	// rather than trusting the model to
	// spell out the author/year itself (same "prefer real Zotero data over
	// whatever the model wrote" reasoning _renderMarkdown's ref:library:
	// branch already uses for a paper's title). LAST name only (not
	// _formatCreatorName's full "First Last") -- standard author-year
	// citation convention, and matches the parenthetical shorthand the
	// system prompt's own cross-library instructions already model this
	// on. "et al." unconditionally, even for a single-author paper -- kept
	// simple per how this was actually specified, not auto-detecting
	// single- vs multi-author phrasing. Falls back to an institutional
	// creator's own `.name` (no last/first split for those), and to "n.d."
	// for a date field that's missing or doesn't parse. Returns null only
	// if the paper has no creators at all (a caption-only/rare case) --
	// _renderMarkdown falls back to the plain (un-prefixed) label then.
	_formatCrossLibraryAuthorYear(paperItem) {
		let creators = paperItem.getCreatorsJSON();
		let first = creators[0];
		let authorLabel = first ? (first.lastName || first.name || first.firstName) : null;
		if (!authorLabel) return null;
		let dateField = paperItem.getField("date");
		let year = dateField ? Zotero.Date.strToDate(dateField)?.year : null;
		return `(${authorLabel} et al., ${year || "n.d."})`;
	},

	// Cross-library retrieval for llm/prompt.js's <CROSS_LIBRARY_CONTEXT> --
	// ranks candidates from EVERY OTHER paper in the library (excludePaperId
	// is always the currently active PDF) against `query`, via the same
	// sqlite-vec MATCH path getRelevantChunks uses above, then resolves each
	// hit back to real text and Zotero metadata. `paperId` here is always a
	// PDF ATTACHMENT's item.id, same as everywhere else in this file -- its
	// own title/creator fields are usually just generic translator-assigned
	// values, not the real paper's, so metadata is read from the PARENT item
	// instead (same `item.parentItem || item` pattern as export.js's own
	// paperItem).
	//
	// Two searches, unioned -- not one: a plain top-K nearest-neighbor
	// search across every embedded kind at once tends to be dominated by
	// whichever kind is most numerous/verbose in the library, so a
	// genuinely relevant table or equation elsewhere can rank below topK
	// purely on volume, not relevance (e.g. "sentence" rows vastly
	// outnumber "equation_context" rows in a real library). The first
	// search is restricted to source: "paragraph" (the
	// prose half); the second to sources: [table_caption, table_content,
	// figure_caption, equation_context] (the "structural" half) --
	// deliberately excluding BOTH "sentence" (never surfaced as cross-
	// library context at all, paragraph is the prose granularity this
	// context is meant to read at) AND "paragraph" itself (already fully
	// covered by the first search, so including it here again would just
	// let paragraphs re-dominate the SECOND search's own ranking too,
	// undermining the exact thing this split search exists to prevent).
	// Both go out in ONE db.py subprocess call via queryBatch (see its own
	// comment) rather than two separate query() round-trips. Deduped by
	// `id` (the embeddings table's own primary key, globally unique across
	// every source in the file) since the SAME row can legitimately appear
	// in both result sets (in practice never will here, since the two
	// searches' source/sources are disjoint -- kept anyway since it's
	// nearly free and makes that invariant load-bearing rather than
	// assumed).
	//
	// Returned already ranked nearest-first (unlike getRelevantChunks, which
	// re-sorts back to paragraph position order -- that only makes sense
	// within a SINGLE paper's own paragraph sequence; across different
	// papers there's no shared position to sort by, so relevance rank is
	// the only meaningful order here). Silently skips any hit whose paper no
	// longer exists in the library, whose source kind isn't one
	// _crossLibrarySourceResolvers recognizes, or whose disk cache is
	// missing/unreadable -- all exactly the kind of stale state a
	// supplementary cross-library chunk should just drop, not fail the
	// whole request over -- so the returned list can be shorter than 2*topK.
	async getCrossLibraryChunks(query, model, provider, topK, excludePaperId) {
		let queryEmbedding = await this.getEmbedding(query, model, provider);
		let [paragraphResults, structuralResults] = await LLMEmbeddingsDB.queryBatch(model, [
			{ embedding: queryEmbedding, topK, excludePaperId, source: "paragraph" },
			{
				embedding: queryEmbedding, topK, excludePaperId,
				sources: ["table_caption", "table_content", "figure_caption", "equation_context"],
			},
		]);
		let resultById = new Map();
		for (let result of [...paragraphResults, ...structuralResults]) {
			resultById.set(result.id, result);
		}
		let results = [...resultById.values()].sort((a, b) => a.distance - b.distance);

		let chunks = [];
		let recordsByKey = new Map();
		// table_caption and table_content are two separate DB rows for the
		// SAME table (see _crossLibrarySourceResolvers' own comment on
		// _tableCombinedText) -- a table whose caption AND content both
		// score within topK would otherwise produce two chunks with
		// identical (combined) text. Keyed by paperId+table_id (sourceId is
		// the shared table_id for both source rows), so the second hit for
		// an already-emitted table is dropped, keeping only its
		// nearer-ranked (results is already distance-sorted) occurrence.
		let seenTables = new Set();
		for (let result of results) {
			let resolver = this._crossLibrarySourceResolvers[result.source];
			if (!resolver) continue;
			if (result.source === "table_caption" || result.source === "table_content") {
				let tableKey = `${result.paperId}:${result.sourceId}`;
				if (seenTables.has(tableKey)) continue;
				seenTables.add(tableKey);
			}
			// Keyed by kind+paper, not just paper -- a paper's table/figure/
			// equation/paragraph caches are four separate disk files (see
			// each _loadX above), so a paper contributing hits of more than
			// one kind needs one cache-file load per kind, not just one.
			let key = `${result.source}:${result.paperId}`;
			let records = recordsByKey.get(key);
			if (records === undefined) {
				records = await resolver.load(result.paperId);
				recordsByKey.set(key, records);
			}
			let text = resolver.getText(records, result.sourceId);
			if (!text) continue;

			let attachment = Zotero.Items.get(result.paperId);
			if (!attachment) continue;
			let paperItem = attachment.parentItem || attachment;
			let title = paperItem.getField("title") || paperItem.libraryKey;
			let authors = paperItem.getCreatorsJSON().map(c => this._formatCreatorName(c)).filter(Boolean).join(", ");

			// `source` carried through -- llm/request.js's own
			// _buildCrossLibraryContext Logs breakdown needs it to report
			// what KIND of excerpt each chunk actually is (paragraph vs.
			// table/figure/equation), now that a chunk isn't always a
			// paragraph. `meta` (every resolver except plain paragraph
			// defines getMeta -- see _elementCrossLibraryMeta) carries
			// whatever llm/prompt.js's _formatCrossLibraryContext needs to
			// give the model a citable ref:PAPER_ID:<kind>:N hint; null for
			// paragraph, which just means no such hint is shown.
			let meta = resolver.getMeta ? resolver.getMeta(records, result.sourceId) : null;
			chunks.push({ paperId: result.paperId, title, authors, text, source: result.source, meta });
		}
		return chunks;
	},

	// Parses a [CITE](<find:...>) token's payload into { paperId, phrase } --
	// either a plain phrase (a same-paper citation, grounded against the
	// CURRENT PDF) or "PAPER_ID:phrase" (a cross-library citation, grounded
	// against that OTHER paper instead -- see llm/prompt.js's own
	// cross-library citation instructions). paperId is null for the plain
	// case. A real quoted sentence essentially never starts with
	// "<digits>:" as its own literal first characters, so a leading run of
	// digits immediately followed by exactly one colon unambiguously means
	// the cross-library shape -- same disambiguation chat-pane.js's own
	// ref: parsing already relies on (a numeric first segment there too).
	// Shared by groundCitations (unaffected -- its own regex already
	// captures either shape as one opaque payload), llm/request.js's
	// citation-position resolution (groups payloads by paperId before
	// calling LLMCitationPosition.resolvePositions, once per distinct
	// paper), and chat-pane.js's _renderMarkdown (decides whether a
	// resolved position navigates within the current reader or opens a
	// different paper).
	parseFindPayload(payload) {
		let m = payload.match(/^(\d+):([\s\S]+)$/);
		if (m) return { paperId: parseInt(m[1], 10), phrase: m[2] };
		return { paperId: null, phrase: payload };
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
		// sentence) until it finds the real one. `*`/`_`/`` ` `` are ALSO
		// valid boundaries -- the closing delimiter of a **bold**/_italic_/
		// `code` span the model wrapped the whole [CITE](<find:...>) token
		// in -- without them, a bolded citation fails to match here at all,
		// left ungrounded (see chat-pane.js's _renderMarkdown for the
		// fuller version of this same failure). Same pattern (and same
		// reasoning) in llm/request.js's citation-position query extraction and
		// chat-pane.js's _renderMarkdown -- keep all three in sync.
		let pattern = /\[CITE\]\(<find:([\s\S]+?)>\)(?=[\s.,;:!?)\]*_`]|\[|$)/g;
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
	// _renderMarkdown, ref:library:PAPER_ID and ref:PAPER_ID:<kind>:N) so a
	// paper the model pulled into <CROSS_LIBRARY_CONTEXT> (see
	// getCrossLibraryChunks above) can be opened directly by clicking its
	// title (or a specific table/figure/equation mention) in the response, the same way
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
	//
	// `position`, if given (see resolveCrossLibraryElementPosition), is
	// passed straight through as Zotero.Reader.open's own `location`
	// param -- it threads through correctly whether this paper's reader
	// tab already exists (reader.navigate(location) internally) or is
	// being newly opened (passed straight into the new ReaderTab's own
	// constructor) -- confirmed against reader.js's own open()/navigate(),
	// so this genuinely opens-and-highlights in one call, no separate
	// navigateToPosition needed afterward the way a same-paper link needs.
	async openLibraryItem(paperId, position) {
		let win = Zotero.getMainWindow();
		if (!win) return;
		let attachment = Zotero.Items.get(paperId);
		if (!attachment) return;
		if (attachment.isPDFAttachment?.()) {
			await Zotero.Reader.open(attachment.id, position ? { position } : undefined);
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
	// _highlightPosition, hardcoded ~2s, no public way to reconfigure or
	// make persistent). Its
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
