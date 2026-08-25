// Detects preformatted/code-listing regions -- combines PyMuPDF background-
// fill+font-mismatch detection with SDT's own structure (see
// scripts/extract-preformatted-sdt.js/scripts/extract_preformatted.py's own
// header comments for the full two-signal rationale and the concrete
// failure modes that motivated combining both sources rather than trusting
// either alone). Wired the same way document/figures.js/document/tables.js
// are: SDT-only structural detection reuses LLMReferences's deployed sdt/
// copy and Node-running infra (_extensionRoot/_nodePath), while the
// PyMuPDF half needs its own script deployed into the writable LLMz/scripts/
// dir (see init() below), same as figures.js's own list_page_images.py.
//
// Previously, preformatted-block extraction lived directly inside
// core/citation.js's own _buildTextElementsFromStructure, using ONLY SDT's
// own `type: 'preformatted'` blocks with no PyMuPDF cross-check -- moved
// here once the combined pipeline (built and validated separately, see
// extract-preformatted-sdt.js's own header comment) proved to recover
// listing content SDT alone silently dropped or corrupted. Regions from SDT
// alone are NOT persisted anywhere on their own -- extract-preformatted-
// sdt.js always merges them with PyMuPDF's own regions FIRST, and it's only
// that merged, unioned, caption-matched result that ever reaches this
// module's own cache/embeddings.
LLMPreformatted = {
	_sdtScriptName: "extract-preformatted-sdt.js",
	// PyMuPDF background-fill+font detection (see its own header comment) --
	// deployed into the writable LLMz/scripts/ dir by this module's own
	// init() below, same as document/figures.js's own list_page_images.py/
	// render_crops.py, since extract-preformatted-sdt.js (a plain Node
	// script) needs a real filesystem path to invoke it with, not something
	// resolvable from inside a packed .xpi's jar: URI.
	_pyScriptName: "extract_preformatted.py",
	_cacheVersion: 1, // bump when the cached index schema changes (JS-side, not just Python/Node scripts)
	_venvMissing: false,
	_indexCache: new Map(),

	log(msg) {
		Zotero.debug("LLM Chat Pane [Preformatted]: " + msg);
	},

	// Delegates to LLMPythonSetup (core/python-setup.js), which owns the
	// venv's actual layout convention -- this must always resolve to the
	// SAME path that module's own setup() creates, so it's the single
	// source of truth rather than a second hardcoded copy.
	_pythonPath() {
		return LLMPythonSetup._venvPythonPath(LLMPythonSetup.venvDir());
	},

	_scriptPath(name) {
		return PathUtils.join(Zotero.DataDirectory.dir, "LLMz", "scripts", name);
	},

	// Unlike document/tables.js (SDT-only detection, venv only ever needed
	// lazily for on-demand image rendering), detection ITSELF needs the
	// venv here -- extract-preformatted-sdt.js calls extract_preformatted.py
	// as a real subprocess as its very first step -- so this checks/flags
	// venv presence the same way document/figures.js already does for its
	// own list_page_images.py, and getPreformattedIndex below refuses to run
	// at all (with a clear message) rather than letting the Node script fail
	// with a much less diagnostic underlying error.
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
			let src = await Zotero.File.getContentsFromURL(rootURI + "scripts/" + this._pyScriptName);
			let destPath = this._scriptPath(this._pyScriptName);
			// Skipped when unchanged -- an unconditional rewrite here bumps the
			// file's mtime on every single plugin startup even when its content
			// is identical, which invalidates _scriptFingerprint() (and
			// therefore the disk cache built on getPreformattedIndex below) on
			// the first prompt after every restart, forcing a needless
			// re-extraction.
			let existing = null;
			try {
				existing = await IOUtils.readUTF8(destPath);
			}
			catch (e) {} // doesn't exist yet -- fall through to write
			if (existing === src) {
				this.log(`init: ${this._pyScriptName} already up to date, skipping rewrite`);
			}
			else {
				await IOUtils.writeUTF8(destPath, src);
				this.log(`init: deployed ${this._pyScriptName}`);
			}
		}
		catch (e) {
			this.log(`init: failed to deploy ${this._pyScriptName}: ${e.message}`);
		}
	},

	_nodeScriptPath(name) {
		return PathUtils.join(LLMReferences._extensionRoot, "scripts", name);
	},

	async _cacheDir() {
		let dir = PathUtils.join(Zotero.DataDirectory.dir, "LLMz", "cache", "preformatted");
		await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
		return dir;
	},

	// Both scripts directly affect detection output here (unlike
	// figures.js's own render_crops.py, deliberately excluded from ITS
	// fingerprint since it only ever fills in image_data lazily, AFTER
	// detection) -- extract_preformatted.py's own fill/font signals feed
	// directly into extract-preformatted-sdt.js's merge, so either one
	// changing can change the result.
	async _scriptFingerprint() {
		try {
			let parts = [`v${this._cacheVersion}`];
			let sdtStat = await IOUtils.stat(this._nodeScriptPath(this._sdtScriptName));
			parts.push(`${sdtStat.size}:${sdtStat.lastModified}`);
			let pyStat = await IOUtils.stat(this._scriptPath(this._pyScriptName));
			parts.push(`${pyStat.size}:${pyStat.lastModified}`);
			return parts.join("|");
		}
		catch (e) {
			return null;
		}
	},

	// `embeddingProvider`/`embeddingModel` are resolved ONCE by the caller
	// (getPreformattedIndex), not re-resolved here -- see its own comment
	// for why (the same values are also needed for the memory-cache check,
	// which happens before this is ever called).
	async _loadDiskCache(item, embeddingProvider, embeddingModel) {
		try {
			let path = PathUtils.join(await this._cacheDir(), `${item.id}.json`);
			if (!await IOUtils.exists(path)) return null;
			let index = JSON.parse(await IOUtils.readUTF8(path));
			if (index.scriptFingerprint !== await this._scriptFingerprint()) {
				this.log(`_loadDiskCache: stale (extraction script(s) changed) for item ${item.id}`);
				return null;
			}
			// contentEmbedding/captionEmbedding were computed via
			// LLMCitation.embedBatched, which routes through whichever
			// embedding provider/model was selected AT THAT TIME -- a cache
			// built under a different provider/model is silently incompatible
			// (not comparable via cosine similarity, even if the vector
			// happens to be the same length), so it must invalidate here too,
			// same as document/figures.js's/document/tables.js's own
			// _loadDiskCache.
			if (index.embeddingProvider !== embeddingProvider || index.embeddingModel !== embeddingModel) {
				this.log(`_loadDiskCache: stale (embedding provider/model changed) for item ${item.id}`);
				return null;
			}
			this.log(`_loadDiskCache: loaded ${index.preformatted.length} preformatted region(s) for item ${item.id}`);
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
			// contentEmbedding/captionEmbedding stripped before writing -- the
			// embeddings DB (see getPreformattedIndex's own sync right after
			// this call) is the sole store for the actual vectors now, same
			// reasoning as citation.js's/figures.js's/tables.js's own disk
			// caches. A shallow per-region copy, not a mutation of
			// `index.preformatted` itself -- the caller keeps holding (and
			// memory-caching) that same object, embeddings and all, unrelated
			// to what actually lands on disk.
			let diskIndex = {
				...index,
				preformatted: index.preformatted.map(({ contentEmbedding, captionEmbedding, ...rest }) => rest),
			};
			await IOUtils.writeUTF8(path, JSON.stringify(diskIndex, null, 2));
			this.log(`_saveDiskCache: saved ${index.preformatted.length} preformatted region(s) for item ${item.id}`);
		}
		catch (e) {
			this.log(`_saveDiskCache: failed: ${e.message}`);
		}
	},

	async _extractRaw(item, onMessage) {
		let pdfPath = item.getFilePath();
		if (!pdfPath) throw new Error("Item has no attached file path");
		let outputPath = PathUtils.join(Zotero.DataDirectory.dir, "LLMz", "scripts", `preformatted_${item.id}.json`);
		let structureCachePath = await LLMStructureSDT.ensureStructureCache(item, onMessage);
		// python_path/extract_preformatted_script_path are resolved here and
		// passed in as plain CLI args -- extract-preformatted-sdt.js is a
		// plain Node script with no access to LLMPythonSetup's own venv-
		// resolution logic (see its own header comment).
		await LLMReferences._runNode(
			this._nodeScriptPath(this._sdtScriptName), this._sdtScriptName,
			pdfPath, outputPath, this._pythonPath(), this._scriptPath(this._pyScriptName), structureCachePath
		);
		let preformatted = JSON.parse(await IOUtils.readUTF8(outputPath));
		IOUtils.remove(outputPath).catch(() => {});
		this.log(`_extractRaw: extracted ${preformatted.length} preformatted region(s)`);
		return preformatted;
	},

	// Embeds each region's own CONTENT (its raw, uncollapsed text -- always)
	// and its matched CAPTION (only for the subset with a non-empty
	// `.caption`, see extract-preformatted-sdt.js's own findNearbyCaption)
	// as two independent vectors -- same "separate content/caption sources"
	// convention document/tables.js's own _addTextEmbeddings already uses,
	// for the same reason (different-quality signals; a future retrieval
	// step can query both independently and union the results, see
	// citation.js's own getRelevantChunks' `sources` handling). Filtering to
	// non-empty captions here (unlike tables.js, whose captions are always
	// present by construction of its own caption-anchored detection) mirrors
	// this module's predecessor logic in citation.js -- a listing with no
	// matched label simply has no caption row at all, not an embedding of
	// empty text. `progress`, if given, has its setProgress(current, total)
	// called as batches complete, same in-place progress reporting
	// citation.js's/figures.js's/tables.js's own embedding loops use.
	async _addTextEmbeddings(preformatted, textModel, progress, provider) {
		if (!preformatted.length) return preformatted;
		if (!textModel) textModel = await LLMCitation.getEmbeddingModel();
		try {
			let captioned = preformatted.filter(pf => pf.caption);
			let total = preformatted.length + captioned.length;
			let contentEmbeddings = await LLMCitation.embedBatched(preformatted.map(pf => pf.text), textModel, provider, {
				onProgress: completed => progress?.setProgress?.(completed, total),
			});
			let captionEmbeddings = await LLMCitation.embedBatched(captioned.map(pf => pf.caption), textModel, provider, {
				onProgress: completed => progress?.setProgress?.(preformatted.length + completed, total),
			});
			for (let i = 0; i < preformatted.length; i++) {
				preformatted[i].contentEmbedding = contentEmbeddings[i];
			}
			// `captioned` holds the SAME object references as `preformatted`
			// (Array.prototype.filter doesn't copy elements) -- mutating them
			// here is mutating the matching entries in `preformatted` too.
			for (let i = 0; i < captioned.length; i++) {
				captioned[i].captionEmbedding = captionEmbeddings[i];
			}
		}
		catch (e) {
			this.log(`_addTextEmbeddings: failed: ${e.message}`);
		}
		return preformatted;
	},

	// Builds (or returns an already-cached) internal index -- memory/disk
	// cache lookups exactly mirror document/figures.js's/document/tables.js's
	// own getFigureIndex/getTableIndex. Internal shape:
	// { preformatted: [...], scriptFingerprint, embeddingProvider,
	//   embeddingModel } -- getPreformattedIndex below reshapes this into
	// the { sentences, model, provider, paperId, sources } view
	// llm/prompt.js's buildPromptWithActivePDFContext/citation.js's
	// getRelevantChunks actually expect, same split citation.js's own
	// getTextIndex/getParagraphIndex used to have.
	async _getRawIndex(item, onEmbeddingStart, onMessage, { defer = false } = {}) {
		if (this._venvMissing) {
			throw new Error(
				"Python venv not found. Set it up with the \"venv\" button, or manually:\n"
				+ "  python3 -m venv ~/Zotero/LLMz/venv\n"
				+ "  ~/Zotero/LLMz/venv/bin/pip install -r requirements.txt"
			);
		}

		// Resolved BEFORE the memory-cache check below (not just threaded
		// through to _loadDiskCache further down) -- switching provider/model
		// mid-session must invalidate an already-loaded memory-cached index
		// too, since _loadDiskCache's own check would otherwise never even
		// run (only consulted on a memory-cache MISS).
		let embeddingProvider = LLMInterfaces._embeddingProvider;
		let embeddingModel = await LLMCitation.getEmbeddingModel();

		let memoryCached = this._indexCache.get(item.id);
		if (memoryCached && memoryCached.embeddingProvider === embeddingProvider && memoryCached.embeddingModel === embeddingModel) {
			this.log(`_getRawIndex: memory cache hit for item ${item.id}`);
			return memoryCached;
		}

		let cached = await this._loadDiskCache(item, embeddingProvider, embeddingModel);
		if (cached) {
			this._indexCache.set(item.id, cached);
			return cached;
		}

		let preformatted = await this._extractRaw(item, onMessage);
		let progress = preformatted.length ? onEmbeddingStart?.(embeddingProvider, embeddingModel) : null;
		let embedded = await this._addTextEmbeddings(preformatted, embeddingModel, progress, embeddingProvider);
		let captionedCount = embedded.filter(pf => pf.captionEmbedding).length;
		if (progress) {
			progress.textContent = `Recomputed ${embedded.length} preformatted content and ${captionedCount} preformatted caption embedding${(embedded.length + captionedCount) === 1 ? "" : "s"} using ${embeddingProvider} ${embeddingModel}.`;
		}
		let index = { preformatted: embedded, scriptFingerprint: await this._scriptFingerprint(), embeddingProvider, embeddingModel };
		this._indexCache.set(item.id, index);
		if (defer) {
			// See tables.js's own `defer` comment -- the index pipeline
			// persists once, after cross-index deduplication has run. That
			// matters most here: this module's own sourceIds are ARRAY
			// POSITIONS, so persisting before dedup means writing rows that
			// dedup then has to renumber (see scripts/db.py's `compact`),
			// whereas persisting after assigns them correctly first time.
			index.pendingPersist = true;
			return index;
		}
		await this.persistIndex(item, index, onMessage);
		return index;
	},

	// Writes `index` to its disk cache and mirrors its embeddings into the
	// embeddings DB. Split out of _getRawIndex so the index pipeline can
	// defer both until after deduplication (see `defer` above); calling it
	// twice is harmless, since both writes replace wholesale.
	//
	// source_id here is each region's own ARRAY POSITION (0-indexed), NOT
	// preformatted_id -- deliberately unlike table_id/figure_id, which
	// tables.js/figures.js use, since neither goes through
	// LLMCitation.getRelevantChunks. This module's own getPreformattedIndex
	// DOES, and getRelevantChunks resolves a hit via a direct array index
	// (`index.sentences[r.sourceId]`), so a 1-indexed id would be off by
	// one -- and, critically, removing an entry shifts every later one,
	// which is why deduplication has to happen BEFORE this runs.
	// Best-effort, same reasoning as citation.js's/tables.js's own sync --
	// the disk cache is already the source of truth this module reads from;
	// this DB is an additional, non-authoritative mirror.
	async persistIndex(item, index, onMessage) {
		delete index.pendingPersist;
		await this._saveDiskCache(item, index);
		try {
			let embedded = index.preformatted || [];
			// See tables.js's own guard here -- a cache-hit index carries no
			// vectors, and replaceForPaper deletes before inserting, so
			// syncing one would wipe rows that are already correct.
			if (embedded.length && !embedded.some(pf => pf.contentEmbedding || pf.captionEmbedding)) return;
			let contentEntries = embedded
				.map((pf, i) => ({ sourceId: i, embedding: pf.contentEmbedding }))
				.filter(e => e.embedding);
			let captionEntries = embedded
				.map((pf, i) => ({ sourceId: i, embedding: pf.captionEmbedding }))
				.filter(e => e.embedding);
			await LLMEmbeddingsDB.replaceForPaper(item.id, index.embeddingModel, "preformatted_content", contentEntries);
			await LLMEmbeddingsDB.replaceForPaper(item.id, index.embeddingModel, "preformatted_caption", captionEntries);
			onMessage?.(`Synced ${contentEntries.length} preformatted content and ${captionEntries.length} preformatted caption embedding${(contentEntries.length + captionEntries.length) === 1 ? "" : "s"} to the embeddings DB for item ${item.id}.`);
		}
		catch (e) {
			this.log(`persistIndex: failed to sync to embeddings DB: ${e.message}`);
			onMessage?.(`Failed to sync preformatted embeddings to the embeddings DB for item ${item.id}: ${e.message}`);
		}
	},

	// The short, citable LABEL for a region's own matched caption -- the
	// leading "<Word> <number>" of it ("Listing 1", "Algorithm 3"), NOT the
	// whole caption text ("Listing 1. Example MCP Extension Data"), so a
	// model citing it writes a short label the way it already does for
	// "Table 1"/"Figure 2" rather than pasting a full sentence into a link.
	// Deliberately NOT hardcoded to "Listing" -- a paper is free to label a
	// code block "Algorithm N", "Snippet N", "Program N" etc., and the
	// caption-shape check that let this caption through in the first place
	// (extract-preformatted-sdt.js's own looksLikeCaptionLabel) already
	// accepts any leading word, so this mirrors it rather than assuming one
	// vocabulary. Returns "" when the caption doesn't actually open with
	// that shape, letting the caller fall back to its own synthetic
	// numbering.
	_captionLabel(caption) {
		let m = /^\s*([A-Za-z]+)\.?\s+[(\[{<]?(\d+)[)\]}>.:]?/.exec(caption || "");
		return m ? `${m[1]} ${m[2]}` : "";
	},

	// Assigns each GROUP (see extract-preformatted-sdt.js's own grouping
	// pass -- fragments of one page-split listing share a preformatted_id)
	// a single citable label, then stamps it onto every fragment of that
	// group so a caller holding any one fragment can cite the whole thing.
	// A group with a usable caption label uses it ("Listing 1"); one
	// without gets a synthetic "Preformatted N" instead, N counting ONLY
	// the unlabeled groups, in document order -- same "separate counter for
	// the ones with no real paper-printed number" convention
	// extract-figures-sdt.js's own figure_extra_num / extract-tables-sdt.js's
	// own table_extra_num already use, rather than reusing preformatted_id
	// (which would produce visibly gappy labels like "Preformatted 5",
	// "Preformatted 9" whenever captioned listings sit between them).
	// `regions` must already be in document order (getPreformattedIndex's
	// own source array is, sorted by blockIndex) so that counter is stable
	// across runs.
	_assignLabels(regions) {
		let labelByGroup = new Map();
		let unlabeledCount = 0;
		for (let pf of regions) {
			let key = pf.preformatted_id ?? `__ungrouped_${pf.blockIndex}`;
			if (labelByGroup.has(key)) continue;
			// A group's caption sits on exactly ONE of its fragments (the
			// grouping pass only ever extends an UNcaptioned region
			// forward), but which one isn't fixed -- scan the whole group
			// rather than assuming it's this first-seen fragment.
			let caption = regions.find(r => (r.preformatted_id ?? `__ungrouped_${r.blockIndex}`) === key && r.caption)?.caption;
			let label = this._captionLabel(caption);
			if (!label) label = `Preformatted ${++unlabeledCount}`;
			labelByGroup.set(key, label);
		}
		return regions.map(pf => ({
			...pf,
			label: labelByGroup.get(pf.preformatted_id ?? `__ungrouped_${pf.blockIndex}`),
		}));
	},

	// Public entry point, used by llm/prompt.js's buildPromptWithActivePDFContext
	// the same way LLMCitation.getParagraphIndex is -- getRelevantChunks
	// against BOTH `preformatted_content` and `preformatted_caption` (via
	// `sources`, not the singular `source` getParagraphIndex/getCitationIndex
	// use -- see getRelevantChunks' own comment on how it dedupes a region
	// matched via either or both of its own two rows) picks the top-K most
	// relevant code/JSON/listing regions when the full PDF doesn't fit the
	// context budget, same retrieval mechanism as paragraphs, just against
	// two separate DB sources so a preformatted region never competes with
	// (or gets rendered as) an ordinary paragraph. `order` on each returned
	// entry is `blockIndex` (see extract-preformatted-sdt.js's own header
	// comment) -- the SAME raw structure.content-index scale
	// core/citation.js's own paragraph/heading `order` values use, so
	// llm/prompt.js's _interleaveHeadingsAndParagraphs can correctly
	// interleave a region among headings/paragraphs in true document order.
	// `pageIndex`/`rects` are flattened up from extract-preformatted-sdt.js's
	// own nested `position` field -- same flat shape citation.js's own
	// _textRecord already gives paragraphs/headings, so the citation-link
	// mechanism can navigate to a region the same way it already can for a
	// paragraph. That mechanism now exists: `<ref:preformatted:N>` is a
	// first-class ref kind, keyed by preformatted_id rather than by the
	// label's own number (llm/prompt.js's buildLinkIndex explains why), and
	// resolves through the same generic linkIndex lookup every other ref
	// kind uses.
	async getPreformattedIndex(item, onEmbeddingStart, onMessage, { defer = false } = {}) {
		let raw = await this._getRawIndex(item, onEmbeddingStart, onMessage, { defer });
		if (!raw) return null;
		return {
			sentences: this._assignLabels(raw.preformatted).map(pf => ({
				...pf,
				order: pf.blockIndex,
				pageIndex: pf.position?.pageIndex ?? null,
				rects: pf.position?.rects || [],
			})),
			model: raw.embeddingModel,
			provider: raw.embeddingProvider,
			paperId: item.id,
			sources: ["preformatted_content", "preformatted_caption"],
		};
	},

	// Fraction of the SMALLER of two rects that must be covered for them to
	// count as the same physical region. Measured against the smaller one
	// (not either area, and not IoU) because a duplicate detection is
	// typically a near-subset rather than a near-equal box -- one pipeline
	// captures a listing's shaded box, the other only the text inside it.
	// 0.5 sits far above mere adjacency (two stacked elements touching at
	// an edge overlap ~0%) and far below the 96-100% every confirmed
	// duplicate on this plugin's own test paper actually measured.
	_duplicateOverlapThreshold: 0.5,

	// Higher bar than _duplicateOverlapThreshold above, used only by the
	// figure pass in deduplicatePreformatted. That pass has no contest to
	// fall back on -- the figure wins outright -- so a marginal overlap
	// deletes a listing with nothing to weigh against it, whereas the
	// caption contest at 0.5 still has to find the other side genuinely
	// captioned before it removes anything.
	//
	// 0.8 sits inside a wide empirical gap rather than being a round
	// number: measured on OSWorld, the eleven preformatted groups that
	// overlap a figure at all split into nine at 88-100% -- diagram labels,
	// chart axis text, screenshot task instructions, all genuinely a
	// figure's own content -- and two at 56%/62% that are not. Those two
	// are a table's header row and six fragments of real agent code that
	// merely sit near a figure, both of which 0.5 deleted.
	_figureOverlapThreshold: 0.8,

	// How much of a preformatted region's own area has to be accounted for
	// by the UNION of the other elements on its page before it is treated
	// as their content rather than a listing of its own. See
	// deduplicatePreformatted's third pass -- this catches a region that no
	// single element contains, but several together do.
	//
	// Also 0.8, and also chosen from a measured gap rather than by analogy:
	// on OSWorld the one region this actually removes is 96% covered, while
	// the highest-covered survivor reaches 51%.
	_unionCoverageThreshold: 0.8,

	_overlapFraction(a, b) {
		let ix = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
		let iy = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
		if (ix <= 0 || iy <= 0) return 0;
		let areaA = (a[2] - a[0]) * (a[3] - a[1]);
		let areaB = (b[2] - b[0]) * (b[3] - b[1]);
		let smaller = Math.min(areaA, areaB);
		return smaller > 0 ? (ix * iy) / smaller : 0;
	},

	// Fraction of `rect` covered by the UNION of `others`, which may
	// overlap each other freely. Decomposes the region on every other
	// rect's edges and counts the cells that fall inside at least one --
	// summing pairwise intersections instead would double-count wherever
	// two of `others` overlap, and on a real page they routinely do (a
	// figure and its own caption block, say). Same coordinate-compression
	// idea scripts/extract-preformatted-sdt.js's own unionArea uses.
	_coveredFraction(rect, others) {
		let total = (rect[2] - rect[0]) * (rect[3] - rect[1]);
		if (total <= 0 || !others.length) return 0;
		let xs = new Set([rect[0], rect[2]]);
		let ys = new Set([rect[1], rect[3]]);
		for (let o of others) {
			for (let v of [o[0], o[2]]) if (v > rect[0] && v < rect[2]) xs.add(v);
			for (let v of [o[1], o[3]]) if (v > rect[1] && v < rect[3]) ys.add(v);
		}
		let X = [...xs].sort((a, b) => a - b);
		let Y = [...ys].sort((a, b) => a - b);
		let covered = 0;
		for (let i = 0; i < X.length - 1; i++) {
			for (let j = 0; j < Y.length - 1; j++) {
				let cx = (X[i] + X[i + 1]) / 2;
				let cy = (Y[j] + Y[j + 1]) / 2;
				if (others.some(o => cx >= o[0] && cx <= o[2] && cy >= o[1] && cy <= o[3])) {
					covered += (X[i + 1] - X[i]) * (Y[j + 1] - Y[j]);
				}
			}
		}
		return covered / total;
	},

	// True when two entries (each { pageIndex, rects }) share a page and any
	// of their rects overlap past _duplicateOverlapThreshold.
	_regionsOverlap(a, b, threshold = this._duplicateOverlapThreshold) {
		if (a.pageIndex == null || b.pageIndex == null || a.pageIndex !== b.pageIndex) return false;
		for (let ra of a.rects || []) {
			for (let rb of b.rects || []) {
				if (this._overlapFraction(ra, rb) >= threshold) return true;
			}
		}
		return false;
	},

	// A synthetic, extraction-invented label -- NOT a caption the paper
	// itself printed. extract-tables-sdt.js/extract-figures-sdt.js give an
	// UNcaptioned table/figure a stand-in label of the form
	// "<section title>, Unlabelled Table 3" and copy it into `caption` too
	// (see their own unmatched-body handling), so a bare `entry.caption`
	// truthiness check cannot tell a real caption from an invented one.
	// That distinction is the whole basis of the dedup rule below:
	// confirmed concretely on this plugin's own test paper that EVERY one
	// of the 12 spurious "tables" duplicating a listing carried exactly
	// such a synthetic caption, so treating those as captioned would
	// discard the real listing and keep the phantom table.
	_SYNTHETIC_LABEL_RE: /,\s*Unlabelled (?:Table|Figure)\s+\d+\s*$/i,

	_hasGenuineCaption(caption) {
		return !!caption && !this._SYNTHETIC_LABEL_RE.test(caption);
	},

	// Deduplicates preformatted regions against tables/equations/paragraphs/
	// figures, which are all extracted by INDEPENDENT pipelines that never
	// consult each other -- so one physical listing routinely comes back as
	// both a preformatted region AND, say, an unlabelled table, and then
	// appears twice in the model's context.
	//
	// For every geometric overlap (see _regionsOverlap) between a
	// preformatted region A and a table/equation/paragraph B:
	//   - if ONLY B is genuinely captioned, B is the real element -> A loses
	//   - otherwise -> B loses
	// Figures are settled separately, after that contest, and always win --
	// see the second pass below for why the captioned-ness rule inverts for
	// them. A third pass then removes any region left over that the
	// surviving elements collectively cover, which the pairwise tests
	// cannot detect. Both geometric passes act on individual fragments
	// rather than whole groups; only the caption contest is group-level.
	// "Genuinely" excludes extraction-invented labels (see
	// _hasGenuineCaption) -- without that, the rule inverts on real
	// documents and deletes the listings it is meant to protect.
	//
	// A's captioned-ness is evaluated per GROUP, not per fragment: a
	// listing split across a page break carries its caption on exactly ONE
	// of its fragments (see extract-preformatted-sdt.js's grouping pass),
	// so testing a continuation fragment alone would wrongly read the whole
	// listing as uncaptioned.
	//
	// Losers are SPLICED OUT of the arrays they came in on. That is only
	// safe because of WHEN this runs: `sentence`, `paragraph`, `heading`,
	// and both `preformatted_*` embedding rows are keyed by ARRAY INDEX
	// (see citation.js's/this module's own replaceForPaper calls), and
	// getRelevantChunks resolves a hit straight back through
	// `index.sentences[r.sourceId]` -- so removing an entry after those
	// rows exist would re-point every later embedding at the wrong text,
	// with no error to notice. llm/index-pipeline.js therefore calls this
	// BEFORE anything is persisted, so the rows are written from the
	// already-deduplicated arrays; where an index was already on disk from
	// an earlier session, it re-keys the existing rows via `_originalIndex`
	// below rather than letting them drift.
	//
	// Mutates the passed arrays in place and returns a summary of what went
	// (including the stable table/equation ids, which the pipeline needs to
	// delete their rows). Persisting is the caller's job -- see
	// llm/index-pipeline.js, which owns the whole build/dedup/write cycle,
	// since each array is owned by a different module with its own cache.
	deduplicatePreformatted({ preformatted = [], tables = [], equations = [], paragraphs = [], figures = [] }) {
		let empty = { preformatted: 0, tables: 0, equations: 0, paragraphs: 0, tableIds: [], equationIds: [] };
		if (!preformatted.length) return empty;

		// Recorded BEFORE anything is removed: scripts/db.py's `compact`
		// needs each survivor's ORIGINAL position to re-key the embedding
		// rows of an index that was already persisted (a cache hit) before
		// deduplication ran. Harmless for a freshly built index, whose rows
		// are written from the post-deduplication arrays anyway.
		//
		// ALWAYS overwritten, never preserved: this value only means
		// "position in the array as it stands right now", which is exactly
		// how the DB rows for a cache-hit index are numbered. A previous
		// run's value survives into the disk cache (nothing strips it), and
		// honouring that stale number here would point compaction at the
		// wrong rows the second time a paper is deduplicated.
		for (let list of [preformatted, paragraphs]) {
			list.forEach((entry, i) => {
				entry._originalIndex = i;
			});
		}

		let positionOf = entry => ({
			pageIndex: entry.position?.pageIndex ?? entry.pageIndex ?? null,
			rects: entry.position?.rects || entry.rects || [],
		});

		// Group-level, not per-fragment: a listing split across a page break
		// carries its caption on exactly ONE of its fragments (see
		// extract-preformatted-sdt.js's grouping pass), so testing a
		// continuation fragment alone would read the whole listing as
		// uncaptioned and let a phantom table win against it.
		let captionedGroups = new Set();
		for (let pf of preformatted) {
			if (this._hasGenuineCaption(pf.caption)) captionedGroups.add(pf.preformatted_id);
		}

		let others = [
			...tables.map(t => ({ entry: t, kind: "tables", captioned: this._hasGenuineCaption(t.caption) })),
			// An equation's own "caption" is its printed number: equation_num
			// is one the paper itself prints, formula_num is this plugin's
			// own synthetic fallback (see extract-equations.js), so only the
			// former counts as genuinely captioned.
			...equations.map(eq => ({ entry: eq, kind: "equations", captioned: eq.equation_num !== null && eq.equation_num !== undefined })),
			// A paragraph has no caption concept at all, so it can never win
			// -- which is the intent: prose that geometrically sits inside a
			// listing's own box is that listing's own text, picked up twice.
			...paragraphs.map(p => ({ entry: p, kind: "paragraphs", captioned: false })),
		];

		let doomedOthers = new Set();
		let doomedGroups = new Set();
		// Whole listings condemned by the caption contest (group-keyed)
		// versus individual regions condemned by the geometric passes
		// (entry-keyed) -- see each pass for why they differ.
		let doomedFragments = new Set();
		for (let pf of preformatted) {
			if (doomedGroups.has(pf.preformatted_id)) continue;
			let a = positionOf(pf);
			let aCaptioned = captionedGroups.has(pf.preformatted_id);
			for (let other of others) {
				if (doomedOthers.has(other.entry)) continue;
				if (!this._regionsOverlap(a, positionOf(other.entry))) continue;
				if (other.captioned && !aCaptioned) {
					// Only B is genuinely captioned, so B is the real element
					// and this listing loses -- along with every fragment
					// sharing its id, since they are one physical listing.
					doomedGroups.add(pf.preformatted_id);
					break;
				}
				doomedOthers.add(other.entry);
			}
		}

		// Second pass, run AFTER the caption contest above so a listing
		// already resolved there is left alone: a FIGURE always wins, with
		// no contest at all.
		//
		// Deliberately not folded into `others` above. That rule turns on
		// which side is genuinely captioned, and it inverts here: a
		// screenshot's own text band is routinely captioned-looking while
		// the figure containing it is not. Measured on OSWorld, where 13
		// preformatted regions sit inside a figure -- one of them (a
		// "Step 1: pyautogui.click(...)" row label, 90% inside Figure 20)
		// carries a genuine caption, so the contest would have deleted
		// Figure 20 and kept the band. The asymmetry is real rather than a
		// tuning problem: a figure is a raster region that PyMuPDF saw as
		// an actual image XObject, so text found inside its bounds is that
		// image's own content, whatever it looks like to a caption test.
		//
		// _regionsOverlap does the work of "overlaps": it scores
		// intersection over the SMALLER region's area (see
		// _overlapFraction), so this asks how much of the band lies inside
		// the figure rather than whether the two merely touch. At the
		// higher _figureOverlapThreshold, since nothing here weighs against
		// a wrong removal.
		//
		// Per FRAGMENT, unlike the contest above. That one is group-level
		// because captioned-ness is inherited: a page-split listing carries
		// its caption on exactly one fragment, so judging a continuation
		// alone would read the whole listing as uncaptioned. Nothing is
		// inherited here -- a fragment either lies inside a figure or it
		// does not -- and propagating to the group actively destroys real
		// content. Measured on OSWorld, where preformatted_id 10 spans
		// pages 38-40 as five fragments: four have zero figure overlap
		// (including two pyautogui code blocks and D.1's "Success Task"
		// text) and the fifth sits 88% inside Figure 16, which under
		// group-level removal deleted all five.
		for (let pf of preformatted) {
			if (doomedGroups.has(pf.preformatted_id)) continue;
			let a = positionOf(pf);
			for (let fig of figures) {
				if (!this._regionsOverlap(a, positionOf(fig), this._figureOverlapThreshold)) continue;
				doomedFragments.add(pf);
				break;
			}
		}

		// Third pass: a region that no SINGLE element contains can still be
		// entirely accounted for by several of them TOGETHER, and the
		// pairwise tests above cannot see that -- each one asks only "how
		// much of this sits inside that one element".
		//
		// Observed on OSWorld p.9: an 86x267pt vertical strip whose text is
		// plainly a benchmark-comparison table's ("# Instances (# Templates)
		// ... GAIA [36] 466 ...") straddles the boundary between Figure 4
		// below it and Table 4 above it -- 56% inside the figure, ~40%
		// inside the table, under the bar for both, so it survived as a
		// listing while being neither. Measured against the union it is 96%
		// covered.
		//
		// Only elements that actually survived count toward the union: a
		// table already doomed above is not a real element, so letting it
		// vouch for covering something would let one phantom justify
		// deleting another. Paragraphs stay out entirely -- prose is
		// everywhere, and a listing genuinely interleaved with it would be
		// covered by neighbours it merely sits between rather than
		// duplicates.
		let survivingCover = [...figures, ...tables, ...equations].filter(e => !doomedOthers.has(e));
		for (let pf of preformatted) {
			if (doomedGroups.has(pf.preformatted_id) || doomedFragments.has(pf)) continue;
			let a = positionOf(pf);
			if (a.pageIndex == null) continue;
			let cover = [];
			for (let other of survivingCover) {
				let b = positionOf(other);
				if (b.pageIndex !== a.pageIndex) continue;
				cover.push(...(b.rects || []));
			}
			if (!cover.length) continue;
			for (let ra of a.rects || []) {
				if (this._coveredFraction(ra, cover) >= this._unionCoverageThreshold) {
					// Per fragment, for the same reason as the figure pass
					// above.
					doomedFragments.add(pf);
					break;
				}
			}
		}

		let removeFrom = (list, doomed) => {
			let before = list.length;
			for (let i = list.length - 1; i >= 0; i--) {
				if (doomed(list[i])) list.splice(i, 1);
			}
			return before - list.length;
		};

		let tableIds = tables.filter(t => doomedOthers.has(t)).map(t => t.table_id).filter(id => id != null);
		let equationIds = equations.filter(eq => doomedOthers.has(eq)).map(eq => eq.equation_id).filter(id => id != null);

		let result = {
			preformatted: removeFrom(preformatted, pf => doomedGroups.has(pf.preformatted_id) || doomedFragments.has(pf)),
			tables: removeFrom(tables, t => doomedOthers.has(t)),
			equations: removeFrom(equations, eq => doomedOthers.has(eq)),
			paragraphs: removeFrom(paragraphs, p => doomedOthers.has(p)),
			tableIds,
			equationIds,
		};
		this.log(`deduplicatePreformatted: removed ${result.preformatted} listing fragment(s), ${result.tables} table(s), ${result.equations} equation(s), ${result.paragraphs} paragraph(s)`);
		return result;
	},

	// Expands a RETRIEVED subset of regions (getRelevantChunks' own top-K
	// result) back into every region sharing a `preformatted_id` with any
	// hit, in document (`order`) order.
	//
	// Needed because embedding is per-FRAGMENT, not per-listing (see
	// _addTextEmbeddings): a listing split across a page break has one
	// independent content vector per fragment, each covering only its own
	// arbitrary, page-break-determined slice of the code. Retrieval can
	// therefore match just the MIDDLE of a listing (or just the fragment
	// that happens to carry the caption) and return that piece alone --
	// handing the model a listing that starts or stops mid-structure, with
	// no indication anything is missing. Since a group's fragments are one
	// contiguous listing by construction (see extract-preformatted-sdt.js's
	// own grouping pass), a hit on ANY fragment means the whole listing is
	// relevant, so this pulls in its siblings.
	//
	// `allRegions` is getPreformattedIndex's own full `sentences` array;
	// `retrieved` is whatever getRelevantChunks returned from it. An entry
	// with no `preformatted_id` (older cache) is passed through as its own
	// group of one, same defensive fallback llm/prompt.js's own grouping
	// applies.
	expandToFullGroups(allRegions, retrieved) {
		if (!retrieved.length) return retrieved;
		let hitIds = new Set(retrieved.map(pf => pf.preformatted_id ?? `__ungrouped_${pf.order}`));
		return allRegions
			.filter(pf => hitIds.has(pf.preformatted_id ?? `__ungrouped_${pf.order}`))
			.sort((a, b) => a.order - b.order);
	},

	// Debug affordance ("Clear Cache" button) -- drops both the memory and
	// disk cache for this item, so the next getPreformattedIndex() call
	// re-runs extraction from scratch rather than reusing a possibly-stale
	// result. Deliberately leaves this item's embeddings DB rows untouched
	// -- same single combined action document/figures.js's/document/
	// tables.js's own clearCache already is (unlike citation.js's own split
	// clearTextCache/clearEmbeddingsCache), consistent with how ui/advanced.js
	// wires every OTHER per-type cache-status row.
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

	// Cheap disk existence check (no content read) -- used by ui/advanced.js's
	// "Library index status" bar the same way document/figures.js's/
	// document/tables.js's own hasCache is.
	async hasCache(item) {
		let dir = await this._cacheDir();
		return IOUtils.exists(PathUtils.join(dir, `${item.id}.json`));
	},
};
