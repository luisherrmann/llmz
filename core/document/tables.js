LLMTables = {
	// SDT-only detection (see scripts/extract-tables-sdt.js) -- replaced the
	// old caption-anchored PyMuPDF pipeline (extract_tables.py, since
	// removed), which structurally couldn't find tables with no caption at
	// all, or an appendix-lettered one like "Table D.1". Reuses
	// LLMReferences's deployed sdt/ copy and Node-running infra
	// (_extensionRoot/_nodePath/_pdfjsSetupPath), the same way LLMEquations
	// already does, rather than deploying a second copy of sdt/ itself --
	// see LLMReferences' _siblingScriptNames.
	_sdtScriptName: "extract-tables-sdt.js",
	// Renders a table's own cropped JPEG on demand (see renderMissingImages
	// below) -- split out of the old extract_tables.py, which used to
	// render every table's image unconditionally as part of detection
	// itself. Now that detection is SDT-only (image_data always starts
	// null, see _extractRaw), this is invoked lazily only when something
	// actually needs an image (currently: tools/table-export.js's
	// image-grounded CSV conversion), against the bounding box SDT already
	// found -- avoids paying rendering cost on every chat message for
	// tables that never end up needing a rendered image at all. Never
	// persisted to the disk cache either (see _saveDiskCache) -- a rendered
	// JPEG is cheaply regenerable on demand from the already-cached
	// `position` bbox, so a table gets re-rendered fresh each time an
	// export actually needs it rather than accumulating rendered bytes in
	// the cache file, same reasoning as document/figures.js's own
	// renderMissingImages. Stays PyMuPDF (via _runPython) rather than
	// Zotero's own document-worker pdf.js rendering pipeline -- that was
	// prototyped too, but measured ~2.5-3x slower even after matching
	// render scale and JPEG output (Node/ESM/canvas startup overhead, not
	// encode work, so it doesn't shrink with tuning), and this plugin
	// already requires the Python venv regardless for figure extraction
	// (document/figures.js), so PyMuPDF here isn't adding a new dependency
	// either way.
	_renderScriptName: "render_crops.py",
	_cacheVersion: 5, // bump when the cached index schema changes (JS-side, not just Python scripts)
	_indexCache: new Map(),

	log(msg) {
		Zotero.debug("LLM Chat Pane [Tables]: " + msg);
	},

	// Delegates to LLMPythonSetup (core/python-setup.js), which owns the
	// venv's actual layout convention (Windows: Scripts/python.exe: Unix:
	// bin/python3) -- this must always resolve to the SAME path that
	// module's own setup() creates, so it's the single source of truth
	// rather than a second hardcoded copy.
	_pythonPath() {
		return LLMPythonSetup._venvPythonPath(LLMPythonSetup.venvDir());
	},

	_scriptPath(name) {
		return PathUtils.join(Zotero.DataDirectory.dir, "LLMz", "scripts", name);
	},

	async init(rootURI) {
		try {
			let dir = PathUtils.join(Zotero.DataDirectory.dir, "LLMz", "scripts");
			await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
			for (let name of [this._renderScriptName]) {
				let src = await Zotero.File.getContentsFromURL(rootURI + "scripts/" + name);
				let destPath = this._scriptPath(name);
				// Skipped when unchanged -- an unconditional rewrite here bumps
				// the file's mtime on every single plugin startup even when its
				// content is identical, which invalidates _scriptFingerprint()
				// (and therefore the disk cache built on getTableIndex below) on
				// the first prompt after every restart, forcing a needless
				// re-extraction.
				let existing = null;
				try {
					existing = await IOUtils.readUTF8(destPath);
				}
				catch (e) {} // doesn't exist yet -- fall through to write
				if (existing === src) {
					this.log(`init: ${name} already up to date, skipping rewrite`);
					continue;
				}
				await IOUtils.writeUTF8(destPath, src);
				this.log(`init: deployed ${name}`);
			}
		}
		catch (e) {
			this.log(`init: failed to deploy script: ${e.message}`);
		}
	},

	async _runPython(scriptName, ...scriptArgs) {
		let scriptPath = this._scriptPath(scriptName);
		let pythonPath = this._pythonPath();
		let stderrPath = scriptArgs[scriptArgs.length - 1] + ".err";
		let quotedArgs = scriptArgs.map(a => JSON.stringify(a)).join(" ");
		let cmd = `${JSON.stringify(pythonPath)} ${JSON.stringify(scriptPath)} ${quotedArgs} 2>${JSON.stringify(stderrPath)}`;

		this.log(`_runPython: ${scriptName}`);
		let { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
		let proc = await Subprocess.call({ command: "/bin/sh", arguments: ["-c", cmd] });
		let { exitCode } = await proc.wait();

		let stderr = "";
		try { stderr = (await IOUtils.readUTF8(stderrPath)).trim(); } catch (e) {}
		IOUtils.remove(stderrPath).catch(() => {});
		if (stderr) this.log(`${scriptName} stderr: ${stderr}`);

		if (exitCode !== 0) {
			throw new Error(`${scriptName} failed (exit ${exitCode}): ${stderr || "(no stderr)"}`);
		}
	},

	_nodeScriptPath(name) {
		return PathUtils.join(LLMReferences._extensionRoot, "scripts", name);
	},


	async _cacheDir() {
		let dir = PathUtils.join(Zotero.DataDirectory.dir, "LLMz", "cache", "table");
		await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
		return dir;
	},

	async _scriptFingerprint() {
		try {
			// Only the SDT script matters -- detection is SDT-only (see
			// _extractRaw/getTableIndex); render_crops.py's own mtime
			// shouldn't affect cache validity since it only ever fills in
			// image_data lazily, on demand, after the index is already built.
			let stat = await IOUtils.stat(this._nodeScriptPath(this._sdtScriptName));
			return `v${this._cacheVersion}|${stat.size}:${stat.lastModified}`;
		}
		catch (e) {
			return null;
		}
	},

	// `embeddingProvider`/`embeddingModel` are resolved ONCE by the caller
	// (getTableIndex), not re-resolved here -- see getTableIndex's own
	// comment for why (the same values are also needed for the memory-cache
	// check, which happens before this is ever called).
	async _loadDiskCache(item, embeddingProvider, embeddingModel) {
		try {
			let path = PathUtils.join(await this._cacheDir(), `${item.id}.json`);
			if (!await IOUtils.exists(path)) return null;
			let index = JSON.parse(await IOUtils.readUTF8(path));
			if (index.scriptFingerprint !== await this._scriptFingerprint()) {
				this.log(`_loadDiskCache: stale (extract-tables-sdt.js changed) for item ${item.id}`);
				return null;
			}
			// tables.captionEmbedding/contentEmbedding were computed via
			// LLMCitation.getEmbedding(Batched), which routes through
			// whichever embedding provider/model was selected AT THAT TIME --
			// a cache built under a different provider/model is silently
			// incompatible (not comparable via cosine similarity, even if the
			// vector happens to be the same length), so it must invalidate
			// here too, same as document/figures.js's own _loadDiskCache.
			// This also forces getTableIndex back through its "fresh
			// extraction" branch on a provider/model switch, which is what
			// actually gets the NEW model's own embeddings.sqlite file (one
			// file per model, see embeddings-db.js) populated for this paper
			// -- without this check, a disk-cache hit would skip that sync
			// entirely and silently leave the new model blind to this paper.
			if (index.embeddingProvider !== embeddingProvider || index.embeddingModel !== embeddingModel) {
				this.log(`_loadDiskCache: stale (embedding provider/model changed) for item ${item.id}`);
				return null;
			}
			this.log(`_loadDiskCache: loaded ${index.tables.length} tables for item ${item.id}`);
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
			// image_data is stripped before writing -- it's a real rendered
			// JPEG (base64), regenerable on demand from `position` (the
			// bounding box) via renderMissingImages whenever actually needed,
			// so persisting it here would just be dead weight bloating this
			// cache file for tables that never end up exported.
			// captionEmbedding/contentEmbedding are stripped for the same
			// reason as citation.js's/figures.js's own disk caches --
			// embeddings.sqlite (one file per model, see getTableIndex's own
			// sync right after this call) is the sole store for the actual
			// vectors now. All three are a shallow per-table copy, not a
			// mutation of `index.tables` itself -- the caller keeps holding
			// (and memory-caching) that same object, unrelated to what
			// actually lands on disk.
			let diskIndex = {
				...index,
				tables: index.tables.map(({ image_data, captionEmbedding, contentEmbedding, ...rest }) => rest),
			};
			await IOUtils.writeUTF8(path, JSON.stringify(diskIndex, null, 2));
			this.log(`_saveDiskCache: saved ${index.tables.length} tables for item ${item.id}`);
		}
		catch (e) {
			this.log(`_saveDiskCache: failed: ${e.message}`);
		}
	},

	async _extractRaw(item, onMessage) {
		let pdfPath = item.getFilePath();
		if (!pdfPath) throw new Error("Item has no attached file path");
		let outputPath = PathUtils.join(Zotero.DataDirectory.dir, "LLMz", "scripts", `tables_${item.id}.json`);
		let structureCachePath = await LLMStructureSDT.ensureStructureCache(item, onMessage);
		// SDT-only detection via _runNode, not _runPython (see
		// _sdtScriptName's own comment).
		await LLMReferences._runNode(this._nodeScriptPath(this._sdtScriptName), this._sdtScriptName, pdfPath, outputPath, structureCachePath);
		let tables = JSON.parse(await IOUtils.readUTF8(outputPath));
		IOUtils.remove(outputPath).catch(() => {});
		this.log(`_extractRaw: extracted ${tables.length} tables`);
		return tables;
	},

	// Lazily renders image_data for whichever of `tables` don't already have
	// it (see scripts/render_crops.py and _renderScriptName's own
	// comment) -- against each table's own cached `position` (the bounding
	// box the SDT-only detection already found, no re-detection needed), so
	// a caller like tools/table-export.js's image-grounded CSV conversion
	// can get real renders without every table paying that cost up front.
	// Mutates the given table objects in place (image_data set directly on
	// each) and returns them. Does NOT persist the render back to the disk
	// cache -- image_data is deliberately stripped before every
	// _saveDiskCache write (see its own comment), so a table gets
	// re-rendered fresh each time it's actually needed within THIS session
	// (still cheap: the memory-cached `tables` objects getTableIndex holds
	// keep whatever's already been rendered for the rest of the session,
	// same as document/figures.js's own renderMissingImages). No-ops (no
	// subprocess call at all) if every table already has an image.
	async renderMissingImages(item, tables) {
		let missing = tables.filter(t => !t.image_data && t.position?.rects?.[0]);
		if (!missing.length) return tables;

		let scriptsDir = PathUtils.join(Zotero.DataDirectory.dir, "LLMz", "scripts");
		let stamp = `${item.id}_${Date.now()}`;
		let regionsPath = PathUtils.join(scriptsDir, `render_in_${stamp}.json`);
		let outputPath = PathUtils.join(scriptsDir, `render_out_${stamp}.json`);
		let regions = missing.map((t, i) => ({
			index: i,
			page_num: t.position.pageIndex + 1,
			bbox: t.position.rects[0],
		}));
		await IOUtils.writeUTF8(regionsPath, JSON.stringify(regions));
		try {
			await this._runPython(this._renderScriptName, item.getFilePath(), regionsPath, outputPath);
		}
		finally {
			IOUtils.remove(regionsPath).catch(() => {});
		}
		let rendered = JSON.parse(await IOUtils.readUTF8(outputPath));
		IOUtils.remove(outputPath).catch(() => {});
		for (let r of rendered) {
			missing[r.index].image_data = r.image_data;
		}
		this.log(`renderMissingImages: rendered ${rendered.length}/${missing.length} table image(s)`);
		return tables;
	},

	// Flattens extracted table rows into plain text for text-embedding, e.g.:
	// "Header A | Header B\nrow1a | row1b\nrow2a | row2b"
	_flattenTableData(data) {
		return (data || []).map(row => row.join(" | ")).join("\n");
	},

	// Embeds each table's "label: caption" and its flattened cell content
	// (tab.contentText, already set by getTableIndex before this runs) as
	// text, so a query can be matched against either via text-to-text
	// similarity, and so both get synced to the embeddings DB (see
	// getTableIndex's own sync right after this call) under separate
	// sources ("table_caption"/"table_content") for future cross-library
	// table retrieval -- kept as two independent vectors rather than one
	// combined embedding: caption and content are different-length,
	// different-quality signals (content is often a long, unstructured
	// flattened blob -- see extract-tables-sdt.js's own TableNode.content
	// comment elsewhere -- while caption is one clean sentence), and
	// combining them into a single vector risks the longer/noisier one
	// diluting the other; keeping them separate lets a future retrieval
	// step query both independently and union the results instead.
	// `progress`, if given, has its setProgress(current, total) called as
	// batches complete -- same in-place progress reporting citation.js's
	// getTextIndex/figures.js's _addCaptionEmbeddings do for their own
	// embedding loops. Batched+concurrency-limited via
	// LLMCitation.embedBatched rather than one request per table/per field.
	async _addTextEmbeddings(tables, textModel, progress, provider) {
		if (!tables.length) return tables;
		if (!textModel) textModel = await LLMCitation.getEmbeddingModel();
		try {
			let captionTexts = tables.map(t => `${t.label}: ${t.caption}`);
			let contentTexts = tables.map(t => t.contentText);
			let total = tables.length * 2;
			let captionEmbeddings = await LLMCitation.embedBatched(captionTexts, textModel, provider, {
				onProgress: completed => progress?.setProgress?.(completed, total),
			});
			let contentEmbeddings = await LLMCitation.embedBatched(contentTexts, textModel, provider, {
				onProgress: completed => progress?.setProgress?.(tables.length + completed, total),
			});
			for (let i = 0; i < tables.length; i++) {
				tables[i].captionEmbedding = captionEmbeddings[i];
				tables[i].contentEmbedding = contentEmbeddings[i];
			}
		}
		catch (e) {
			this.log(`_addTextEmbeddings: failed: ${e.message}`);
		}
		return tables;
	},

	// Returns the table index for an item, using memory/disk cache where
	// possible. Index shape: { tables: [{ ..., contentText, captionEmbedding,
	// contentEmbedding, image_data }] } -- captionEmbedding/contentEmbedding/
	// image_data all start absent from a disk-cache hit (none of the three
	// are ever persisted there, see _saveDiskCache's own comment) and are
	// only ever (re)computed on a fresh extraction below/filled in on demand
	// by renderMissingImages.
	// `onEmbeddingStart(provider, model)`, if given, is called ONLY when a
	// cache miss/staleness actually forces the text embeddings to be
	// recomputed (see citation.js's getTextIndex/figures.js's
	// getFigureIndex, same pattern) -- its return value (e.g. a Logs entry's
	// content element) is updated in place with a completion line once
	// recomputation finishes, rather than logging start/done as two
	// separate messages.
	async getTableIndex(item, onEmbeddingStart, onMessage) {
		// Resolved BEFORE the memory-cache check below (not just threaded
		// through to _loadDiskCache further down) -- switching provider/
		// model mid-session must invalidate an already-loaded memory-cached
		// index too, since _loadDiskCache's own check would otherwise never
		// even run (only consulted on a memory-cache MISS).
		let embeddingProvider = LLMInterfaces._embeddingProvider;
		let embeddingModel = await LLMCitation.getEmbeddingModel();

		let memoryCached = this._indexCache.get(item.id);
		if (memoryCached && memoryCached.embeddingProvider === embeddingProvider && memoryCached.embeddingModel === embeddingModel) {
			this.log(`getTableIndex: memory cache hit for item ${item.id}`);
			return memoryCached;
		}

		let cached = await this._loadDiskCache(item, embeddingProvider, embeddingModel);
		if (cached) {
			this._indexCache.set(item.id, cached);
			return cached;
		}

		let tables = await this._extractRaw(item, onMessage);
		// Computed unconditionally, before embedding -- cheap (no network
		// call, just a local join, see _flattenTableData), a real dependency
		// of tools/table-export.js's CSV-conversion prompt regardless of
		// embeddings, and _addTextEmbeddings below reads tab.contentText
		// directly rather than recomputing it itself.
		for (let tab of tables) {
			tab.contentText = this._flattenTableData(tab.data);
		}
		let progress = tables.length ? onEmbeddingStart?.(embeddingProvider, embeddingModel) : null;
		let embedded = await this._addTextEmbeddings(tables, embeddingModel, progress, embeddingProvider);
		if (progress) progress.textContent = `Recomputed ${embedded.length} table caption/content embedding${embedded.length === 1 ? "" : "s"} using ${embeddingProvider} ${embeddingModel}.`;
		let index = { tables: embedded, scriptFingerprint: await this._scriptFingerprint(), embeddingProvider, embeddingModel };
		this._indexCache.set(item.id, index);
		await this._saveDiskCache(item, index);
		// Mirrors the disk-cache write into the embeddings DB (one .sqlite
		// file per model, see core/llm/embeddings-db.js) -- source_id is
		// table_id (already a stable, always-present per-table identifier,
		// see extract-tables-sdt.js's own header comment), not array
		// position, since that's the same handle callers already use to
		// look a table back up in this cache file. Two separate sources
		// ("table_caption"/"table_content") rather than one, matching
		// _addTextEmbeddings' own reasoning for keeping them as separate
		// vectors. Filtered to tables that actually got an embedding --
		// _addTextEmbeddings' own try/catch means a total embedding-call
		// failure leaves EVERY table without one, not a partial set, but
		// this stays defensive rather than assuming that. Best-effort, same
		// reasoning as citation.js's/figures.js's own sync -- the disk cache
		// above is already the source of truth LLMTables itself reads from;
		// this DB is an additional, non-authoritative mirror for now.
		try {
			let withCaption = embedded.filter(t => t.captionEmbedding);
			let withContent = embedded.filter(t => t.contentEmbedding);
			await LLMEmbeddingsDB.replaceForPaper(item.id, embeddingModel, "table_caption",
				withCaption.map(t => ({ sourceId: t.table_id, embedding: t.captionEmbedding })));
			await LLMEmbeddingsDB.replaceForPaper(item.id, embeddingModel, "table_content",
				withContent.map(t => ({ sourceId: t.table_id, embedding: t.contentEmbedding })));
			onMessage?.(`Synced ${withCaption.length} table caption and ${withContent.length} table content embedding${(withCaption.length + withContent.length) === 1 ? "" : "s"} to the embeddings DB for item ${item.id}.`);
		}
		catch (e) {
			this.log(`getTableIndex: failed to sync to embeddings DB: ${e.message}`);
			onMessage?.(`Failed to sync table embeddings to the embeddings DB for item ${item.id}: ${e.message}`);
		}
		return index;
	},

	// Debug affordance ("Clear Cache" button) -- drops both the memory and
	// disk cache for this item, so the next getTableIndex() call re-runs
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
