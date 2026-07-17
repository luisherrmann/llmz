LLMFigures = {
	// SDT-only detection (see scripts/extract_figures_sdt.js) -- replaced the
	// old caption-anchored PyMuPDF pipeline (extract_figures.py, since
	// removed), which structurally couldn't find a figure with no caption at
	// all, or an appendix-lettered one like "Figure D.1". Reuses
	// LLMReferences's deployed sdt/ copy and Node-running infra
	// (_extensionRoot/_nodePath/_pdfjsSetupPath), the same way
	// document/tables.js already does -- see LLMReferences'
	// _siblingScriptNames.
	_sdtScriptName: "extract_figures_sdt.js",
	// Ground-truth image regions from PyMuPDF (see scripts/list_page_images.py's
	// own comment for the full rationale), run BEFORE _sdtScriptName and fed
	// into it as an extra candidate source -- SDT is much better at finding
	// CAPTIONS (recognizing "Fig. 3." even when misclassified as a heading
	// or plain paragraph) than at reliably classifying every genuine image
	// region as `type: 'image'` (observed on Pairoh et al.: a photo
	// dominated by a small watermark stamp came back type: 'paragraph',
	// with no distinctive text for a caption-style regex trick to catch --
	// unlike a caption, an image has no content-based signal to
	// pattern-match against, so this asks PyMuPDF what images genuinely
	// exist instead of guessing from block size/text-density).
	_imageListScriptName: "list_page_images.py",
	// Renders a figure's own cropped JPEG on demand (see renderMissingImages
	// below) -- split out of the old extract_figures.py, which used to
	// render each figure's image unconditionally as part of caption-anchored
	// detection itself. Detection is SDT-only now (image_data always starts
	// null, see _extractRaw), so this is invoked lazily only when something
	// actually needs an image (currently: llm/request.js's "attach this
	// figure as image context for a vision-capable model" feature, only for
	// whichever figures selectFiguresWithLLM actually picked for THIS chat
	// turn), against the bounding box SDT already found -- same on-demand
	// pattern document/tables.js already uses for its own renderMissingImages,
	// avoiding paying render cost (and cache-file size) for every figure in
	// a paper up front when most chat turns only ever need one or two.
	_renderScriptName: "render_crops.py",
	_cacheVersion: 6, // bump when the cached index schema changes (JS-side, not just Python scripts)
	_venvMissing: false,
	_indexCache: new Map(),

	log(msg) {
		Zotero.debug("LLM Chat Pane [Figures]: " + msg);
	},

	// Delegates to LLMPythonSetup (core/python-setup.js), which owns the
	// venv's actual layout convention (Windows: Scripts/python.exe; Unix:
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
		// Still required -- render_crops.py needs PyMuPDF -- even though
		// DETECTION itself (extract_figures_sdt.js, deployed separately by
		// LLMReferences alongside its own sdt/ copy) no longer needs it.
		let pythonPath = this._pythonPath();
		if (!await IOUtils.exists(pythonPath)) {
			this._venvMissing = true;
			this.log(`init: venv not found at ${pythonPath}`);
			this.log("init: set it up with the \"venv\" button, or manually:");
			this.log("  python3 -m venv ~/Zotero/LLMz/venv");
			this.log("  ~/Zotero/LLMz/venv/bin/pip install -r requirements.txt");
		}
		else {
			this._venvMissing = false;
			this.log(`init: venv found at ${pythonPath}`);
		}

		try {
			let dir = PathUtils.join(Zotero.DataDirectory.dir, "LLMz", "scripts");
			await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
			for (let name of [this._imageListScriptName, this._renderScriptName]) {
				let src = await Zotero.File.getContentsFromURL(rootURI + "scripts/" + name);
				let destPath = this._scriptPath(name);
				// Skipped when unchanged -- an unconditional rewrite here bumps
				// the file's mtime on every single plugin startup even when its
				// content is identical, which invalidates _scriptFingerprint()
				// (and therefore the disk cache built on getFigureIndex below) on
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
			this.log(`init: failed to deploy scripts: ${e.message}`);
		}
	},

	// Run a bundled Python script (render/embed only -- detection goes
	// through _runNode below). scriptArgs are passed after the script path;
	// the last arg is assumed to be the output path and is used as the
	// stderr file base.
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
		let dir = PathUtils.join(Zotero.DataDirectory.dir, "LLMz", "cache", "figure");
		await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
		return dir;
	},

	async _scriptFingerprint() {
		try {
			let parts = [`v${this._cacheVersion}`];
			let sdtStat = await IOUtils.stat(this._nodeScriptPath(this._sdtScriptName));
			parts.push(`${sdtStat.size}:${sdtStat.lastModified}`);
			// render_crops.py deliberately excluded here -- it only ever fills
			// in image_data lazily, on demand, AFTER the index is already built
			// (see renderMissingImages), and image_data is never persisted to
			// this cache anyway (see _saveDiskCache), so its own mtime has no
			// bearing on whether this cache is still valid -- same reasoning
			// as document/tables.js's own _scriptFingerprint.
			let stat = await IOUtils.stat(this._scriptPath(this._imageListScriptName));
			parts.push(`${stat.size}:${stat.lastModified}`);
			return parts.join("|");
		}
		catch (e) {
			return null;
		}
	},

	// `embeddingProvider`/`embeddingModel` are resolved ONCE by the caller
	// (getFigureIndex), not re-resolved here -- see getFigureIndex's own
	// comment for why (the same values are also needed for the memory-cache
	// check, which happens before this is ever called).
	async _loadDiskCache(item, embeddingProvider, embeddingModel) {
		try {
			let path = PathUtils.join(await this._cacheDir(), `${item.id}.json`);
			if (!await IOUtils.exists(path)) return null;
			let index = JSON.parse(await IOUtils.readUTF8(path));
			if (index.scriptFingerprint !== await this._scriptFingerprint()) {
				this.log(`_loadDiskCache: stale (extraction/render/embed scripts changed) for item ${item.id}`);
				return null;
			}
			// figures.captionEmbedding was computed via LLMCitation.getEmbedding,
			// which now routes through whichever embedding provider/model was
			// selected AT THAT TIME (see llm/interfaces.js's getEmbedding) -- a
			// cache built under a different provider/model is silently
			// incompatible (not comparable via cosine similarity, even if the
			// vector happens to be the same length), so it must invalidate here
			// too, same as LLMCitation's own citation-index cache.
			if (index.embeddingProvider !== embeddingProvider || index.embeddingModel !== embeddingModel) {
				this.log(`_loadDiskCache: stale (embedding provider/model changed) for item ${item.id}`);
				return null;
			}
			this.log(`_loadDiskCache: loaded ${index.figures.length} figures for item ${item.id}`);
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
			// captionEmbedding is stripped before writing -- the embeddings DB
			// (see getFigureIndex's own sync right before this call) is the
			// sole store for the actual vectors now, same reasoning as
			// citation.js's sentence/paragraph caches. image_data is stripped
			// too -- it's a real rendered JPEG (base64), regenerable on demand
			// from `position` (the bounding box) via renderMissingImages
			// whenever actually needed, so persisting it here would just be
			// dead weight bloating this cache file for figures that never end
			// up attached to a chat turn. Both are a shallow per-figure copy,
			// not a mutation of `index.figures` itself -- the caller keeps
			// holding (and memory-caching) that same object, image_data and
			// all, unrelated to what actually lands on disk.
			let diskIndex = {
				...index,
				figures: index.figures.map(({ captionEmbedding, image_data, ...rest }) => rest),
			};
			await IOUtils.writeUTF8(path, JSON.stringify(diskIndex, null, 2));
			this.log(`_saveDiskCache: saved ${index.figures.length} figures for item ${item.id}`);
		}
		catch (e) {
			this.log(`_saveDiskCache: failed: ${e.message}`);
		}
	},

	// Extract figures from the PDF -- SDT-based caption/structure detection
	// (via _sdtScriptName), with PyMuPDF-sourced ground-truth image regions
	// (via _imageListScriptName, see its own comment) fed in as an extra
	// body-candidate source. Returns raw entries with image_data always
	// null (see _sdtScriptName's own comment) -- renderMissingImages below
	// fills it in later, lazily, only for whichever figures actually end up
	// needing a render.
	async _extractRaw(item, onMessage) {
		let pdfPath = item.getFilePath();
		if (!pdfPath) throw new Error("Item has no attached file path");
		let scriptsDir = PathUtils.join(Zotero.DataDirectory.dir, "LLMz", "scripts");
		let imagesPath = PathUtils.join(scriptsDir, `figure_images_${item.id}.json`);
		let outputPath = PathUtils.join(scriptsDir, `figures_${item.id}.json`);
		let structureCachePath = await LLMStructureSDT.ensureStructureCache(item, onMessage);
		// Best-effort: if PyMuPDF's image listing fails for any reason (e.g.
		// the venv is present but somehow broken), detection still proceeds
		// SDT-only, exactly as it did before this extra step existed --
		// this ground-truth source is a supplement, not a hard dependency.
		try {
			await this._runPython(this._imageListScriptName, pdfPath, imagesPath);
		}
		catch (e) {
			this.log(`_extractRaw: list_page_images.py failed, continuing SDT-only: ${e.message}`);
			await IOUtils.remove(imagesPath, { ignoreAbsent: true });
		}
		let imagesArg = await IOUtils.exists(imagesPath) ? imagesPath : "";
		await LLMReferences._runNode(this._nodeScriptPath(this._sdtScriptName), this._sdtScriptName, pdfPath, outputPath, imagesArg, structureCachePath);
		IOUtils.remove(imagesPath).catch(() => {});
		let figures = JSON.parse(await IOUtils.readUTF8(outputPath));
		IOUtils.remove(outputPath).catch(() => {});
		this.log(`_extractRaw: extracted ${figures.length} figures`);
		return figures;
	},

	// Lazily renders image_data for whichever of `figures` don't already have
	// it (see scripts/render_crops.py and _renderScriptName's own comment)
	// -- against each figure's own cached `position` (the bounding box the
	// SDT detection already found, no re-detection needed), so a caller like
	// llm/request.js's image-context step can get a real render for just the
	// handful of figures an LLM selection actually picked, without every
	// figure in the paper paying that cost up front. Mutates the given
	// figure objects in place (image_data set directly on each) and also
	// returns them. Unlike document/tables.js's own renderMissingImages, this
	// does NOT persist the render back to the disk cache -- image_data is
	// deliberately stripped before every _saveDiskCache write (see its own
	// comment), so a figure gets re-rendered fresh each time it's actually
	// needed rather than accumulating rendered bytes in the cache file.
	// No-ops (no subprocess call at all) if every figure already has an image.
	async renderMissingImages(item, figures) {
		let missing = figures.filter(f => !f.image_data && f.position?.rects?.[0]);
		if (!missing.length) return figures;

		let scriptsDir = PathUtils.join(Zotero.DataDirectory.dir, "LLMz", "scripts");
		let stamp = `${item.id}_${Date.now()}`;
		let regionsPath = PathUtils.join(scriptsDir, `render_in_${stamp}.json`);
		let outputPath = PathUtils.join(scriptsDir, `render_out_${stamp}.json`);
		let regions = missing.map((f, i) => ({
			index: i,
			page_num: f.position.pageIndex + 1,
			bbox: f.position.rects[0],
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
		this.log(`renderMissingImages: rendered ${rendered.length}/${missing.length} figure image(s)`);
		return figures;
	},

	// Returns the figure index for an item, using memory/disk cache where possible.
	// Index shape: { figures: [{ page_num, figure_num, figure_extra_num, figure_id, label, caption, captionEmbedding, image_data, position }] }
	// -- image_data starts null here (and stays absent from the disk cache,
	// see _saveDiskCache's own comment); it's only ever filled in on demand,
	// per-figure, by renderMissingImages above.
	// `onEmbeddingStart(provider, model)`, if given, is called ONLY when a
	// cache miss/staleness actually forces the caption embeddings to be
	// recomputed (see citation.js's getTextIndex, same pattern) -- its
	// return value (e.g. a Logs entry's content element) is updated in
	// place with a completion line once recomputation finishes, rather
	// than logging start/done as two separate messages.
	async getFigureIndex(item, onEmbeddingStart, onMessage) {
		if (this._venvMissing) {
			throw new Error(
				"Python venv not found. Set it up with the \"venv\" button, or manually:\n"
				+ "  python3 -m venv ~/Zotero/LLMz/venv\n"
				+ "  ~/Zotero/LLMz/venv/bin/pip install -r requirements.txt"
			);
		}

		// Resolved BEFORE the memory-cache check below (not just threaded
		// through to _loadDiskCache/the final index) -- switching
		// provider/model mid-session must invalidate an already-loaded
		// memory-cached index too, since _loadDiskCache's own check would
		// otherwise never even run (only consulted on a memory-cache MISS).
		let embeddingProvider = LLMInterfaces._embeddingProvider;
		let embeddingModel = await LLMCitation.getEmbeddingModel();

		let memoryCached = this._indexCache.get(item.id);
		if (memoryCached && memoryCached.embeddingProvider === embeddingProvider && memoryCached.embeddingModel === embeddingModel) {
			this.log(`getFigureIndex: memory cache hit for item ${item.id}`);
			return memoryCached;
		}

		let cached = await this._loadDiskCache(item, embeddingProvider, embeddingModel);
		if (cached) {
			this._indexCache.set(item.id, cached);
			return cached;
		}

		let figures = await this._extractRaw(item, onMessage);
		let progress = figures.length ? onEmbeddingStart?.(embeddingProvider, embeddingModel) : null;
		let embedded = await this._addCaptionEmbeddings(figures, embeddingModel, progress, embeddingProvider);
		if (progress) progress.textContent = `Recomputed ${embedded.length} figure caption embedding${embedded.length === 1 ? "" : "s"} using ${embeddingProvider} ${embeddingModel}.`;
		let index = { figures: embedded, scriptFingerprint: await this._scriptFingerprint(), embeddingProvider, embeddingModel };
		this._indexCache.set(item.id, index);
		await this._saveDiskCache(item, index);
		// Mirrors the disk-cache write into the embeddings DB (one .sqlite
		// file per model, see core/llm/embeddings-db.js) under source
		// "figure_caption" -- matching document/tables.js's own
		// "table_caption"/"table_content" naming convention, so a future
		// cross-library retrieval step querying across all three has a
		// predictable, self-documenting source taxonomy to work from rather
		// than a bare "figure" that reads ambiguously once tables have two
		// sources of their own. source_id is figure_id (already a stable,
		// always-present per-figure identifier, see extract_figures_sdt.js's
		// own header comment), not array position, since that's the same
		// handle callers already use to look a figure back up in this cache
		// file. Filtered to figures that actually got
		// a captionEmbedding -- _addCaptionEmbeddings' own try/catch means a
		// total embedding-call failure leaves EVERY figure without one, not
		// a partial set, but this stays defensive rather than assuming that.
		// Best-effort, same reasoning as citation.js's own sync -- the disk
		// cache above is already the source of truth LLMFigures itself
		// reads from; this DB is an additional, non-authoritative mirror
		// for now.
		try {
			let withEmbeddings = embedded.filter(f => f.captionEmbedding);
			await LLMEmbeddingsDB.replaceForPaper(item.id, embeddingModel, "figure_caption",
				withEmbeddings.map(f => ({ sourceId: f.figure_id, embedding: f.captionEmbedding })));
			onMessage?.(`Synced ${withEmbeddings.length} figure embedding${withEmbeddings.length === 1 ? "" : "s"} to the embeddings DB for item ${item.id}.`);
		}
		catch (e) {
			this.log(`getFigureIndex: failed to sync to embeddings DB: ${e.message}`);
			onMessage?.(`Failed to sync figure embeddings to the embeddings DB for item ${item.id}: ${e.message}`);
		}
		return index;
	},

	// Debug affordance ("Clear Cache" button) -- drops both the memory and
	// disk cache for this item, so the next getFigureIndex() call re-runs
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

	// Embeds each figure's "label: caption" as text (nomic-embed-text), so a
	// query can be matched against it via plain text-to-text similarity. Tested
	// empirically against the image embeddings (nomic-embed-vision, joint latent
	// space with nomic-embed-text): text-to-text scored far higher and more
	// discriminatively (0.5-0.87 vs. 0.04-0.08) and, unlike image similarity,
	// correctly handles explicit "figure N" references, since the caption text
	// itself starts with "Figure N:".
	// `progress`, if given, has its setProgress(current, total) called as
	// batches complete -- same in-place progress reporting citation.js's
	// getTextIndex does for its own embedding loop (see llm/request.js's
	// onEmbeddingStart for what setProgress actually does to the Logs/reply
	// bubble). Batched+concurrency-limited via LLMCitation.embedBatched
	// rather than one request per figure -- see its own comment.
	async _addCaptionEmbeddings(figures, textModel, progress, provider) {
		if (!figures.length) return figures;
		if (!textModel) textModel = await LLMCitation.getEmbeddingModel();
		try {
			let texts = figures.map(fig => `${fig.label}: ${fig.caption}`);
			let embeddings = await LLMCitation.embedBatched(texts, textModel, provider, {
				onProgress: (completed, total) => progress?.setProgress?.(completed, total),
			});
			for (let i = 0; i < figures.length; i++) {
				figures[i].captionEmbedding = embeddings[i];
			}
		}
		catch (e) {
			this.log(`_addCaptionEmbeddings: failed: ${e.message}`);
		}
		return figures;
	},
};
