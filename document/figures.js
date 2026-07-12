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
	// Renders every figure's own cropped JPEG (see scripts/render_crops.py)
	// -- split out of the old extract_figures.py, which used to render each
	// figure's image unconditionally as part of caption-anchored detection
	// itself. Detection is SDT-only now (image_data always starts null, see
	// _extractRaw), so this runs as its own step -- but UNLIKE
	// document/tables.js's own use of this same script (invoked lazily,
	// only on-demand for a table export), this runs EAGERLY, right after
	// every getFigureIndex extraction, because a figure's image_data is a
	// hard dependency of TWO things on the normal chat path, not just an
	// occasional export: _embedRaw below (nomic-embed-vision needs a real
	// image to embed) and request.js's "attach this figure as image context
	// for a vision-capable model" feature (the image itself, not just a
	// caption, is what gets sent) -- there's no realistic "figure resolved
	// but its image never needed" case for figures the way there is for
	// tables (whose image is only needed for the comparatively rare
	// image-grounded CSV export), so deferring it here would just mean
	// paying the same render cost anyway, on every relevant chat request
	// rather than once at extraction time.
	_renderScriptName: "render_crops.py",
	_embedScriptName: "embed_figures.py",
	_cacheVersion: 4, // bump when the cached index schema changes (JS-side, not just Python scripts)
	_venvMissing: false,
	_indexCache: new Map(),

	log(msg) {
		Zotero.debug("LLM Chat Pane [Figures]: " + msg);
	},

	_pythonPath() {
		return PathUtils.join(Zotero.DataDirectory.dir, "LLMz", "venv", "bin", "python3");
	},

	_scriptPath(name) {
		return PathUtils.join(Zotero.DataDirectory.dir, "LLMz", "scripts", name);
	},

	async init(rootURI) {
		// Still required -- render_crops.py needs PyMuPDF, embed_figures.py
		// needs transformers/torch/Pillow/einops -- even though DETECTION
		// itself (extract_figures_sdt.js, deployed separately by
		// LLMReferences alongside its own sdt/ copy) no longer needs it.
		let pythonPath = this._pythonPath();
		if (!await IOUtils.exists(pythonPath)) {
			this._venvMissing = true;
			this.log(`init: venv not found at ${pythonPath}`);
			this.log("init: set it up with:");
			this.log("  /opt/homebrew/bin/python3 -m venv ~/Zotero/LLMz/venv");
			this.log("  ~/Zotero/LLMz/venv/bin/pip install pymupdf transformers torch Pillow einops");
		}
		else {
			this._venvMissing = false;
			this.log(`init: venv found at ${pythonPath}`);
		}

		try {
			let dir = PathUtils.join(Zotero.DataDirectory.dir, "LLMz", "scripts");
			await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
			for (let name of [this._imageListScriptName, this._renderScriptName, this._embedScriptName]) {
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

	// Same shape as document/tables.js's own _runNode -- reuses
	// LLMReferences's deployed sdt/ copy and node/pdfjs-setup infra rather
	// than duplicating it.
	async _runNode(scriptName, ...scriptArgs) {
		if (!LLMReferences._extensionRoot) {
			throw new Error("Extension root path unavailable; cannot run SDT-based extraction");
		}
		let nodePath = await LLMReferences._nodePath();
		let scriptPath = this._nodeScriptPath(scriptName);
		let setupPath = LLMReferences._pdfjsSetupPath();
		let stderrPath = scriptArgs[scriptArgs.length - 1] + ".err";
		let quotedArgs = scriptArgs.map(a => JSON.stringify(a)).join(" ");
		let cmd = `${JSON.stringify(nodePath)} --import ${JSON.stringify(setupPath)} ${JSON.stringify(scriptPath)} ${quotedArgs} 2>${JSON.stringify(stderrPath)}`;

		this.log(`_runNode: ${scriptName}`);
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
			for (let name of [this._imageListScriptName, this._renderScriptName, this._embedScriptName]) {
				let stat = await IOUtils.stat(this._scriptPath(name));
				parts.push(`${stat.size}:${stat.lastModified}`);
			}
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
			// selected AT THAT TIME (see llm-interfaces.js's getEmbedding) -- a
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
			await IOUtils.writeUTF8(path, JSON.stringify(index));
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
	// null (see _sdtScriptName's own comment) -- _renderImages below fills
	// it in right after this runs.
	async _extractRaw(item) {
		let pdfPath = item.getFilePath();
		if (!pdfPath) throw new Error("Item has no attached file path");
		let scriptsDir = PathUtils.join(Zotero.DataDirectory.dir, "LLMz", "scripts");
		let imagesPath = PathUtils.join(scriptsDir, `figure_images_${item.id}.json`);
		let outputPath = PathUtils.join(scriptsDir, `figures_${item.id}.json`);
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
		await this._runNode(this._sdtScriptName, pdfPath, outputPath, imagesArg);
		IOUtils.remove(imagesPath).catch(() => {});
		let figures = JSON.parse(await IOUtils.readUTF8(outputPath));
		IOUtils.remove(outputPath).catch(() => {});
		this.log(`_extractRaw: extracted ${figures.length} figures`);
		return figures;
	},

	// Renders image_data for every figure via scripts/render_crops.py,
	// against each figure's own cached `position` (the bounding box the SDT
	// detection already found, no re-detection needed) -- EAGER, unlike
	// document/tables.js's renderMissingImages, which only renders on
	// demand for whichever tables a caller actually asks for an image of
	// (see _renderScriptName's own comment for why figures can't defer this
	// the same way). Mutates the given figure objects in place (image_data
	// set directly on each) and also returns them, matching
	// renderMissingImages's own shape.
	async _renderImages(item, figures) {
		let targets = figures.filter(f => f.position?.rects?.[0]);
		if (!targets.length) return figures;

		let scriptsDir = PathUtils.join(Zotero.DataDirectory.dir, "LLMz", "scripts");
		let stamp = `${item.id}_${Date.now()}`;
		let regionsPath = PathUtils.join(scriptsDir, `render_in_${stamp}.json`);
		let outputPath = PathUtils.join(scriptsDir, `render_out_${stamp}.json`);
		let regions = targets.map((f, i) => ({
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
			targets[r.index].image_data = r.image_data;
		}
		this.log(`_renderImages: rendered ${rendered.length}/${targets.length} figure image(s)`);
		return figures;
	},

	// Embed figures using nomic-embed-vision-v1.5.
	// Returns entries with embedding vector, image_data kept (see
	// embed_figures.py's own docstring -- needed so a cached figure can
	// still be sent as image context to vision-capable models).
	async _embedRaw(item, figures) {
		let scriptsDir = PathUtils.join(Zotero.DataDirectory.dir, "LLMz", "scripts");
		let inputPath = PathUtils.join(scriptsDir, `embed_in_${item.id}.json`);
		let outputPath = PathUtils.join(scriptsDir, `embed_out_${item.id}.json`);
		await IOUtils.writeUTF8(inputPath, JSON.stringify(figures));
		try {
			await this._runPython(this._embedScriptName, inputPath, outputPath);
		}
		finally {
			IOUtils.remove(inputPath).catch(() => {});
		}
		let embedded = JSON.parse(await IOUtils.readUTF8(outputPath));
		IOUtils.remove(outputPath).catch(() => {});
		this.log(`_embedRaw: embedded ${embedded.length} figures`);
		return embedded;
	},

	// Returns the figure index for an item, using memory/disk cache where possible.
	// Index shape: { figures: [{ page_num, figure_num, figure_extra_num, figure_id, label, caption, embedding, captionEmbedding, image_data, position }] }
	// `onEmbeddingStart(provider, model)`, if given, is called ONLY when a
	// cache miss/staleness actually forces the caption embeddings to be
	// recomputed (see llm-citation.js's _getIndex, same pattern) -- its
	// return value (e.g. a Logs entry's content element) is updated in
	// place with a completion line once recomputation finishes, rather
	// than logging start/done as two separate messages.
	async getFigureIndex(item, onEmbeddingStart) {
		if (this._venvMissing) {
			throw new Error(
				"Python venv not found. Set it up with:\n"
				+ "  /opt/homebrew/bin/python3 -m venv ~/Zotero/LLMz/venv\n"
				+ "  ~/Zotero/LLMz/venv/bin/pip install pymupdf transformers torch Pillow einops"
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

		let figures = await this._extractRaw(item);
		if (figures.length) await this._renderImages(item, figures);
		let embedded = figures.length ? await this._embedRaw(item, figures) : [];
		let progress = embedded.length ? onEmbeddingStart?.(embeddingProvider, embeddingModel) : null;
		embedded = await this._addCaptionEmbeddings(embedded, embeddingModel, progress, embeddingProvider);
		if (progress) progress.textContent = `Recomputed ${embedded.length} figure caption embedding${embedded.length === 1 ? "" : "s"} using ${embeddingProvider} ${embeddingModel}.`;
		let index = { figures: embedded, scriptFingerprint: await this._scriptFingerprint(), embeddingProvider, embeddingModel };
		this._indexCache.set(item.id, index);
		await this._saveDiskCache(item, index);
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

	// Embeds each figure's "label: caption" as text (nomic-embed-text), so a
	// query can be matched against it via plain text-to-text similarity. Tested
	// empirically against the image embeddings (nomic-embed-vision, joint latent
	// space with nomic-embed-text): text-to-text scored far higher and more
	// discriminatively (0.5-0.87 vs. 0.04-0.08) and, unlike image similarity,
	// correctly handles explicit "figure N" references, since the caption text
	// itself starts with "Figure N:".
	// `progress`, if given, has its setProgress(current, total) called as
	// batches complete -- same in-place progress reporting llm-citation.js's
	// _getIndex does for its own embedding loop (see request.js's
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

	// Finds the figure whose caption embedding is most similar to the query text.
	async getBestMatchingFigure(figureIndex, query) {
		let figures = figureIndex?.figures;
		if (!figures?.length) return null;

		// Re-embed with the SAME provider/model this index's captionEmbeddings
		// were actually built with (stored on the index by getFigureIndex),
		// not necessarily the user's current Advanced-settings selection --
		// see _loadDiskCache's own comment.
		let queryEmbedding = await LLMCitation.getEmbedding(query, figureIndex.embeddingModel, figureIndex.embeddingProvider);

		let best = null;
		let bestScore = -Infinity;
		for (let fig of figures) {
			if (!fig.captionEmbedding) continue;
			let score = LLMCitation.cosineSimilarity(queryEmbedding, fig.captionEmbedding);
			if (score > bestScore) {
				bestScore = score;
				best = fig;
			}
		}
		if (best) this.log(`getBestMatchingFigure: ${best.label} (score=${bestScore.toFixed(3)})`);
		return best;
	},
};
