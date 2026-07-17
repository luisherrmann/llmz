// Retrieves the paper's own equations and formulas, the same way
// LLMReferences retrieves its bibliography -- via Zotero's document-worker
// structure pipeline (ML-based PDF layout classification, fetched at
// install time under sdt/document-worker/). The classifier tags each
// equation block directly (`type: 'equation'`); a trailing right-aligned
// "(N)" label identifies which ones the paper itself numbers and
// cross-references in its own prose (e.g.
// "as given by (3)") -- those get equation_num N. Blocks without one are
// still extracted, as a separately-numbered "Formula N" series (formula_num)
// -- see scripts/extract-equations.js for the exact extraction logic.
//
// Deployment (unpacking sdt/ for a packed .xpi install) is owned entirely by
// LLMReferences -- both modules run scripts against the exact same
// document-worker/pdf.js copy, so this reuses LLMReferences._extensionRoot/
// _nodePath()/_pdfjsSetupPath() rather than deploying (and keeping in sync) a
// second copy of a multi-file, non-trivial-sized submodule.
LLMEquations = {
	_scriptName: "extract-equations.js",
	_cacheVersion: 4, // bump when the cached index schema changes (JS-side, not just the script/model)
	_indexCache: new Map(),

	log(msg) {
		Zotero.debug("LLM Chat Pane [Equations]: " + msg);
	},

	_scriptPath() {
		return PathUtils.join(LLMReferences._extensionRoot, "scripts", this._scriptName);
	},

	async _extractRaw(item, onMessage) {
		let pdfPath = item.getFilePath();
		if (!pdfPath) throw new Error("Item has no attached file path");
		let outputPath = PathUtils.join(Zotero.DataDirectory.dir, "LLMz", "scripts", `equations_${item.id}.json`);
		await IOUtils.makeDirectory(PathUtils.join(Zotero.DataDirectory.dir, "LLMz", "scripts"), { ignoreExisting: true, createAncestors: true });
		let structureCachePath = await LLMStructureSDT.ensureStructureCache(item, onMessage);
		await LLMReferences._runNode(this._scriptPath(), this._scriptName, pdfPath, outputPath, structureCachePath);
		let equations = JSON.parse(await IOUtils.readUTF8(outputPath));
		IOUtils.remove(outputPath).catch(() => {});
		this.log(`_extractRaw: extracted ${equations.length} equations`);
		return equations;
	},

	async _cacheDir() {
		let dir = PathUtils.join(Zotero.DataDirectory.dir, "LLMz", "cache", "equation");
		await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
		return dir;
	},

	async _scriptFingerprint() {
		try {
			let stat = await IOUtils.stat(this._scriptPath());
			return `v${this._cacheVersion}|${stat.size}:${stat.lastModified}`;
		}
		catch (e) {
			return null;
		}
	},

	// `embeddingProvider`/`embeddingModel` are resolved ONCE by the caller
	// (getEquationIndex), not re-resolved here -- see getEquationIndex's own
	// comment for why (the same values are also needed for the memory-cache
	// check, which happens before this is ever called).
	async _loadDiskCache(item, embeddingProvider, embeddingModel) {
		try {
			let path = PathUtils.join(await this._cacheDir(), `${item.id}.json`);
			if (!await IOUtils.exists(path)) return null;
			let index = JSON.parse(await IOUtils.readUTF8(path));
			if (index.scriptFingerprint !== await this._scriptFingerprint()) {
				this.log(`_loadDiskCache: stale (extract-equations.js changed) for item ${item.id}`);
				return null;
			}
			// equations.embedding was computed via LLMCitation.embedBatched,
			// which routes through whichever embedding provider/model was
			// selected AT THAT TIME -- a cache built under a different
			// provider/model is silently incompatible (not comparable via
			// cosine similarity, even if the vector happens to be the same
			// length), so it must invalidate here too, same as
			// document/tables.js's/figures.js's own _loadDiskCache. This also
			// forces getEquationIndex back through its "fresh extraction"
			// branch on a provider/model switch, which is what actually gets
			// the NEW model's own embeddings.sqlite file (one file per model,
			// see embeddings-db.js) populated for this paper.
			if (index.embeddingProvider !== embeddingProvider || index.embeddingModel !== embeddingModel) {
				this.log(`_loadDiskCache: stale (embedding provider/model changed) for item ${item.id}`);
				return null;
			}
			this.log(`_loadDiskCache: loaded ${index.equations.length} equations for item ${item.id}`);
			return index;
		}
		catch (e) {
			this.log(`_loadDiskCache: failed: ${e.message}`);
			return null;
		}
	},

	async _saveDiskCache(item, index) {
		try {
			let path = PathUtils.join(await this._cacheDir(), `${item.id}.json`);
			// embedding is stripped before writing -- the embeddings DB (one
			// .sqlite file per model, see getEquationIndex's own sync right
			// after this call) is the sole store for the actual vectors now,
			// same reasoning as citation.js's/tables.js's/figures.js's own
			// disk caches. A shallow per-equation copy, not a mutation of
			// `index.equations` itself -- the caller keeps holding (and
			// memory-caching) that same object, unrelated to what actually
			// lands on disk.
			let diskIndex = {
				...index,
				equations: index.equations.map(({ embedding, ...rest }) => rest),
			};
			await IOUtils.writeUTF8(path, JSON.stringify(diskIndex, null, 2));
			this.log(`_saveDiskCache: saved ${index.equations.length} equations for item ${item.id}`);
		}
		catch (e) {
			this.log(`_saveDiskCache: failed: ${e.message}`);
		}
	},

	// Embeds each equation's own surrounding context -- preceding sentence +
	// the equation's own text + following sentence (see
	// scripts/extract-equations.js's preceding_sentence/following_sentence,
	// found by walking to the nearest real prose block on either side) --
	// joined into ONE string and embedded as ONE vector, unlike tables/
	// figures' separate caption/content embeddings. Equations don't have a
	// distinct "caption" the way a table/figure does (their own `label`,
	// e.g. "Equation 3", is a short generated tag, not real prose) -- the
	// surrounding sentences ARE the only real natural-language signal
	// available for what an equation is even about, so there's nothing
	// meaningful to split into two separate embeddings the way caption vs.
	// content is for tables. Missing sides (null preceding/following, e.g.
	// an equation opening/closing the document) are simply omitted rather
	// than embedding an empty placeholder.
	// `progress`, if given, has its setProgress(current, total) called as
	// batches complete -- same in-place progress reporting citation.js's
	// getTextIndex/tables.js's _addTextEmbeddings/figures.js's
	// _addCaptionEmbeddings do for their own embedding loops.
	async _addContextEmbeddings(equations, textModel, progress, provider) {
		if (!equations.length) return equations;
		if (!textModel) textModel = await LLMCitation.getEmbeddingModel();
		try {
			let texts = equations.map(eq => [eq.preceding_sentence, eq.text, eq.following_sentence].filter(Boolean).join(" "));
			let embeddings = await LLMCitation.embedBatched(texts, textModel, provider, {
				onProgress: (completed, total) => progress?.setProgress?.(completed, total),
			});
			for (let i = 0; i < equations.length; i++) {
				equations[i].embedding = embeddings[i];
			}
		}
		catch (e) {
			this.log(`_addContextEmbeddings: failed: ${e.message}`);
		}
		return equations;
	},

	// Returns the equation index for an item, using memory/disk cache where
	// possible. Index shape: { equations: [{ equation_num, formula_num,
	// label, text, preceding_sentence, following_sentence, embedding,
	// position }] } -- embedding starts absent from a disk-cache hit (never
	// persisted there, see _saveDiskCache's own comment) and is only ever
	// (re)computed on a fresh extraction below.
	// `onEmbeddingStart(provider, model)`, if given, is called ONLY when a
	// cache miss/staleness actually forces the context embeddings to be
	// recomputed (see citation.js's getTextIndex/tables.js's getTableIndex/
	// figures.js's getFigureIndex, same pattern) -- its return value (e.g. a
	// Logs entry's content element) is updated in place with a completion
	// line once recomputation finishes, rather than logging start/done as
	// two separate messages.
	async getEquationIndex(item, onEmbeddingStart, onMessage) {
		// Resolved BEFORE the memory-cache check below (not just threaded
		// through to _loadDiskCache further down) -- switching provider/
		// model mid-session must invalidate an already-loaded memory-cached
		// index too, since _loadDiskCache's own check would otherwise never
		// even run (only consulted on a memory-cache MISS).
		let embeddingProvider = LLMInterfaces._embeddingProvider;
		let embeddingModel = await LLMCitation.getEmbeddingModel();

		let memoryCached = this._indexCache.get(item.id);
		if (memoryCached && memoryCached.embeddingProvider === embeddingProvider && memoryCached.embeddingModel === embeddingModel) {
			this.log(`getEquationIndex: memory cache hit for item ${item.id}`);
			return memoryCached;
		}

		let cached = await this._loadDiskCache(item, embeddingProvider, embeddingModel);
		if (cached) {
			this._indexCache.set(item.id, cached);
			return cached;
		}

		let equations = await this._extractRaw(item, onMessage);
		let progress = equations.length ? onEmbeddingStart?.(embeddingProvider, embeddingModel) : null;
		let embedded = await this._addContextEmbeddings(equations, embeddingModel, progress, embeddingProvider);
		if (progress) progress.textContent = `Recomputed ${embedded.length} equation context embedding${embedded.length === 1 ? "" : "s"} using ${embeddingProvider} ${embeddingModel}.`;
		let index = { equations: embedded, scriptFingerprint: await this._scriptFingerprint(), embeddingProvider, embeddingModel };
		this._indexCache.set(item.id, index);
		await this._saveDiskCache(item, index);
		// Mirrors the disk-cache write into the embeddings DB (one .sqlite
		// file per model, see core/llm/embeddings-db.js) under source
		// "equation_context" -- matching document/tables.js's/figures.js's
		// own "table_caption"/"table_content"/"figure_caption" naming
		// convention. source_id is equation_id (already a stable,
		// always-present per-equation identifier regardless of which of the
		// equation_num/formula_num series it landed in, see
		// extract-equations.js's own header comment), not array position.
		// Filtered to equations that actually got an embedding --
		// _addContextEmbeddings' own try/catch means a total embedding-call
		// failure leaves EVERY equation without one, not a partial set, but
		// this stays defensive rather than assuming that. Best-effort, same
		// reasoning as citation.js's/tables.js's/figures.js's own sync -- the
		// disk cache above is already the source of truth LLMEquations
		// itself reads from; this DB is an additional, non-authoritative
		// mirror for now.
		try {
			let withEmbeddings = embedded.filter(eq => eq.embedding);
			await LLMEmbeddingsDB.replaceForPaper(item.id, embeddingModel, "equation_context",
				withEmbeddings.map(eq => ({ sourceId: eq.equation_id, embedding: eq.embedding })));
			onMessage?.(`Synced ${withEmbeddings.length} equation context embedding${withEmbeddings.length === 1 ? "" : "s"} to the embeddings DB for item ${item.id}.`);
		}
		catch (e) {
			this.log(`getEquationIndex: failed to sync to embeddings DB: ${e.message}`);
			onMessage?.(`Failed to sync equation context embeddings to the embeddings DB for item ${item.id}: ${e.message}`);
		}
		return index;
	},

	// Debug affordance ("Clear Cache" button) -- drops both the memory and
	// disk cache for this item, so the next getEquationIndex() call re-runs
	// extraction from scratch rather than reusing a possibly-stale result.
	async clearCache(item) {
		this._indexCache.delete(item.id);
		try {
			let path = PathUtils.join(await this._cacheDir(), `${item.id}.json`);
			await IOUtils.remove(path, { ignoreAbsent: true });
			this.log(`clearCache: cleared for item ${item.id}`);
		}
		catch (e) {
			this.log(`clearCache: failed: ${e.message}`);
		}
	},

	// Cheap disk existence check (no content read) -- used by
	// ui/advanced.js's "Library index status" bar to tell a fully-indexed
	// paper (every extraction type cached) from a partially-indexed one
	// (see LLMCitation.hasCache's own comment for the fuller rationale,
	// same idea applied to this module's own cache file).
	async hasCache(item) {
		let dir = await this._cacheDir();
		return IOUtils.exists(PathUtils.join(dir, `${item.id}.json`));
	},
};
