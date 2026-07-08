// Retrieves the paper's own equations and formulas, the same way
// LLMReferences retrieves its bibliography -- via Zotero's document-worker
// structure pipeline (ML-based PDF layout classification, vendored under
// sdt/document-worker/). The classifier tags each equation block directly
// (`type: 'equation'`); a trailing right-aligned "(N)" label identifies which
// ones the paper itself numbers and cross-references in its own prose (e.g.
// "as given by (3)") -- those get equation_num N. Blocks without one are
// still extracted, as a separately-numbered "Formula N" series (formula_num)
// -- see scripts/extract_equations.js for the exact extraction logic.
//
// Deployment (unpacking sdt/ for a packed .xpi install) is owned entirely by
// LLMReferences -- both modules run scripts against the exact same
// document-worker/pdf.js copy, so this reuses LLMReferences._extensionRoot/
// _nodePath()/_pdfjsSetupPath() rather than deploying (and keeping in sync) a
// second copy of a multi-file, non-trivial-sized submodule.
LLMEquations = {
	_scriptName: "extract_equations.js",
	_cacheVersion: 3, // bump when the cached index schema changes (JS-side, not just the script/model)
	_indexCache: new Map(),

	log(msg) {
		Zotero.debug("LLM Chat Pane [Equations]: " + msg);
	},

	_scriptPath() {
		return PathUtils.join(LLMReferences._extensionRoot, "scripts", this._scriptName);
	},

	async _runNode(...scriptArgs) {
		if (!LLMReferences._extensionRoot) {
			throw new Error("Extension root path unavailable; cannot run SDT-based extraction");
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

	async _extractRaw(item) {
		let pdfPath = item.getFilePath();
		if (!pdfPath) throw new Error("Item has no attached file path");
		let outputPath = PathUtils.join(Zotero.DataDirectory.dir, "zllm", "scripts", `equations_${item.id}.json`);
		await IOUtils.makeDirectory(PathUtils.join(Zotero.DataDirectory.dir, "zllm", "scripts"), { ignoreExisting: true, createAncestors: true });
		await this._runNode(pdfPath, outputPath);
		let equations = JSON.parse(await IOUtils.readUTF8(outputPath));
		IOUtils.remove(outputPath).catch(() => {});
		this.log(`_extractRaw: extracted ${equations.length} equations`);
		return equations;
	},

	async _cacheDir() {
		let dir = PathUtils.join(Zotero.DataDirectory.dir, "zllm", "cache", "equation");
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

	async _loadDiskCache(item) {
		try {
			let path = PathUtils.join(await this._cacheDir(), `${item.id}.json`);
			if (!await IOUtils.exists(path)) return null;
			let index = JSON.parse(await IOUtils.readUTF8(path));
			if (index.scriptFingerprint !== await this._scriptFingerprint()) {
				this.log(`_loadDiskCache: stale (extract_equations.js changed) for item ${item.id}`);
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
			await IOUtils.writeUTF8(path, JSON.stringify(index));
			this.log(`_saveDiskCache: saved ${index.equations.length} equations for item ${item.id}`);
		}
		catch (e) {
			this.log(`_saveDiskCache: failed: ${e.message}`);
		}
	},

	// Returns { equations: [{ equation_num, label, text, position }] }.
	async getEquationIndex(item) {
		if (this._indexCache.has(item.id)) {
			this.log(`getEquationIndex: memory cache hit for item ${item.id}`);
			return this._indexCache.get(item.id);
		}

		let cached = await this._loadDiskCache(item);
		if (cached) {
			this._indexCache.set(item.id, cached);
			return cached;
		}

		let equations = await this._extractRaw(item);
		let index = { equations, scriptFingerprint: await this._scriptFingerprint() };
		this._indexCache.set(item.id, index);
		await this._saveDiskCache(item, index);
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
};
