LLMTables = {
	_scriptName: "extract_tables.py",
	_indexCache: new Map(),

	log(msg) {
		Zotero.debug("LLM Chat Pane [Tables]: " + msg);
	},

	_pythonPath() {
		return PathUtils.join(Zotero.DataDirectory.dir, "llm-venv", "bin", "python3");
	},

	_scriptPath(name) {
		return PathUtils.join(Zotero.DataDirectory.dir, "llm-scripts", name);
	},

	async init(rootURI) {
		try {
			let dir = PathUtils.join(Zotero.DataDirectory.dir, "llm-scripts");
			await IOUtils.makeDirectory(dir, { ignoreExisting: true });
			let src = await Zotero.File.getContentsFromURL(rootURI + "scripts/" + this._scriptName);
			await IOUtils.writeUTF8(this._scriptPath(this._scriptName), src);
			this.log(`init: deployed ${this._scriptName}`);
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

	async _cacheDir() {
		let dir = PathUtils.join(Zotero.DataDirectory.dir, "llm-table-cache");
		await IOUtils.makeDirectory(dir, { ignoreExisting: true });
		return dir;
	},

	async _loadDiskCache(item) {
		try {
			let path = PathUtils.join(await this._cacheDir(), `${item.id}.json`);
			if (!await IOUtils.exists(path)) return null;
			let index = JSON.parse(await IOUtils.readUTF8(path));
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
		let outputPath = PathUtils.join(Zotero.DataDirectory.dir, "llm-scripts", `tables_${item.id}.json`);
		await this._runPython(this._scriptName, pdfPath, outputPath);
		let tables = JSON.parse(await IOUtils.readUTF8(outputPath));
		IOUtils.remove(outputPath).catch(() => {});
		this.log(`_extractRaw: extracted ${tables.length} tables`);
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
		let index = { tables };
		this._indexCache.set(item.id, index);
		await this._saveDiskCache(item, index);
		return index;
	},
};
