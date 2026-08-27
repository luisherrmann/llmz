// Creates the Python virtual environment document/tables.js/document/figures.js
// need (table/figure image rendering via render_crops.py, figure ground-truth
// image listing via list_page_images.py) and installs its dependencies from
// requirements.txt. Currently invoked manually, matching the README's own
// setup instructions -- will be wired to a "Set Up Python Environment"
// button in a future first-time-setup pane; `setup()`'s own `dir` parameter
// already accepts an override for that pane's eventual directory picker, so
// wiring it up later shouldn't need this module's own shape to change.
LLMPythonSetup = {
	_rootURI: null,

	log(msg) {
		Zotero.debug("LLM Chat Pane [PythonSetup]: " + msg);
	},

	init(rootURI) {
		this._rootURI = rootURI;
	},

	// Some Python builds compile their sqlite3 module without loadable-
	// extension support at all -- notably pyenv-built interpreters compiled
	// against a SQLite lacking that API, and macOS's /usr/bin/python3. A
	// venv built from one of those can never load sqlite-vec (see db.py's
	// own _connect check, which fails loudly for anyone who ends up with
	// such a venv already). Screening candidates here means we just skip
	// to the next candidate instead of ever building a broken venv.
	async _supportsLoadExtension(pythonPath) {
		try {
			let { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
			let proc = await Subprocess.call({
				command: pythonPath,
				arguments: ["-c", "import sqlite3; c = sqlite3.connect(':memory:'); assert hasattr(c, 'enable_load_extension') and hasattr(c, 'load_extension')"],
				stderr: "stdout",
			});
			let { exitCode } = await proc.wait();
			return exitCode === 0;
		}
		catch (e) {
			return false;
		}
	},

	// Mirrors LLMReferences._nodePath's own resolution strategy (see its
	// comment) -- Subprocess.pathSearch first (cross-platform, honors
	// PATHEXT/PATH), then a short list of common install locations for a
	// GUI app that doesn't inherit a login shell's PATH. Windows's own
	// python.org installer puts "python" on PATH, not "python3" (unlike
	// Homebrew/most Linux distros), hence trying both names there. Each
	// candidate is screened with _supportsLoadExtension before being
	// accepted -- see that method's own comment for why.
	async _findPython3() {
		let { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
		let tried = [];
		let names = Zotero.isWin ? ["python", "python3"] : ["python3"];
		for (let name of names) {
			try {
				let found = await Subprocess.pathSearch(name);
				if (found) {
					tried.push(found);
					if (await this._supportsLoadExtension(found)) return found;
				}
			}
			catch (e) {
				// Not on PATH under this name -- try the next name, or fall
				// through to the candidate list below.
			}
		}
		let candidates = Zotero.isWin
			? ["C:\\Python313\\python.exe", "C:\\Python312\\python.exe", "C:\\Python311\\python.exe"]
			: ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"];
		for (let path of candidates) {
			if (await IOUtils.exists(path) && !tried.includes(path)) {
				tried.push(path);
				if (await this._supportsLoadExtension(path)) return path;
			}
		}
		if (tried.length) {
			throw new Error(`Found Python 3 at ${tried.join(", ")}, but none of them support SQLite loadable extensions (required for sqlite-vec). Install Python from python.org or Homebrew (not pyenv, and not macOS's /usr/bin/python3) and try again.`);
		}
		throw new Error("Python 3 not found -- install it from python.org (Windows) or your system package manager, then try again.");
	},

	// `dir`, if given, overrides the default venv PARENT directory
	// (Zotero.DataDirectory.dir) -- not yet exposed in any UI (see this
	// module's own header comment), but accepted now so a future directory
	// picker can just pass it straight through.
	venvDir(dir) {
		return PathUtils.join(dir || Zotero.DataDirectory.dir, "LLMz", "venv");
	},

	// Same Windows-vs-Unix venv layout LLMTables/LLMFigures' own
	// _pythonPath() must resolve to -- Scripts/python.exe (no "3" suffix)
	// vs. bin/python3, per Python's own venv module conventions on each
	// platform.
	_venvPythonPath(venvDir) {
		return Zotero.isWin
			? PathUtils.join(venvDir, "Scripts", "python.exe")
			: PathUtils.join(venvDir, "bin", "python3");
	},

	_venvPipPath(venvDir) {
		return Zotero.isWin
			? PathUtils.join(venvDir, "Scripts", "pip.exe")
			: PathUtils.join(venvDir, "bin", "pip3");
	},

	// Runs `command` with `args` directly, no shell -- same reasoning as
	// LLMReferences._runNode (Subprocess.call handles cross-platform
	// process spawning on its own; a shell wrapper would just reintroduce
	// the Unix-only /bin/sh dependency that fix removed). `onMessage`, if
	// given, is called with each raw output chunk as it arrives (both
	// `python -m venv` and `pip install` can run long enough that a caller
	// will want live progress, not one silent multi-minute await). Throws
	// (including captured output) on a nonzero exit.
	//
	// stderr: "stdout" merges stderr into the same pipe as stdout -- confirmed
	// (the hard way, see LLMReferences._runNode's own comment) that
	// proc.stderr isn't a readable stream on its own by default.
	async _run(command, args, onMessage) {
		let { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
		let proc = await Subprocess.call({ command, arguments: args, stderr: "stdout" });
		let output = "";
		let chunk;
		while ((chunk = await proc.stdout.readString())) {
			output += chunk;
			onMessage?.(chunk);
		}
		let { exitCode } = await proc.wait();
		if (exitCode !== 0) {
			throw new Error(`${command} ${args.join(" ")} failed (exit ${exitCode}): ${output.trim() || "(no output)"}`);
		}
		return output;
	},

	// Creates the venv (if it doesn't already exist -- idempotent, so
	// re-running this after a version bump just re-runs `pip install`,
	// which is a fast no-op when requirements.txt hasn't changed) and
	// installs requirements.txt into it. requirements.txt itself is read
	// via Zotero.File.getContentsFromURL(rootURI + ...) (works for both an
	// unpacked dev install and a packed jar:-URI .xpi, same as
	// llm-chat-pane.js's own style.css/vendor CSS loading) and written out
	// to a real filesystem path under Zotero.DataDirectory.dir -- pip
	// itself needs a real path, not a jar: URI, to install from.
	async setup(dir, onMessage) {
		let pythonPath = await this._findPython3();
		let venvDir = this.venvDir(dir);

		// An existing venv predates _findPython3's own load-extension check
		// (or was built before this check existed) -- rebuild it from the
		// now-vetted pythonPath rather than silently keep reusing a venv
		// that can never load sqlite-vec (see db.py's _connect for what
		// that failure looks like downstream).
		if (await IOUtils.exists(venvDir) && !await this._supportsLoadExtension(this._venvPythonPath(venvDir))) {
			onMessage?.(`Existing virtual environment at ${venvDir} lacks SQLite extension support -- rebuilding it...\n`);
			await IOUtils.remove(venvDir, { recursive: true });
		}

		if (!await IOUtils.exists(venvDir)) {
			onMessage?.(`Creating virtual environment at ${venvDir}...\n`);
			await IOUtils.makeDirectory(PathUtils.parent(venvDir), { ignoreExisting: true, createAncestors: true });
			await this._run(pythonPath, ["-m", "venv", venvDir], onMessage);
			this.log(`setup: created venv at ${venvDir}`);
		}
		else {
			onMessage?.(`Using existing virtual environment at ${venvDir}...\n`);
		}

		let requirementsSrc = await Zotero.File.getContentsFromURL(this._rootURI + "requirements.txt");
		let llmzDir = PathUtils.join(Zotero.DataDirectory.dir, "LLMz");
		await IOUtils.makeDirectory(llmzDir, { ignoreExisting: true, createAncestors: true });
		let requirementsPath = PathUtils.join(llmzDir, "requirements.txt");
		await IOUtils.writeUTF8(requirementsPath, requirementsSrc);

		onMessage?.("Installing dependencies from requirements.txt...\n");
		await this._run(this._venvPipPath(venvDir), ["install", "-r", requirementsPath], onMessage);
		onMessage?.("Python environment ready.\n");
		this.log("setup: dependencies installed");
	},
};
