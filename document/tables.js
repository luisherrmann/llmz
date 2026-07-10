LLMTables = {
	_scriptName: "extract_tables.py",
	_embedScriptName: "embed_tables.py",
	// Experimental SDT-only detection (see scripts/extract_tables_sdt.js) --
	// bypasses extract_tables.py/embed_tables.py entirely for now, to check
	// how well SDT alone handles tables the caption-anchored PyMuPDF
	// pipeline structurally can't find (no caption at all, or an
	// appendix-lettered one like "Table D.1"). Reuses LLMReferences's
	// deployed sdt/ copy and Node-running infra (_extensionRoot/_nodePath/
	// _pdfjsSetupPath), the same way LLMEquations already does, rather than
	// deploying a second copy of sdt/ itself -- see LLMReferences'
	// _siblingScriptNames.
	_sdtScriptName: "extract_tables_sdt.js",
	_cacheVersion: 3, // bump when the cached index schema changes (JS-side, not just Python scripts)
	_indexCache: new Map(),

	log(msg) {
		Zotero.debug("LLM Chat Pane [Tables]: " + msg);
	},

	_pythonPath() {
		return PathUtils.join(Zotero.DataDirectory.dir, "LLMz", "venv", "bin", "python3");
	},

	_scriptPath(name) {
		return PathUtils.join(Zotero.DataDirectory.dir, "LLMz", "scripts", name);
	},

	async init(rootURI) {
		try {
			let dir = PathUtils.join(Zotero.DataDirectory.dir, "LLMz", "scripts");
			await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
			for (let name of [this._scriptName, this._embedScriptName]) {
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

	_sdtScriptPath() {
		return PathUtils.join(LLMReferences._extensionRoot, "scripts", this._sdtScriptName);
	},

	// Same shape as LLMEquations._runNode -- reuses LLMReferences's deployed
	// sdt/ copy and node/pdfjs-setup infra rather than duplicating it.
	async _runNode(...scriptArgs) {
		if (!LLMReferences._extensionRoot) {
			throw new Error("Extension root path unavailable; cannot run SDT-based extraction");
		}
		let nodePath = await LLMReferences._nodePath();
		let scriptPath = this._sdtScriptPath();
		let setupPath = LLMReferences._pdfjsSetupPath();
		let stderrPath = scriptArgs[scriptArgs.length - 1] + ".err";
		let quotedArgs = scriptArgs.map(a => JSON.stringify(a)).join(" ");
		let cmd = `${JSON.stringify(nodePath)} --import ${JSON.stringify(setupPath)} ${JSON.stringify(scriptPath)} ${quotedArgs} 2>${JSON.stringify(stderrPath)}`;

		this.log(`_runNode: ${this._sdtScriptName}`);
		let { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
		let proc = await Subprocess.call({ command: "/bin/sh", arguments: ["-c", cmd] });
		let { exitCode } = await proc.wait();

		let stderr = "";
		try { stderr = (await IOUtils.readUTF8(stderrPath)).trim(); } catch (e) {}
		IOUtils.remove(stderrPath).catch(() => {});
		if (stderr) this.log(`${this._sdtScriptName} stderr: ${stderr}`);

		if (exitCode !== 0) {
			throw new Error(`${this._sdtScriptName} failed (exit ${exitCode}): ${stderr || "(no stderr)"}`);
		}
	},

	async _cacheDir() {
		let dir = PathUtils.join(Zotero.DataDirectory.dir, "LLMz", "cache", "table");
		await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
		return dir;
	},

	async _scriptFingerprint() {
		try {
			// Only the SDT script matters while the Python path is bypassed
			// (see _extractRaw/getTableIndex) -- extract_tables.py/
			// embed_tables.py aren't invoked right now, so their own
			// mtimes shouldn't affect cache validity.
			let stat = await IOUtils.stat(this._sdtScriptPath());
			return `v${this._cacheVersion}|${stat.size}:${stat.lastModified}`;
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
				this.log(`_loadDiskCache: stale (extract_tables.py changed) for item ${item.id}`);
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
			await IOUtils.writeUTF8(path, JSON.stringify(index));
			this.log(`_saveDiskCache: saved ${index.tables.length} tables for item ${item.id}`);
		}
		catch (e) {
			this.log(`_saveDiskCache: failed: ${e.message}`);
		}
	},

	async _extractRaw(item) {
		let pdfPath = item.getFilePath();
		if (!pdfPath) throw new Error("Item has no attached file path");
		let outputPath = PathUtils.join(Zotero.DataDirectory.dir, "LLMz", "scripts", `tables_${item.id}.json`);
		// Bypasses extract_tables.py (see _sdtScriptName's own comment) --
		// SDT-only detection via _runNode, not _runPython.
		await this._runNode(pdfPath, outputPath);
		let tables = JSON.parse(await IOUtils.readUTF8(outputPath));
		IOUtils.remove(outputPath).catch(() => {});
		this.log(`_extractRaw: extracted ${tables.length} tables`);
		return tables;
	},

	// Embeds each table's cropped image using nomic-embed-vision (image embedding).
	async _embedRaw(item, tables) {
		let scriptsDir = PathUtils.join(Zotero.DataDirectory.dir, "LLMz", "scripts");
		let inputPath = PathUtils.join(scriptsDir, `embed_in_${item.id}.json`);
		let outputPath = PathUtils.join(scriptsDir, `embed_out_${item.id}.json`);
		await IOUtils.writeUTF8(inputPath, JSON.stringify(tables));
		try {
			await this._runPython(this._embedScriptName, inputPath, outputPath);
		}
		finally {
			IOUtils.remove(inputPath).catch(() => {});
		}
		let embedded = JSON.parse(await IOUtils.readUTF8(outputPath));
		IOUtils.remove(outputPath).catch(() => {});
		this.log(`_embedRaw: embedded ${embedded.length} tables`);
		return embedded;
	},

	// Flattens extracted table rows into plain text for text-embedding, e.g.:
	// "Header A | Header B\nrow1a | row1b\nrow2a | row2b"
	_flattenTableData(data) {
		return (data || []).map(row => row.join(" | ")).join("\n");
	},

	// Embeds each table's "label: caption" and its flattened cell content as text
	// (nomic-embed-text), so a query can be matched against either via text-to-text
	// similarity, alongside the image embedding from _embedRaw.
	async _addTextEmbeddings(tables) {
		if (!tables.length) return tables;
		let textModel = await LLMCitation.getEmbeddingModel();
		for (let tab of tables) {
			try {
				tab.captionEmbedding = await LLMCitation.getEmbedding(`${tab.label}: ${tab.caption}`, textModel);
				tab.contentText = this._flattenTableData(tab.data);
				tab.contentEmbedding = await LLMCitation.getEmbedding(tab.contentText, textModel);
			}
			catch (e) {
				this.log(`_addTextEmbeddings: failed for ${tab.label}: ${e.message}`);
			}
		}
		return tables;
	},

	async getTableIndex(item) {
		if (this._indexCache.has(item.id)) {
			this.log(`getTableIndex: memory cache hit for item ${item.id}`);
			return this._indexCache.get(item.id);
		}

		let cached = await this._loadDiskCache(item);
		if (cached) {
			this._indexCache.set(item.id, cached);
			return cached;
		}

		let tables = await this._extractRaw(item);
		// _embedRaw/_addTextEmbeddings skipped while the Python path is
		// bypassed (see _sdtScriptName's own comment) -- image_data is
		// always null from the SDT-only script (no PyMuPDF rendering), so
		// _embedRaw would have nothing real to embed, and neither embedding
		// is on the live selection path anyway (selectTablesWithLLM doesn't
		// use them -- see llm-prompt.js; getBestMatchingTableByImage/
		// ByTextMax, which do, aren't called from request.js).
		let index = { tables, scriptFingerprint: await this._scriptFingerprint() };
		this._indexCache.set(item.id, index);
		await this._saveDiskCache(item, index);
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

	// --- Retrieval strategies (image embedding, text-embedding max, LLM selection
	// lives in LLMChatPane since it needs to call the active model) ---

	async getBestMatchingTableByImage(tableIndex, query) {
		let tables = tableIndex?.tables;
		if (!tables?.length) return null;
		let embedModel = await LLMCitation.getEmbeddingModel();
		let queryEmbedding = await LLMCitation.getEmbedding(query, embedModel);
		let best = null;
		let bestScore = -Infinity;
		for (let tab of tables) {
			if (!tab.embedding) continue;
			let score = LLMCitation.cosineSimilarity(queryEmbedding, tab.embedding);
			if (score > bestScore) {
				bestScore = score;
				best = tab;
			}
		}
		if (best) this.log(`getBestMatchingTableByImage: ${best.label} (score=${bestScore.toFixed(4)})`);
		return best;
	},

	async getBestMatchingTableByTextMax(tableIndex, query) {
		let tables = tableIndex?.tables;
		if (!tables?.length) return null;
		let embedModel = await LLMCitation.getEmbeddingModel();
		let queryEmbedding = await LLMCitation.getEmbedding(query, embedModel);
		let best = null;
		let bestScore = -Infinity;
		for (let tab of tables) {
			if (!tab.captionEmbedding || !tab.contentEmbedding) continue;
			let capScore = LLMCitation.cosineSimilarity(queryEmbedding, tab.captionEmbedding);
			let contentScore = LLMCitation.cosineSimilarity(queryEmbedding, tab.contentEmbedding);
			let score = Math.max(capScore, contentScore);
			if (score > bestScore) {
				bestScore = score;
				best = tab;
			}
		}
		if (best) this.log(`getBestMatchingTableByTextMax: ${best.label} (score=${bestScore.toFixed(4)})`);
		return best;
	},
};
