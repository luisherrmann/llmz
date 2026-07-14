// Shared SDT structure-cache helper for all document extractors.
// Keeps the "compute structure once per PDF, reuse everywhere" logic out of
// feature-specific modules (references/equations/tables/figures).
LLMStructureSDT = {
	_scriptName: "compute_document_structure.js",
	// item.id -> in-flight Promise<structureCachePath> -- see
	// ensureStructureCache's own comment for why this exists.
	_pendingComputations: new Map(),

	log(msg) {
		Zotero.debug("LLM Chat Pane [StructureSDT]: " + msg);
	},

	_scriptPath() {
		return PathUtils.join(LLMReferences._extensionRoot, "scripts", this._scriptName);
	},

	async _runNode(...scriptArgs) {
		if (!LLMReferences._extensionRoot) {
			throw new Error("Extension root path unavailable; cannot run SDT structure computation");
		}
		let nodePath = await LLMReferences._nodePath();
		let scriptPath = this._scriptPath();
		let setupPath = LLMReferences._pdfjsSetupPath();
		let stderrPath = scriptArgs[scriptArgs.length - 1] + ".err";
		let quotedArgs = scriptArgs.map(a => JSON.stringify(a)).join(" ");
		let cmd = `${JSON.stringify(nodePath)} --import ${JSON.stringify(setupPath)} ${JSON.stringify(scriptPath)} ${quotedArgs} 2>${JSON.stringify(stderrPath)}`;

		this.log(`_runNode: ${this._scriptName}`);
		let { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
		let proc = await Subprocess.call({ command: "/bin/sh", arguments: ["-c", cmd] });
		let { exitCode } = await proc.wait();

		let stderr = "";
		try { stderr = (await IOUtils.readUTF8(stderrPath)).trim(); } catch (e) {}
		IOUtils.remove(stderrPath).catch(() => {});
		if (stderr) this.log(`${this._scriptName} stderr: ${stderr}`);

		if (exitCode !== 0) {
			throw new Error(`${this._scriptName} failed (exit ${exitCode}): ${stderr || "(no stderr)"}`);
		}
	},

	async _structureCacheDir() {
		let dir = PathUtils.join(Zotero.DataDirectory.dir, "LLMz", "cache", "citation-structure");
		await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
		return dir;
	},

	async _structureCachePath(item) {
		return PathUtils.join(await this._structureCacheDir(), `${item.id}.json`);
	},

	// `llm/request.js` kicks off getReferenceIndex/getEquationIndex/
	// getTableIndex/getFigureIndex together (Promise.all) -- on a cold
	// cache (a newly opened PDF), all four would otherwise see "no cache
	// yet" and independently spawn their own compute_document_structure.js
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
			await this._runNode(pdfPath, structureCachePath);
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
