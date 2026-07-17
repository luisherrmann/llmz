// Shared SDT structure-cache helper for all document extractors.
// Keeps the "compute structure once per PDF, reuse everywhere" logic out of
// feature-specific modules (references/equations/tables/figures).
LLMStructureSDT = {
	_scriptName: "compute-document-structure.js",
	// item.id -> in-flight Promise<structureCachePath> -- see
	// ensureStructureCache's own comment for why this exists.
	_pendingComputations: new Map(),

	log(msg) {
		Zotero.debug("LLM Chat Pane [StructureSDT]: " + msg);
	},

	_scriptPath() {
		return PathUtils.join(LLMReferences._extensionRoot, "scripts", this._scriptName);
	},

	async _structureCacheDir() {
		let dir = PathUtils.join(Zotero.DataDirectory.dir, "LLMz", "cache", "structure");
		await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
		return dir;
	},

	async _structureCachePath(item) {
		return PathUtils.join(await this._structureCacheDir(), `${item.id}.json`);
	},

	// `llm/request.js` kicks off getReferenceIndex/getEquationIndex/
	// getTableIndex/getFigureIndex together (Promise.all) -- on a cold
	// cache (a newly opened PDF), all four would otherwise see "no cache
	// yet" and independently spawn their own compute-document-structure.js
	// subprocess, each redoing the expensive ML classification: exactly the
	// 4x-redundant-computation problem this shared cache exists to
	// prevent. Concurrent callers for the SAME item instead await the ONE
	// already-in-flight computation via _pendingComputations. Removed from
	// the map in a `finally` (not just on success) so a failed computation
	// doesn't permanently poison later calls with a stale rejected promise
	// -- the next call just retries from scratch.
	//
	// `onMessage(text)`, if given, is called ONLY when this call is the one
	// that actually triggers a real computation (never on a cache hit, and
	// never for a caller that just joins an already-in-flight one) -- this
	// is by far the slowest single step in the whole tables/figures/
	// references/equations extraction pipeline (ML layout classification
	// over the full PDF), so it's worth its own status line distinct from
	// each concern's own "Recomputing X..." messaging.
	async ensureStructureCache(item, onMessage) {
		let structureCachePath = await this._structureCachePath(item);
		if (await IOUtils.exists(structureCachePath)) {
			return structureCachePath;
		}
		if (this._pendingComputations.has(item.id)) {
			return this._pendingComputations.get(item.id);
		}
		let promise = (async () => {
			let pdfPath = item.getFilePath();
			if (!pdfPath) {
				throw new Error("Item has no attached file path");
			}
			onMessage?.("Computing document structure (this may take a moment)...");
			await LLMReferences._runNode(this._scriptPath(), this._scriptName, pdfPath, structureCachePath);
			onMessage?.("Computed document structure.");
			return structureCachePath;
		})();
		this._pendingComputations.set(item.id, promise);
		try {
			return await promise;
		}
		finally {
			this._pendingComputations.delete(item.id);
		}
	},
};
