LLMTables = {
	// SDT-only detection (see scripts/extract_tables_sdt.js) -- replaced the
	// old caption-anchored PyMuPDF pipeline (extract_tables.py, since
	// removed), which structurally couldn't find tables with no caption at
	// all, or an appendix-lettered one like "Table D.1". Reuses
	// LLMReferences's deployed sdt/ copy and Node-running infra
	// (_extensionRoot/_nodePath/_pdfjsSetupPath), the same way LLMEquations
	// already does, rather than deploying a second copy of sdt/ itself --
	// see LLMReferences' _siblingScriptNames.
	_sdtScriptName: "extract_tables_sdt.js",
	// Renders a table's own cropped JPEG on demand (see renderMissingImages
	// below) -- split out of the old extract_tables.py, which used to
	// render every table's image unconditionally as part of detection
	// itself. Now that detection is SDT-only (image_data always starts
	// null, see _extractRaw), this is invoked lazily only when something
	// actually needs an image (currently: tools/table-export.js's
	// image-grounded CSV conversion), against the bounding box SDT already
	// found -- avoids paying rendering cost on every chat message for
	// tables that never end up needing a rendered image at all. Stays
	// PyMuPDF (via _runPython) rather than Zotero's own document-worker
	// pdf.js rendering pipeline -- that was prototyped too, but measured
	// ~2.5-3x slower even after matching render scale and JPEG output
	// (Node/ESM/canvas startup overhead, not encode work, so it doesn't
	// shrink with tuning), and this plugin already requires the Python venv
	// regardless for figure extraction (document/figures.js), so PyMuPDF
	// here isn't adding a new dependency either way.
	_renderScriptName: "render_crops.py",
	_cacheVersion: 3, // bump when the cached index schema changes (JS-side, not just Python scripts)
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

	async _loadDiskCache(item) {
		try {
			let path = PathUtils.join(await this._cacheDir(), `${item.id}.json`);
			if (!await IOUtils.exists(path)) return null;
			let index = JSON.parse(await IOUtils.readUTF8(path));
			if (index.scriptFingerprint !== await this._scriptFingerprint()) {
				this.log(`_loadDiskCache: stale (extract_tables_sdt.js changed) for item ${item.id}`);
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
	// each), and -- since `tables` are normally the SAME object references
	// getTableIndex's cache holds, not copies -- persists the newly-rendered
	// images back to the disk cache too, so a second export of the same
	// table(s) doesn't re-render. No-ops (no subprocess call at all) if
	// every table already has an image.
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

		let cached = this._indexCache.get(item.id);
		if (cached) await this._saveDiskCache(item, cached);

		return tables;
	},

	// Flattens extracted table rows into plain text for text-embedding, e.g.:
	// "Header A | Header B\nrow1a | row1b\nrow2a | row2b"
	_flattenTableData(data) {
		return (data || []).map(row => row.join(" | ")).join("\n");
	},

	// Embeds each table's "label: caption" and its flattened cell content as text
	// (nomic-embed-text), so a query can be matched against either via text-to-text
	// similarity.
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

	async getTableIndex(item, onMessage) {
		if (this._indexCache.has(item.id)) {
			this.log(`getTableIndex: memory cache hit for item ${item.id}`);
			return this._indexCache.get(item.id);
		}

		let cached = await this._loadDiskCache(item);
		if (cached) {
			this._indexCache.set(item.id, cached);
			return cached;
		}

		let tables = await this._extractRaw(item, onMessage);
		// _addTextEmbeddings is deliberately never called here -- neither it
		// nor the (since-removed) image-embedding step is on the live
		// selection path (selectTablesWithLLM doesn't use them -- see
		// llm/prompt.js; getBestMatchingTableByImage/ByTextMax, which do,
		// aren't called from llm/request.js). contentText itself, though, is
		// cheap (no network call, just a local join -- see
		// _flattenTableData) and is a real dependency of
		// tools/table-export.js's CSV-conversion prompt, so it's still
		// computed unconditionally here.
		for (let tab of tables) {
			tab.contentText = this._flattenTableData(tab.data);
		}
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

	// Cheap disk existence check (no content read) -- used by
	// ui/advanced.js's "Library index status" bar to tell a fully-indexed
	// paper (every extraction type cached) from a partially-indexed one
	// (see LLMCitation.hasCache's own comment for the fuller rationale,
	// same idea applied to this module's own cache file).
	async hasCache(item) {
		let dir = await this._cacheDir();
		return IOUtils.exists(PathUtils.join(dir, `${item.id}.json`));
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
