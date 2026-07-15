// JS-side wrapper for scripts/db.py -- the consolidated sqlite-vec store
// for every paper's own embeddings, replacing the old one-JSON-file-per-
// item-per-kind cache under LLMz/cache/citation/ with a single database at
// LLMz/cache/embeddings.sqlite, shared across the whole library. See
// db.py's own header comment for the actual schema and rationale.
//
// This module only owns running db.py and shaping its JSON in/out -- it
// does NOT (yet) replace LLMCitation's own existing per-item disk cache;
// nothing currently calls into this. Migrating LLMCitation/LLMSemanticHistory/
// etc. to read and write through here instead is a separate, later step.
LLMEmbeddingsDB = {
	_scriptName: "db.py",
	_venvMissing: false,

	log(msg) {
		Zotero.debug("LLM Chat Pane [EmbeddingsDB]: " + msg);
	},

	// Delegates to LLMPythonSetup (core/python-setup.js), which owns the
	// venv's actual layout convention -- same reasoning as
	// document/figures.js's own _pythonPath().
	_pythonPath() {
		return LLMPythonSetup._venvPythonPath(LLMPythonSetup.venvDir());
	},

	_scriptPath() {
		return PathUtils.join(Zotero.DataDirectory.dir, "LLMz", "scripts", this._scriptName);
	},

	async _dbPath() {
		let dir = PathUtils.join(Zotero.DataDirectory.dir, "LLMz", "cache");
		await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
		return PathUtils.join(dir, "embeddings.sqlite");
	},

	// Deploys db.py the same way document/figures.js deploys its own
	// Python scripts -- read via Zotero.File.getContentsFromURL (works for
	// both an unpacked dev install and a packed jar:-URI .xpi) and written
	// out to a real filesystem path under Zotero.DataDirectory.dir, since
	// `python3 db.py ...` needs a real path, not a jar: URI. Skipped when
	// the deployed copy is already byte-identical, same reasoning as
	// figures.js's own init() (avoids bumping the file's mtime -- and
	// therefore invalidating anything that fingerprints it -- on every
	// single plugin startup for no actual change).
	async init(rootURI) {
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
			let src = await Zotero.File.getContentsFromURL(rootURI + "scripts/" + this._scriptName);
			let destPath = this._scriptPath();
			let existing = null;
			try {
				existing = await IOUtils.readUTF8(destPath);
			}
			catch (e) {} // doesn't exist yet -- fall through to write
			if (existing === src) {
				this.log(`init: ${this._scriptName} already up to date, skipping rewrite`);
			}
			else {
				await IOUtils.writeUTF8(destPath, src);
				this.log(`init: deployed ${this._scriptName}`);
			}
		}
		catch (e) {
			this.log(`init: failed to deploy ${this._scriptName}: ${e.message}`);
		}
	},

	// Writes `data` to a fresh, uniquely-named temp JSON file, runs db.py
	// against it, reads back the output JSON, and cleans up both temp
	// files -- unique names (not a fixed path) since several `command`
	// calls can be in flight at once (e.g. Index All's own worker pool,
	// see ui/advanced.js's runIndexAll), each needing its own input/output
	// pair rather than clobbering a shared one.
	async _run(command, data) {
		let scriptsDir = PathUtils.join(Zotero.DataDirectory.dir, "LLMz", "scripts");
		await IOUtils.makeDirectory(scriptsDir, { ignoreExisting: true, createAncestors: true });
		let stamp = `${command}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
		let inputPath = PathUtils.join(scriptsDir, `db_in_${stamp}.json`);
		let outputPath = PathUtils.join(scriptsDir, `db_out_${stamp}.json`);
		let stderrPath = `${outputPath}.err`;

		await IOUtils.writeUTF8(inputPath, JSON.stringify(data));
		try {
			let dbPath = await this._dbPath();
			let pythonPath = this._pythonPath();
			let scriptPath = this._scriptPath();
			let args = [dbPath, command, inputPath, outputPath].map(a => JSON.stringify(a)).join(" ");
			let cmd = `${JSON.stringify(pythonPath)} ${JSON.stringify(scriptPath)} ${args} 2>${JSON.stringify(stderrPath)}`;

			this.log(`_run: ${command}`);
			let { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
			let proc = await Subprocess.call({ command: "/bin/sh", arguments: ["-c", cmd] });
			let { exitCode } = await proc.wait();

			let stderr = "";
			try { stderr = (await IOUtils.readUTF8(stderrPath)).trim(); } catch (e) {}
			if (stderr) this.log(`db.py stderr: ${stderr}`);

			if (exitCode !== 0) {
				throw new Error(`db.py ${command} failed (exit ${exitCode}): ${stderr || "(no stderr)"}`);
			}
			return JSON.parse(await IOUtils.readUTF8(outputPath));
		}
		finally {
			IOUtils.remove(inputPath).catch(() => {});
			IOUtils.remove(outputPath).catch(() => {});
			IOUtils.remove(stderrPath).catch(() => {});
		}
	},

	// `items` is [{ source, sourceId, embedding: [float, ...] }, ...] --
	// paper_id/model are shared across the whole batch (matching how a
	// paper's own chunks are always embedded together, one model at a
	// time), so they're pulled out as their own params rather than
	// repeated per item. Returns the assigned ids, same order as `items`.
	async insert(paperId, model, items) {
		let result = await this._run("insert", {
			model,
			items: items.map(item => ({
				paper_id: paperId,
				source: item.source,
				source_id: item.sourceId,
				embedding: item.embedding,
			})),
		});
		return result.ids;
	},

	// Returns [{ id, paperId, model, source, sourceId, distance }, ...],
	// nearest first, length <= topK. `paperId`/`excludePaperId`/`source`
	// (all optional) restrict the search -- see db.py's own _cmd_query
	// comment for how filtering actually works under the hood (an
	// over-fetch-then-filter approach, not a native filtered vec0 query).
	// `excludePaperId` is citation.js's getCrossLibraryChunks' own use --
	// searching every OTHER paper in the library for the currently open
	// one's question -- and is mutually exclusive with `paperId` in
	// practice (one includes a single paper, the other excludes one), though
	// nothing here enforces that.
	async query(model, embedding, topK, { paperId, excludePaperId, source } = {}) {
		let result = await this._run("query", {
			model,
			embedding,
			top_k: topK,
			...(paperId !== undefined ? { paper_id: paperId } : {}),
			...(excludePaperId !== undefined ? { exclude_paper_id: excludePaperId } : {}),
			...(source !== undefined ? { source } : {}),
		});
		return result.results.map(r => ({
			id: r.id,
			paperId: r.paper_id,
			model: r.model,
			source: r.source,
			sourceId: r.source_id,
			distance: r.distance,
		}));
	},

	// Drops every embedding for `paperId`, optionally narrowed to one
	// model and/or source -- e.g. the Cache section's own per-type Clear
	// Cache, or Clear All's whole-library reset (see ui/advanced.js),
	// would call this once per paper rather than needing their own SQL.
	// Returns the number of rows actually removed.
	async deleteForPaper(paperId, { model, source } = {}) {
		let result = await this._run("delete", {
			paper_id: paperId,
			...(model !== undefined ? { model } : {}),
			...(source !== undefined ? { source } : {}),
		});
		return result.deleted;
	},

	// Drops whatever was previously stored for this EXACT (paperId, model,
	// source) combo, then inserts the fresh batch -- the usual pattern for
	// "recomputed this paper's embeddings from scratch, replace what was
	// there" (as opposed to insert() alone, which always adds new rows and
	// would leave stale duplicates behind on a recompute -- e.g. a paper
	// re-embedded after its text changed, or after switching embedding
	// model). `items` is [{ sourceId, embedding }, ...] -- no per-item
	// `source` needed (unlike insert()'s own shape) since it's fixed for
	// the whole call. Returns the newly assigned ids.
	async replaceForPaper(paperId, model, source, items) {
		await this.deleteForPaper(paperId, { model, source });
		if (!items.length) return [];
		return this.insert(paperId, model, items.map(item => ({ ...item, source })));
	},

// Cheap existence check -- mirrors the hasCache(item) pattern already
	// used throughout this plugin (LLMCitation.hasCache and friends, see
	// ui/advanced.js's getIndexStatus) for the library-index-status bar.
	// Returns `count` alongside `has` -- a plain COUNT(*) on the `embeddings`
	// table, not a vec0 fetch, so citation.js's getParagraphIndex can use it
	// to check whether the DB's row count for a paper matches its current
	// paragraph count WITHOUT fetching every vector (see that function's own
	// comment on why the fetch itself is the expensive part).
	async hasEmbeddings(paperId, model, { source } = {}) {
		let result = await this._run("has", {
			paper_id: paperId,
			model,
			...(source !== undefined ? { source } : {}),
		});
		return { has: result.has, count: result.count };
	},
};
