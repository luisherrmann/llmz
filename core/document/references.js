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
	// sdt/ copy (see _deployFromPackedXPI below) -- LLMEquations and (as of
	// the SDT-only table/figure detection) LLMTables/LLMFigures, all of
	// which reuse this module's _extensionRoot/_nodePath/_pdfjsSetupPath
	// rather than deploying a second copy of sdt/ themselves.
	// match_captions.js isn't itself run as a script (nothing calls
	// _runNode with it) but IS a relative `import`ed dependency of both
	// extract_tables_sdt.js and extract_figures_sdt.js, so it still has to
	// be deployed alongside them -- see _deployFromPackedXPI below.
	_siblingScriptNames: ["extract_equations.js", "extract_tables_sdt.js", "extract_figures_sdt.js", "match_captions.js", "compute_document_structure.js", "structure_sdt.js"],
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

		let destDir = PathUtils.join(Zotero.DataDirectory.dir, "LLMz", "scripts", "sdt-deployed");
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

	// Resolved via Subprocess.pathSearch (the same mechanism Zotero's own
	// Zotero.Utilities.Internal.subprocess uses, see utilities_internal.js)
	// -- cross-platform (honors PATHEXT on Windows, PATH on Unix) instead of
	// a hand-maintained list of platform-specific install locations. Falls
	// back to a short list of common install locations that a GUI app
	// launched outside a login shell (Zotero.app from Finder/Dock, a
	// Windows shortcut) sometimes doesn't inherit PATH for, and finally to
	// a bare "node" so Subprocess.call's own error is at least what
	// surfaces, rather than this function itself throwing something less
	// diagnostic.
	async _nodePath() {
		let { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
		try {
			let found = await Subprocess.pathSearch("node");
			if (found) return found;
		}
		catch (e) {
			// Not on PATH -- fall through to the candidate list below.
		}
		let candidates = [
			"/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node",
			"C:\\Program Files\\nodejs\\node.exe", "C:\\Program Files (x86)\\nodejs\\node.exe",
		];
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

	// Shared by every SDT-based extraction module (LLMEquations, LLMTables,
	// LLMFigures, LLMStructureSDT, LLMCitationPosition, and this module
	// itself) rather than each keeping its own copy -- they used to, and
	// all six copies needed the same cross-platform fix at once. `scriptPath`
	// and `logLabel` are passed in explicitly (rather than this function
	// assuming `this._scriptPath()`/`this._scriptName` mean the right thing)
	// since callers resolve their own script path differently -- some have
	// one fixed script (`_scriptPath()`), others (LLMTables/LLMFigures)
	// support more than one named script per module (`_nodeScriptPath(name)`).
	//
	// Runs `node` directly (no shell) -- Subprocess.call itself handles
	// cross-platform process spawning; the previous `/bin/sh -c` wrapper
	// existed only to get `2>stderrPath` shell redirection, which is also
	// why this used to be Unix-only. stdout/stderr are read directly off
	// the process's own streams instead (mirrors Zotero's own
	// Zotero.Utilities.Internal.subprocess), read concurrently via
	// Promise.all rather than one after another, so a script that writes
	// enough to one stream to fill its OS pipe buffer while this is still
	// blocked reading the other can't deadlock the two of them against
	// each other.
	async _runNode(scriptPath, logLabel, ...scriptArgs) {
		if (!this._extensionRoot) {
			throw new Error("Extension root path unavailable; cannot run SDT-based extraction");
		}
		let nodePath = await this._nodePath();
		let setupPath = this._pdfjsSetupPath();

		this.log(`_runNode: ${logLabel}`);
		let { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
		// stderr: "stdout" merges stderr into the same pipe as stdout --
		// proc.stderr isn't a readable stream on its own by default (unlike
		// what Mozilla's own docs for this module might suggest; confirmed
		// the hard way -- neither of the two real call sites for this module
		// anywhere in Zotero's own source, Zotero.Utilities.Internal.
		// subprocess and Scaffold's ESLint runner, ever read proc.stderr,
		// only proc.stdout). These scripts don't write anything meaningful
		// to stdout anyway (their real output goes to a file via
		// fs.writeFileSync -- see each script's own main()), so merging
		// loses nothing; it's always either empty or exactly the
		// diagnostic/error text we want.
		let proc = await Subprocess.call({
			command: nodePath,
			arguments: ["--import", setupPath, scriptPath, ...scriptArgs],
			stderr: "stdout",
		});

		let output = "";
		let chunk;
		while ((chunk = await proc.stdout.readString())) output += chunk;
		output = output.trim();
		let { exitCode } = await proc.wait();

		if (output) this.log(`${logLabel} output: ${output}`);
		if (exitCode !== 0) {
			throw new Error(`${logLabel} failed (exit ${exitCode}): ${output || "(no output)"}`);
		}
	},

	async _extractRaw(item, onMessage) {
		let pdfPath = item.getFilePath();
		if (!pdfPath) throw new Error("Item has no attached file path");
		let outputPath = PathUtils.join(Zotero.DataDirectory.dir, "LLMz", "scripts", `references_${item.id}.json`);
		await IOUtils.makeDirectory(PathUtils.join(Zotero.DataDirectory.dir, "LLMz", "scripts"), { ignoreExisting: true, createAncestors: true });
		let structureCachePath = await LLMStructureSDT.ensureStructureCache(item, onMessage);
		await this._runNode(this._scriptPath(), this._scriptName, pdfPath, outputPath, structureCachePath);
		let references = JSON.parse(await IOUtils.readUTF8(outputPath));
		IOUtils.remove(outputPath).catch(() => {});
		this.log(`_extractRaw: extracted ${references.length} references`);
		return references;
	},

	async _cacheDir() {
		let dir = PathUtils.join(Zotero.DataDirectory.dir, "LLMz", "cache", "reference");
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

	// The number to show/match a reference by, wherever one is needed
	// (download/link tool resolution, <REFERENCE_CONTEXT>/ref:reference:N
	// citation links) -- `index` (the paper's own PRINTED bibliography
	// number, e.g. "[17]") when the paper actually has one, but that's null
	// for a paper whose bibliography is author-year/alphabetical with no
	// printed numbers at all (common e.g. in ML papers using natbib-style
	// citations -- confirmed concretely, not a hypothetical: a real paper's
	// extraction came back with EVERY entry's `index` null). `reference_id`
	// (this module's own 1..N extraction-order position, always present) is
	// the only stand-in a user could mean by "reference 17" for that paper
	// -- the same number they'd get counting down the PDF's own list by eye,
	// since there's no printed number to read off instead. For an actually-
	// numbered paper this always resolves to the real printed number
	// (`index` is non-null), so this is a strict superset of the old
	// `r.index`-only behavior, not a behavior change for that case.
	displayNumber(ref) {
		return ref.index ?? ref.reference_id;
	},

	// Returns { references: [{ index, reference_id, text, position }] },
	// index = the paper's own printed reference-list number (null if the
	// bibliography has none -- see displayNumber above for what to use
	// instead in that case), reference_id = this extraction's own 1..N
	// document-order position (always present), position = { pageIndex,
	// rects } for navigateToPosition (see core/citation.js), null if the
	// entry had no anchor at all -- see extract_references.js's own
	// buildPosition for where this comes from.
	async getReferenceIndex(item, onMessage) {
		if (this._indexCache.has(item.id)) {
			this.log(`getReferenceIndex: memory cache hit for item ${item.id}`);
			return this._indexCache.get(item.id);
		}

		let cached = await this._loadDiskCache(item);
		if (cached) {
			this._indexCache.set(item.id, cached);
			return cached;
		}

		let references = await this._extractRaw(item, onMessage);
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
