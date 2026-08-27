// Builds every per-paper index together, deduplicates them against each
// other, and only then writes anything.
//
// The four extraction pipelines (text/paragraphs, preformatted listings,
// tables, equations) are independent and never consult one another, so the
// SAME physical region routinely comes back from more than one of them --
// confirmed concretely on this plugin's own test paper, where 12 of 15
// "tables" were actually code listings that extract-tables-sdt.js had
// labelled "<section>, Unlabelled Table N". Left alone, the model sees that
// content twice in its context, once as a listing and once as a table.
//
// Deduplication needs every index in hand at once, which is why this exists
// as its own step rather than inside any one module. Each module is asked to
// build WITHOUT persisting (`defer: true`, see their own persistIndex
// methods), the loser of each overlap is deleted, and only the survivors are
// written to the disk caches and the embeddings DB -- one write per index,
// after the final contents are known. Persisting first and correcting after
// would mean writing rows only to delete them moments later, and (for the
// array-indexed sources) renumbering every embedding that followed a deleted
// entry.
//
// Works on each module's RAW index object -- the same object the module
// memoizes and persists -- not on the reshaped views getParagraphIndex/
// getPreformattedIndex return. Those views are rebuilt per call from copies,
// so deleting from a view would change nothing that ever reaches disk.
// Callers should keep using those accessors afterwards: both are backed by
// the same memoized objects this has already deduplicated.
//
// Callers go through ensureIndexed below rather than calling buildIndexes
// directly: llm/request.js (both a live chat turn and any tool intent) and
// ui/index-all.js ("Index"/"Index All"), so every path behaves identically
// -- a paper indexed in the background is deduplicated exactly like one
// indexed on demand mid-chat, or one merely being listed by a tool.
LLMIndexPipeline = {
	log(msg) {
		Zotero.debug("LLM Chat Pane [IndexPipeline]: " + msg);
	},

	// The single "make this paper's indexes ready to read" entry point --
	// buildIndexes below (text, preformatted, tables, equations, figures)
	// plus references, which is the only index still built outside it: a
	// bibliography overlaps nothing geometrically, so it has no reason to
	// join the deferred build/deduplicate/persist protocol.
	//
	// Exists because the ordering invariant buildIndexes creates is easy to
	// violate silently. Deduplication lives here, not in the per-module
	// accessors, and it is also what rewrites each disk cache with the
	// deduplicated arrays -- so calling getTableIndex/getPreformattedIndex/
	// getEquationIndex BEFORE this has run for the item yields the raw,
	// un-deduplicated extraction. That produced a real bug: listing a
	// paper's tables from a tool intent (which returns before
	// _handleNormalChat, the only chat path that ran the pipeline) reported
	// every phantom table on a cold cache -- code listings SDT had typed
	// `table` -- while the same request AFTER pressing "Index" looked
	// correct, purely because indexing had rewritten the cache.
	//
	// Safe to call on every request: deduplication is idempotent (a second
	// pass over already-deduplicated arrays removes nothing), and every
	// accessor underneath is memory-cached per item, so a warm paper costs
	// essentially nothing. Callers therefore do not need to track whether
	// indexing has already happened.
	//
	// Best-effort throughout, like the steps it wraps: a failure here must
	// not cost the caller its actual request, so it resolves rather than
	// throwing, and the caller simply reads whatever the accessors give.
	async ensureIndexed(item, { onEmbeddingStart = null, onMessage = null } = {}) {
		if (!item) return;
		let text;
		try {
			text = await LLMPrompt.getAttachmentFullText(item);
		}
		catch (e) {
			this.log(`ensureIndexed: getAttachmentFullText failed for ${item.libraryKey}: ${e.message}`);
		}
		// Figures are built INSIDE buildIndexes, not alongside it -- calling
		// getFigureIndex here as well would start a second extraction for
		// the same item concurrently with the pipeline's own (neither can
		// see the other's memory-cache entry, since both begin before
		// either finishes).
		await Promise.all([
			this.buildIndexes(item, text, { onEmbeddingStart, onMessage }).catch((e) => {
				this.log(`ensureIndexed: buildIndexes failed for ${item.libraryKey}: ${e.message}`);
			}),
			LLMReferences.getReferenceIndex(item, onMessage).catch((e) => {
				this.log(`ensureIndexed: getReferenceIndex failed for ${item.libraryKey}: ${e.message}`);
			}),
		]);
	},

	// Builds (deferred), deduplicates, and persists. Returns the raw indexes
	// so a caller that wants them need not re-fetch.
	//
	// `text` is the attachment's full text, needed by getTextIndex for its
	// own cache fingerprint -- passed in rather than read here since both
	// callers already have it (LLMPrompt.getAttachmentFullText, which reads
	// Zotero's own full-text cache file).
	//
	// Every step is individually best-effort: one extractor failing (missing
	// venv, malformed PDF) must not cost the caller the other indexes, just
	// as when each module was called separately. A failed index comes back
	// null and is simply skipped by deduplication.
	async buildIndexes(item, text, { onEmbeddingStart = null, onMessage = null } = {}) {
		if (!item) return { textIndex: null, preformattedIndex: null, tableIndex: null, equationIndex: null, figureIndex: null };

		let defer = { defer: true };
		let [textIndex, preformattedIndex, tableIndex, equationIndex, figureIndex] = await Promise.all([
			text && text.trim()
				? LLMCitation.getTextIndex(item, text, onEmbeddingStart, onMessage, defer).catch((e) => {
					this.log(`getTextIndex failed for ${item.libraryKey}: ${e.message}`);
					return null;
				})
				: null,
			// _getRawIndex, not getPreformattedIndex: this needs the object
			// that actually gets persisted (see this module's own comment).
			LLMPreformatted._getRawIndex(item, onEmbeddingStart, onMessage, defer).catch((e) => {
				this.log(`getPreformattedIndex failed for ${item.libraryKey}: ${e.message}`);
				return null;
			}),
			LLMTables.getTableIndex(item, onEmbeddingStart, onMessage, defer).catch((e) => {
				this.log(`getTableIndex failed for ${item.libraryKey}: ${e.message}`);
				return null;
			}),
			LLMEquations.getEquationIndex(item, onEmbeddingStart, onMessage, defer).catch((e) => {
				this.log(`getEquationIndex failed for ${item.libraryKey}: ${e.message}`);
				return null;
			}),
			// Built here, deferred, so deduplication below can drop a
			// preformatted region that turns out to be a figure's own text
			// before anything is written -- that pass can only delete an
			// entry BEFORE it has been persisted, which is why figures had
			// to move onto this path before they could take part at all.
			LLMFigures.getFigureIndex(item, onEmbeddingStart, onMessage, defer).catch((e) => {
				this.log(`getFigureIndex failed for ${item.libraryKey}: ${e.message}`);
				return null;
			}),
		]);

		let indexes = { textIndex, preformattedIndex, tableIndex, equationIndex, figureIndex };
		await this._deduplicateAndPersist(item, indexes, onMessage);
		return indexes;
	},

	async _deduplicateAndPersist(item, indexes, onMessage) {
		let { textIndex, preformattedIndex, tableIndex, equationIndex, figureIndex } = indexes;

		let removed = LLMPreformatted.deduplicatePreformatted({
			preformatted: preformattedIndex?.preformatted || [],
			tables: tableIndex?.tables || [],
			equations: equationIndex?.equations || [],
			paragraphs: textIndex?.paragraphs || [],
			// Figures never lose, so this only ever removes preformatted
			// regions -- no figure is deleted and figureIndex needs no
			// rewrite on its account (see persistIfNeeded below). The
			// removals it does cause are counted in removed.preformatted
			// like any other, so the existing renumbering path handles them
			// unchanged.
			figures: figureIndex?.figures || [],
		});

		// Which indexes still hold their vectors, captured BEFORE persisting
		// -- citation.js's persistIndex deletes `_embedding` once written, so
		// asking afterwards would report every index as vector-less.
		//
		// This, not `pendingPersist`, is what separates a freshly embedded
		// index from a cache hit: the cache-hit branches set pendingPersist
		// under `defer` too (they may still need REWRITING after
		// deduplication), whereas only a fresh index carries vectors --
		// every disk cache strips them. A fresh index's persistIndex writes
		// its DB rows straight from the post-deduplication arrays, so it is
		// already correctly numbered; a cache-hit index's rows are still
		// numbered for the pre-deduplication array and need compacting.
		let hasVectors = {
			text: !!textIndex?.sentences?.some(s => s._embedding),
			preformatted: !!preformattedIndex?.preformatted?.some(pf => pf.contentEmbedding || pf.captionEmbedding),
			tables: !!tableIndex?.tables?.some(t => t.captionEmbedding || t.contentEmbedding),
			equations: !!equationIndex?.equations?.some(eq => eq.embedding),
		};

		// A fresh index carries pendingPersist and must be written
		// regardless. A cache-hit index is already on disk -- but if
		// deduplication removed entries, that copy is now stale and has to
		// be rewritten too. Each persistIndex skips the DB on its own when
		// the index has no vectors to sync (see their guards), so a cache
		// hit only rewrites the disk cache here.
		let jobs = [];
		let persistIfNeeded = (index, owner, changed) => {
			if (!index || (!index.pendingPersist && !changed)) return;
			jobs.push(owner.persistIndex(item, index, onMessage).catch((e) => {
				this.log(`persistIndex failed for ${item.libraryKey}: ${e.message}`);
			}));
		};
		persistIfNeeded(textIndex, LLMCitation, removed.paragraphs > 0);
		persistIfNeeded(preformattedIndex, LLMPreformatted, removed.preformatted > 0);
		persistIfNeeded(tableIndex, LLMTables, removed.tables > 0);
		persistIfNeeded(equationIndex, LLMEquations, removed.equations > 0);
		// `changed` is always false by construction: figures always win
		// their overlaps, so deduplication never removes one and a figure
		// index is only ever written when it was freshly built and still
		// carries pendingPersist.
		persistIfNeeded(figureIndex, LLMFigures, false);
		await Promise.all(jobs);

		await this._compactStaleEmbeddings(item, indexes, removed, hasVectors);
	},

	// Re-keys the embedding rows of any index that was ALREADY persisted
	// before deduplication ran (a cache hit) and then had entries removed:
	// its vectors are in the DB numbered for the pre-deduplication array, so
	// they must be renumbered rather than recomputed. A FRESHLY built index
	// never needs this -- persistIndex above wrote its rows straight from
	// the post-deduplication arrays.
	//
	// The two conventions map onto scripts/db.py's own `compact`: array-
	// indexed sources pass `keep` (the survivors' ORIGINAL positions, in
	// their new order), stable-id sources pass `delete`.
	async _compactStaleEmbeddings(item, { textIndex, preformattedIndex, tableIndex, equationIndex }, removed, hasVectors) {
		let sources = {};
		// Only entries deduplication could touch get an _originalIndex, and
		// only those two lists are array-indexed AND filtered, so a missing
		// one means the entry predates numbering and must not be remapped.
		let keepList = list => list.map(e => e._originalIndex).filter(i => i !== undefined);

		if (removed.paragraphs > 0 && textIndex && !hasVectors.text) {
			sources.paragraph = { keep: keepList(textIndex.paragraphs) };
		}
		if (removed.preformatted > 0 && preformattedIndex && !hasVectors.preformatted) {
			let keep = keepList(preformattedIndex.preformatted);
			sources.preformatted_content = { keep };
			sources.preformatted_caption = { keep };
		}
		if (removed.tables > 0 && tableIndex && !hasVectors.tables && removed.tableIds.length) {
			sources.table_caption = { delete: removed.tableIds };
			sources.table_content = { delete: removed.tableIds };
		}
		if (removed.equations > 0 && equationIndex && !hasVectors.equations && removed.equationIds.length) {
			sources.equation_context = { delete: removed.equationIds };
		}
		if (!Object.keys(sources).length) return;

		try {
			let model = await LLMCitation.getEmbeddingModel();
			let result = await LLMEmbeddingsDB.compactForPaper(item.id, model, sources);
			this.log(`_compactStaleEmbeddings: deleted ${result.deleted}, remapped ${result.remapped} embedding row(s) for ${item.libraryKey}`);
		}
		catch (e) {
			this.log(`_compactStaleEmbeddings failed for ${item.libraryKey}: ${e.message}`);
		}
	},
};
