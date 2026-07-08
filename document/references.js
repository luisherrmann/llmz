// Retrieves the paper's own References/Bibliography list.
//
// Uses Zotero's own document-worker structure pipeline (ML-based PDF layout
// classification, vendored under sdt/document-worker/) rather than
// regex/line-based text parsing: the classifier tags each bibliography
// entry directly (a list item gets `reference: true`), which reliably
// handles cases that broke a hand-rolled parser -- lowercase-starting
// surnames, page-footer watermark noise on preprint PDFs, and false-positive
// "References" headings from table columns -- with no special-casing needed.
// Runs as a Node subprocess (see scripts/extract_references.js); Zotero
// itself only ships this pipeline as a compiled worker bundle, not something
// callable directly from plugin code, so we vendor+run the source ourselves.
LLMReferences = {
	_scriptName: "extract_references.js",
	// Other node/document-worker-based scripts that share this same deployed
	// sdt/ copy (see _deployFromPackedXPI below) -- currently just
	// LLMEquations, which reuses this module's _extensionRoot/_nodePath/
	// _pdfjsSetupPath rather than deploying a second copy of sdt/ itself.
	_siblingScriptNames: ["extract_equations.js"],
	_cacheVersion: 1, // bump when the cached index schema changes (JS-side, not just the script/model)
	_indexCache: new Map(),
	_extensionRoot: null,

	log(msg) {
		Zotero.debug("LLM Chat Pane [References]: " + msg);
	},

	// `node` needs real files on disk to run as a subprocess. rootURI (the
	// same string as addon.getResourceURI().spec, per Zotero.Plugins) is a
	// plain file:// URI for an unpacked install -- but Zotero addons are
	// commonly installed as a packed .xpi, in which case rootURI is a
	// jar:file:///.../llm-chat-pane.xpi!/ URI. Reading individual files via
	// Zotero.File.getContentsFromURL works fine either way, but there's no
	// such thing as a real filesystem path *inside* a jar -- so for a packed
	// install, extract sdt/ and scripts/extract_references.js out to a
	// writable directory once (same nsIZipReader pattern Zotero's own
	// schema.js/dictionaries.js use to unpack bundled styles/dictionaries),
	// skipping re-extraction on later runs unless the xpi itself changed.
	async init(rootURI) {
		try {
			let uri = Services.io.newURI(rootURI);
			if (uri instanceof Ci.nsIFileURL) {
				this._extensionRoot = uri.file.path;
				this.log(`init: unpacked install, using ${this._extensionRoot}`);
				return;
			}
			await this._deployFromPackedXPI(uri);
		}
		catch (e) {
			this.log(`init: failed to resolve extension root: ${e.message}`);
		}
	},

	async _deployFromPackedXPI(uri) {
		let jarURI = uri.QueryInterface(Ci.nsIJARURI);
		let xpiFile = jarURI.JARFile.QueryInterface(Ci.nsIFileURL).file;

		let destDir = PathUtils.join(Zotero.DataDirectory.dir, "llm-scripts", "sdt-deployed");
		let markerPath = PathUtils.join(destDir, ".deployed-from");
		let xpiStat = await IOUtils.stat(xpiFile.path);
		let marker = `${xpiStat.size}:${xpiStat.lastModified}`;

		if (await IOUtils.exists(markerPath) && (await IOUtils.readUTF8(markerPath)).trim() === marker) {
			this._extensionRoot = destDir;
			this.log(`init: packed install, already deployed at ${destDir}`);
			return;
		}

		this.log(`init: packed install, extracting sdt/ subpackage to ${destDir}...`);
		let zipReader = Cc["@mozilla.org/libjar/zip-reader;1"].createInstance(Ci.nsIZipReader);
		zipReader.open(xpiFile);
		try {
			await IOUtils.remove(destDir, { recursive: true, ignoreAbsent: true });

			let dirs = zipReader.findEntries("sdt/*/");
			while (dirs.hasMore()) {
				let entry = dirs.getNext();
				await IOUtils.makeDirectory(PathUtils.join(destDir, ...entry.split("/")), { ignoreExisting: true, createAncestors: true });
			}
			await IOUtils.makeDirectory(PathUtils.join(destDir, "scripts"), { ignoreExisting: true, createAncestors: true });

			let files = zipReader.findEntries("sdt/*");
			while (files.hasMore()) {
				let entry = files.getNext();
				if (entry.endsWith("/")) continue;
				zipReader.extract(entry, Zotero.File.pathToFile(PathUtils.join(destDir, ...entry.split("/"))));
			}
			for (let name of [this._scriptName, ...this._siblingScriptNames]) {
				zipReader.extract(
					"scripts/" + name,
					Zotero.File.pathToFile(PathUtils.join(destDir, "scripts", name))
				);
			}

			await IOUtils.writeUTF8(markerPath, marker);
		}
		finally {
			zipReader.close();
		}

		this._extensionRoot = destDir;
		this.log("init: extraction complete");
	},

	// Common Homebrew/system locations, checked in order; falls back to a
	// bare "node" resolved via PATH (may not be inherited by a GUI app).
	async _nodePath() {
		let candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"];
		for (let path of candidates) {
			if (await IOUtils.exists(path)) return path;
		}
		return "node";
	},

	_scriptPath() {
		return PathUtils.join(this._extensionRoot, "scripts", this._scriptName);
	},

	_pdfjsSetupPath() {
		return PathUtils.join(this._extensionRoot, "sdt", "document-worker", "scripts", "pdfjs-setup.js");
	},

	async _runNode(...scriptArgs) {
		if (!this._extensionRoot) {
			throw new Error("Extension root path unavailable; cannot run SDT-based extraction");
		}
		let nodePath = await this._nodePath();
		let scriptPath = this._scriptPath();
		let setupPath = this._pdfjsSetupPath();
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
		let outputPath = PathUtils.join(Zotero.DataDirectory.dir, "llm-scripts", `references_${item.id}.json`);
		await IOUtils.makeDirectory(PathUtils.join(Zotero.DataDirectory.dir, "llm-scripts"), { ignoreExisting: true });
		await this._runNode(pdfPath, outputPath);
		let references = JSON.parse(await IOUtils.readUTF8(outputPath));
		IOUtils.remove(outputPath).catch(() => {});
		this.log(`_extractRaw: extracted ${references.length} references`);
		return references;
	},

	async _cacheDir() {
		let dir = PathUtils.join(Zotero.DataDirectory.dir, "llm-reference-cache");
		await IOUtils.makeDirectory(dir, { ignoreExisting: true });
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
				this.log(`_loadDiskCache: stale (extract_references.js changed) for item ${item.id}`);
				return null;
			}
			this.log(`_loadDiskCache: loaded ${index.references.length} references for item ${item.id}`);
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
			this.log(`_saveDiskCache: saved ${index.references.length} references for item ${item.id}`);
		}
		catch (e) {
			this.log(`_saveDiskCache: failed: ${e.message}`);
		}
	},

	// Returns { references: [{ index, text }] }, index = the paper's own
	// reference-list number (or null if unparseable).
	async getReferenceIndex(item) {
		if (this._indexCache.has(item.id)) {
			this.log(`getReferenceIndex: memory cache hit for item ${item.id}`);
			return this._indexCache.get(item.id);
		}

		let cached = await this._loadDiskCache(item);
		if (cached) {
			this._indexCache.set(item.id, cached);
			return cached;
		}

		let references = await this._extractRaw(item);
		let index = { references, scriptFingerprint: await this._scriptFingerprint() };
		this._indexCache.set(item.id, index);
		await this._saveDiskCache(item, index);
		return index;
	},

	// Debug affordance ("Clear Cache" button) -- drops both the memory and
	// disk cache for this item, so the next getReferenceIndex() call re-runs
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
