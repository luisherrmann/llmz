LLMFigures = {
	_scriptName: "extract_figures.py",
	_embedScriptName: "embed_figures.py",
	_cacheVersion: 3, // bump when the cached index schema changes (JS-side, not just Python scripts)
	_venvMissing: false,
	_indexCache: new Map(),

	log(msg) {
		Zotero.debug("LLM Chat Pane [Figures]: " + msg);
	},

	_pythonPath() {
		return PathUtils.join(Zotero.DataDirectory.dir, "llm-venv", "bin", "python3");
	},

	_scriptPath(name) {
		return PathUtils.join(Zotero.DataDirectory.dir, "llm-scripts", name);
	},

	async init(rootURI) {
		let pythonPath = this._pythonPath();
		if (!await IOUtils.exists(pythonPath)) {
			this._venvMissing = true;
			this.log(`init: venv not found at ${pythonPath}`);
			this.log("init: set it up with:");
			this.log("  /opt/homebrew/bin/python3 -m venv ~/Zotero/llm-venv");
			this.log("  ~/Zotero/llm-venv/bin/pip install pymupdf transformers torch Pillow einops");
		}
		else {
			this._venvMissing = false;
			this.log(`init: venv found at ${pythonPath}`);
		}

		try {
			let dir = PathUtils.join(Zotero.DataDirectory.dir, "llm-scripts");
			await IOUtils.makeDirectory(dir, { ignoreExisting: true });
			for (let name of [this._scriptName, this._embedScriptName]) {
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

	// Run a bundled Python script. scriptArgs are passed after the script path;
	// the last arg is assumed to be the output path and is used as the stderr file base.
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

	async _cacheDir() {
		let dir = PathUtils.join(Zotero.DataDirectory.dir, "llm-figure-cache");
		await IOUtils.makeDirectory(dir, { ignoreExisting: true });
		return dir;
	},

	async _scriptFingerprint() {
		try {
			let parts = [`v${this._cacheVersion}`];
			for (let name of [this._scriptName, this._embedScriptName]) {
				let stat = await IOUtils.stat(this._scriptPath(name));
				parts.push(`${stat.size}:${stat.lastModified}`);
			}
			return parts.join("|");
		}
		catch (e) {
			return null;
		}
	},

	async _loadDiskCache(item) {
		try {
			let path = PathUtils.join(await this._cacheDir(), `${item.id}.json`);
			if (!await IOUtils.exists(path)) return null;
			let index = JSON.parse(await IOUtils.readUTF8(path));
			if (index.scriptFingerprint !== await this._scriptFingerprint()) {
				this.log(`_loadDiskCache: stale (extraction/embed scripts changed) for item ${item.id}`);
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

	// Extract figures from PDF, returning raw entries with image_data.
	async _extractRaw(item) {
		let pdfPath = item.getFilePath();
		if (!pdfPath) throw new Error("Item has no attached file path");
		let outputPath = PathUtils.join(Zotero.DataDirectory.dir, "llm-scripts", `figures_${item.id}.json`);
		await this._runPython(this._scriptName, pdfPath, outputPath);
		let figures = JSON.parse(await IOUtils.readUTF8(outputPath));
		IOUtils.remove(outputPath).catch(() => {});
		this.log(`_extractRaw: extracted ${figures.length} figures`);
		return figures;
	},

	// Embed figures using nomic-embed-vision-v1.5.
	// Returns entries with embedding vector, image_data stripped.
	async _embedRaw(item, figures) {
		let scriptsDir = PathUtils.join(Zotero.DataDirectory.dir, "llm-scripts");
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
	// Index shape: { figures: [{ page_num, figure_num, label, caption, embedding }] }
	async getFigureIndex(item) {
		if (this._venvMissing) {
			throw new Error(
				"Python venv not found. Set it up with:\n"
				+ "  /opt/homebrew/bin/python3 -m venv ~/Zotero/llm-venv\n"
				+ "  ~/Zotero/llm-venv/bin/pip install pymupdf transformers torch Pillow einops"
			);
		}

		if (this._indexCache.has(item.id)) {
			this.log(`getFigureIndex: memory cache hit for item ${item.id}`);
			return this._indexCache.get(item.id);
		}

		let cached = await this._loadDiskCache(item);
		if (cached) {
			this._indexCache.set(item.id, cached);
			return cached;
		}

		let figures = await this._extractRaw(item);
		let embedded = figures.length ? await this._embedRaw(item, figures) : [];
		embedded = await this._addCaptionEmbeddings(embedded);
		let index = { figures: embedded, scriptFingerprint: await this._scriptFingerprint() };
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
	async _addCaptionEmbeddings(figures) {
		if (!figures.length) return figures;
		let textModel = await LLMCitation.getEmbeddingModel();
		for (let fig of figures) {
			try {
				fig.captionEmbedding = await LLMCitation.getEmbedding(`${fig.label}: ${fig.caption}`, textModel);
			}
			catch (e) {
				this.log(`_addCaptionEmbeddings: failed for ${fig.label}: ${e.message}`);
			}
		}
		return figures;
	},

	// Finds the figure whose caption embedding is most similar to the query text.
	async getBestMatchingFigure(figureIndex, query) {
		let figures = figureIndex?.figures;
		if (!figures?.length) return null;

		let embedModel = await LLMCitation.getEmbeddingModel();
		let queryEmbedding = await LLMCitation.getEmbedding(query, embedModel);

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
