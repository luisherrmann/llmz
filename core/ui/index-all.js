// "Index All" -- runs the full extraction pipeline (tables, figures,
// references, equations, preformatted/listings, citation/paragraph
// embeddings) for a PDF attachment, so a user can pre-warm a paper's caches
// in one go instead of paying the extraction cost the first time they ask a
// question about it.
//
// _indexItem (the actual per-paper extraction work) is reused directly by
// ui/advanced.js's Cache section "Index All" button, which runs it over
// just the currently-UNINDEXED papers in "My Library" and reports progress
// through the Cache section's own "Library index status" bar.
LLMUIIndexAll = {
	// Papers indexed at once -- same worker-pool concurrency pattern as
	// LLMCitation.embedBatched's own concurrent batch submission (see its
	// own comment), applied here one level up: each paper's own embedding
	// calls (getTextIndex, latency-bound network round-trips) benefit from
	// overlapping several papers' pipelines
	// rather than sitting fully idle between one paper's own sequential
	// steps. Lowered from 8 to 4 -- fewer PDFs open at once through
	// whatever native path LLMPrompt.getAttachmentFullText's PDFWorker
	// fallback goes through, as a lever against macOS's CGPDFService
	// process's memory growth over a long Index All run (see
	// ui/advanced.js's runIndexAll, which also periodically nudges Gecko's
	// own memory-pressure observers). Trades some wall-clock time for
	// that -- being tried out to see how much it actually costs in
	// practice before deciding whether it's worth keeping permanently.
	CONCURRENCY_LEVEL: 4,

	log(msg) {
		Zotero.debug("LLM Chat Pane [IndexAll]: " + msg);
	},

	// A PDF attachment's OWN title/filename rarely reads as well as its
	// parent (regular) item's actual paper title -- preferred here purely
	// for a more recognizable progress-window label, not used anywhere
	// extraction-related.
	_labelFor(item) {
		return item.parentItem?.getField("title") || item.getField("title") || item.libraryKey;
	},

	// Runs every extraction step for one PDF attachment -- same set of
	// calls (and the same "one failure doesn't abort the others" via
	// individual .catch()) as llm/request.js's own live-request path, minus
	// LLMNotes (not an extraction step at all -- getNotes just reads
	// existing Zotero annotations, nothing to pre-warm) and minus actually
	// building a prompt: buildPromptWithActivePDFContext is tied to
	// LLMChatPane.getActiveReaderAttachment() (the CURRENTLY open reader
	// tab), not usable for an arbitrary background item, so the text index
	// is built directly here instead via LLMPrompt.getAttachmentFullText +
	// LLMCitation.getTextIndex, which takes `item` as an explicit parameter
	// rather than reading the active reader themselves.
	// Never throws -- returns { ok: true } or { ok: false, error }, so the
	// caller's batch loop doesn't need its own try/catch per item.
	// `onMessage`, if given, is forwarded to getTextIndex/getFigureIndex
	// purely so their own embeddings DB sync (see citation.js's/
	// figures.js's own comments) has somewhere to report a visible
	// confirmation line -- everything else here stays on the Debug-Output-
	// only this.log() it already used.
	async _indexItem(item, onMessage) {
		try {
			// Everything goes through the pipeline's own entry point rather
			// than being orchestrated here, so a paper indexed in the
			// background is deduplicated exactly like one indexed on demand
			// mid-chat or listed by a tool -- see llm/index-pipeline.js's
			// ensureIndexed. Each index inside it stays individually
			// best-effort; one failing does not cost the others.
			//
			// References are the only index built outside the pipeline's own
			// deferred build/deduplicate/persist protocol -- a bibliography
			// overlaps nothing geometrically, so it has no reason to join
			// it. Figures DO build through the pipeline now, though they
			// take no part in the deduplication contest yet; see
			// llm/index-pipeline.js's buildIndexes for why that ordering
			// (build through the pipeline first, contest later) is required
			// rather than incidental.
			await LLMIndexPipeline.ensureIndexed(item, { onMessage });
			return { ok: true };
		}
		catch (e) {
			this.log(`_indexItem failed for ${item.libraryKey}: ${e.message}`);
			return { ok: false, error: e.message };
		}
	},
};
