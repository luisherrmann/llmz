// JS-side wrapper for scripts/db.py -- the consolidated sqlite-vec store
// for every paper's own embeddings, one .sqlite file PER EMBEDDING MODEL
// under LLMz/cache/embeddings/ (e.g. embeddings/text-embedding-3-small.sqlite),
// replacing the old one-JSON-file-per-item-per-kind cache under
// LLMz/cache/text/. See db.py's own header comment for the actual schema
// and rationale for splitting by model rather than sharing one file.
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

	async _dbDir() {
		let dir = PathUtils.join(Zotero.DataDirectory.dir, "LLMz", "cache", "embeddings");
		await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
		return dir;
	},

	// Model names routinely contain characters unsafe (or at least
	// unwise) in a bare filename -- "/" (e.g. an LM Studio HF-style
	// "org/repo" path) or ":" (an Ollama tag like "mxbai-embed-large:latest").
	// Sanitized rather than hashed (unlike the old shared-file schema's
	// vec0 TABLE name, which had no reason to stay human-readable) -- the
	// whole point of splitting into per-model files is that
	// `ls cache/embeddings/` should be self-documenting, and at this
	// plugin's actual scale (one person's own handful of embedding models
	// over time) a sanitized-name collision is not a realistic concern.
	_sanitizeModelName(model) {
		return model.replace(/[^A-Za-z0-9._-]+/g, "_");
	},

	async _dbPath(model) {
		return PathUtils.join(await this._dbDir(), `${this._sanitizeModelName(model)}.sqlite`);
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
	// (against `model`'s own .sqlite file -- db.py itself has no notion of
	// "model" as a concept at all, see its own header comment) and reads
	// back the output JSON, then cleans up both temp files -- unique names
	// (not a fixed path) since several `command` calls can be in flight at
	// once (e.g. Index All's own worker pool, see ui/advanced.js's
	// runIndexAll), each needing its own input/output pair rather than
	// clobbering a shared one.
	async _run(command, model, data) {
		let scriptsDir = PathUtils.join(Zotero.DataDirectory.dir, "LLMz", "scripts");
		await IOUtils.makeDirectory(scriptsDir, { ignoreExisting: true, createAncestors: true });
		let stamp = `${command}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
		let inputPath = PathUtils.join(scriptsDir, `db_in_${stamp}.json`);
		let outputPath = PathUtils.join(scriptsDir, `db_out_${stamp}.json`);
		let stderrPath = `${outputPath}.err`;

		await IOUtils.writeUTF8(inputPath, JSON.stringify(data));
		try {
			let dbPath = await this._dbPath(model);
			let pythonPath = this._pythonPath();
			let scriptPath = this._scriptPath();
			let args = [dbPath, command, inputPath, outputPath].map(a => JSON.stringify(a)).join(" ");
			let cmd = `${JSON.stringify(pythonPath)} ${JSON.stringify(scriptPath)} ${args} 2>${JSON.stringify(stderrPath)}`;

			this.log(`_run: ${command} (${model})`);
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
	// paper_id is shared across the whole batch (matching how a paper's own
	// chunks are always embedded together), so it's pulled out as its own
	// param rather than repeated per item. `model` routes to that model's
	// own .sqlite file (see _dbPath) -- no longer stored per-row, since a
	// file only ever holds one model's embeddings. Returns the assigned
	// ids, same order as `items`.
	async insert(paperId, model, items) {
		let result = await this._run("insert", model, {
			items: items.map(item => ({
				paper_id: paperId,
				source: item.source,
				source_id: item.sourceId,
				embedding: item.embedding,
			})),
		});
		return result.ids;
	},

	// Returns [{ id, paperId, source, sourceId, distance }, ...], nearest
	// first, length <= topK. `paperId`/`excludePaperId`/`source`/`sources`
	// (all optional) restrict the search -- see db.py's own _cmd_query
	// comment for how filtering actually works under the hood: pushed down
	// as a `rowid IN (subquery)` restriction BEFORE the vec0 MATCH search
	// runs (a true filtered search, not an over-fetch-then-filter
	// approximation that could miss a real top-k match). `excludePaperId`
	// is citation.js's getCrossLibraryChunks' own use -- searching every
	// OTHER paper in the library for the currently open one's question --
	// and is mutually exclusive with `paperId` in practice (one includes a
	// single paper, the other excludes one), though nothing here enforces
	// that. `sources` (an array, restricting to ANY of several kinds at
	// once via SQL IN) is a separate param from the singular `source`
	// (exactly one kind) rather than overloading one into accepting either
	// a string or an array -- also getCrossLibraryChunks' own use, for a
	// search restricted to "any of these several non-prose kinds" (see its
	// own comment); giving both is not meaningful and not validated against
	// here.
	async query(model, embedding, topK, { paperId, excludePaperId, source, sources } = {}) {
		let result = await this._run("query", model, {
			embedding,
			top_k: topK,
			...(paperId !== undefined ? { paper_id: paperId } : {}),
			...(excludePaperId !== undefined ? { exclude_paper_id: excludePaperId } : {}),
			...(source !== undefined ? { source } : {}),
			...(sources !== undefined ? { sources } : {}),
		});
		return result.results.map(r => ({
			id: r.id,
			paperId: r.paper_id,
			source: r.source,
			sourceId: r.source_id,
			distance: r.distance,
		}));
	},

	// Batched counterpart to query() above -- one subprocess call for
	// several query vectors instead of one call per vector. sqlite-vec's
	// MATCH operator only ever takes a single query vector per SQL
	// statement (there's no native multi-vector MATCH), so this doesn't
	// change the underlying search itself -- what it saves is db.py's own
	// fixed per-invocation cost (python startup + imports + connect, see
	// db.py's own _cmd_query_batch comment), paid once for the whole batch
	// instead of once per query. `queries` is [{ embedding, topK, paperId?,
	// excludePaperId?, source?, sources? }, ...], all against the SAME
	// `model` (and therefore the same underlying file) -- returns one
	// [{ id, paperId, source, sourceId, distance }, ...] array per entry,
	// same order -- e.g. citation.js's getNearestSentences, looking up the
	// nearest sentence for each of several unresolved citations in one
	// round trip.
	async queryBatch(model, queries) {
		let result = await this._run("query_batch", model, {
			queries: queries.map(q => ({
				embedding: q.embedding,
				top_k: q.topK,
				...(q.paperId !== undefined ? { paper_id: q.paperId } : {}),
				...(q.excludePaperId !== undefined ? { exclude_paper_id: q.excludePaperId } : {}),
				...(q.source !== undefined ? { source: q.source } : {}),
				...(q.sources !== undefined ? { sources: q.sources } : {}),
			})),
		});
		return result.results.map(rows => rows.map(r => ({
			id: r.id,
			paperId: r.paper_id,
			source: r.source,
			sourceId: r.source_id,
			distance: r.distance,
		})));
	},

	// Drops every embedding for `paperId` under `model`'s own file,
	// optionally narrowed further to one source -- e.g. the Cache section's
	// own per-type Clear Cache, or Clear All's whole-library reset (see
	// ui/advanced.js), would call this once per paper rather than needing
	// their own SQL. `model` is REQUIRED (unlike the old shared-file
	// schema, where omitting it deleted across every model at once) --
	// Clear Cache/Clear All now only ever clear the CURRENTLY SELECTED
	// embedding model's own embeddings for a paper, not every model that
	// paper was ever embedded under; a stale prior model's file, if any,
	// is simply left alone. Returns the number of rows actually removed.
	async deleteForPaper(paperId, model, { source } = {}) {
		let result = await this._run("delete", model, {
			paper_id: paperId,
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
		await this.deleteForPaper(paperId, model, { source });
		if (!items.length) return [];
		return this.insert(paperId, model, items.map(item => ({ ...item, source })));
	},

	// Cheap existence check -- mirrors the hasCache(item) pattern already
	// used throughout this plugin (LLMCitation.hasCache and friends, see
	// ui/advanced.js's getIndexStatus) for the library-index-status bar.
	// Returns `count` alongside `has` -- a plain COUNT(*) on the `embeddings`
	// table, not a vec0 fetch, so citation.js's getTextIndex can use it to
	// check whether the DB's row count for a paper matches its current
	// sentence/paragraph count WITHOUT fetching every vector (see that
	// function's own comment on why the fetch itself is the expensive
	// part).
	async hasEmbeddings(paperId, model, { source } = {}) {
		let result = await this._run("has", model, {
			paper_id: paperId,
			...(source !== undefined ? { source } : {}),
		});
		return { has: result.has, count: result.count };
	},
};
