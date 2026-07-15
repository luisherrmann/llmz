// Resolves a grounded citation search phrase (see citation.js's
// groundCitations) directly to a page position -- { pageIndex, rects } --
// using the SDT structure's own per-character position data (textMap)
// rather than the reader's live find() (which has its own, separately-
// implemented text-assembly quirks). This lets a citation click go straight
// to a precise, possibly multi-line (non-rectangular) highlight the same
// way a table/figure click does (see citation.js's navigateToPosition),
// instead of a text-search round trip through the reader.
//
// Three DIFFERENT caches are involved:
//  - structure cache (one JSON blob per item on DISK, holding the full SDT
//    structure with every textMap): the ML-based layout classification
//    that produces it -- the same cost extract_references.js/
//    extract_equations.js/extract_tables_sdt.js/extract_figures_sdt.js each
//    already pay independently for their own concern -- is the genuinely
//    expensive, unavoidable part. scripts/compute_document_structure.js
//    computes this ONCE per item and writes it here; nothing else touches
//    the PDF file itself.
//  - structure MEMORY cache (_structureCache, item.id -> parsed structure):
//    resolving a query against an already-cached structure is cheap text/
//    position matching, done directly in THIS file's own JS (ported from
//    structured-document-text's decode.js) rather than by spawning a fresh
//    Node subprocess per request -- a subprocess still has to re-read and
//    re-JSON.parse the (potentially multi-MB) structure file from disk on
//    every invocation even when nothing has changed, which is real,
//    avoidable overhead paid on every chat reply that cites the same PDF,
//    not just the first ever. Keeping the parsed structure (and, below,
//    the text index built from it) in memory for the lifetime of this
//    Zotero session means that cost is paid at most ONCE per item, ever,
//    not once per request.
//  - text index MEMORY cache (_textIndexCache, item.id -> {fullText,
//    offsetMap, normalized, posMap}): built from the structure (see
//    _buildTextIndex) -- also reused across calls rather than rebuilt from
//    the same structure every time.
//  - position cache (DISK + memory, query -> {pageIndex, rects} per item):
//    a multi-citation reply means the same citation link can be clicked
//    more than once, or the user can return to an old reply later -- this
//    avoids even the (now cheap, in-process) matching work for a query
//    already resolved once.
//
// Deployment (unpacking sdt/ for a packed .xpi install) is owned entirely
// by LLMReferences -- see document/equations.js's own comment for why this
// reuses LLMReferences._extensionRoot/_nodePath()/_pdfjsSetupPath() rather
// than deploying a second copy of sdt/.
LLMCitationPosition = {
	_scriptName: "compute_document_structure.js",
	_cacheVersion: 1, // bump when the cached position schema changes (JS-side, not just the script/model)
	_positionCache: new Map(), // item.id -> Map(normalizedQuery -> position)
	_structureCache: new Map(), // item.id -> parsed SDT structure
	_textIndexCache: new Map(), // item.id -> { fullText, offsetMap, normalized, posMap }

	log(msg) {
		Zotero.debug("LLM Chat Pane [CitationPosition]: " + msg);
	},

	// ---- Structure computation (the one step that still needs Node) ----

	_scriptPath() {
		return PathUtils.join(LLMReferences._extensionRoot, "scripts", this._scriptName);
	},

	async _structureCacheDir() {
		let dir = PathUtils.join(Zotero.DataDirectory.dir, "LLMz", "cache", "citation-structure");
		await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
		return dir;
	},

	async _structureCachePath(item) {
		return PathUtils.join(await this._structureCacheDir(), `${item.id}.json`);
	},

	// Returns the parsed SDT structure for `item`, from (in priority order)
	// memory, disk, or a fresh Node computation -- each successive step
	// only runs if the previous one missed. Memory-cached for the rest of
	// this Zotero session once loaded/computed.
	async _getStructure(item) {
		if (this._structureCache.has(item.id)) {
			return this._structureCache.get(item.id);
		}

		let structureCachePath = await this._structureCachePath(item);
		if (!await IOUtils.exists(structureCachePath)) {
			let pdfPath = item.getFilePath();
			if (!pdfPath) return null;
			await LLMReferences._runNode(this._scriptPath(), this._scriptName, pdfPath, structureCachePath);
		}

		let structure = JSON.parse(await IOUtils.readUTF8(structureCachePath));
		this._structureCache.set(item.id, structure);
		return structure;
	},

	// ---- Position cache (query -> {pageIndex, rects}) ----

	async _positionCacheDir() {
		let dir = PathUtils.join(Zotero.DataDirectory.dir, "LLMz", "cache", "citation-position");
		await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
		return dir;
	},

	// Normalized purely so trivial whitespace/casing differences in how a
	// query happens to be re-quoted don't cause an avoidable cache miss --
	// NOT a substitute for _normalizeForMatch's joints-stripping match logic.
	_normalizeQueryKey(query) {
		return query.trim().replace(/\s+/g, " ").toLowerCase();
	},

	async _loadPositionCache(item) {
		if (this._positionCache.has(item.id)) {
			return this._positionCache.get(item.id);
		}
		let map = new Map();
		try {
			let path = PathUtils.join(await this._positionCacheDir(), `${item.id}.json`);
			if (await IOUtils.exists(path)) {
				let stored = JSON.parse(await IOUtils.readUTF8(path));
				if (stored.cacheVersion === this._cacheVersion) {
					for (let [key, position] of Object.entries(stored.positions)) {
						map.set(key, position);
					}
				}
			}
		}
		catch (e) {
			this.log(`_loadPositionCache: failed for item ${item.id}: ${e.message}`);
		}
		this._positionCache.set(item.id, map);
		return map;
	},

	async _savePositionCache(item, map) {
		try {
			let path = PathUtils.join(await this._positionCacheDir(), `${item.id}.json`);
			await IOUtils.writeUTF8(path, JSON.stringify({
				cacheVersion: this._cacheVersion,
				positions: Object.fromEntries(map),
			}, null, 2));
		}
		catch (e) {
			this.log(`_savePositionCache: failed for item ${item.id}: ${e.message}`);
		}
	},

	// ---- Ported from structured-document-text's src/pdf/decode.js -- pure,
	// dependency-free functions, safe to duplicate here as plain (non-ES-
	// module) JS rather than pulling in a module loader just for these. If
	// decode.js's own algorithm ever changes, this needs updating too. ----

	_parseTextMap(textMap) {
		if (typeof textMap !== "string") return [];
		try {
			let parsed = JSON.parse(textMap);
			return Array.isArray(parsed) ? parsed : [];
		}
		catch (e) {
			return [];
		}
	},

	_reconstructCharPositions(run) {
		if (!run || run.length < 6) return [];
		let header = run[0];
		let pageIndex = run[1];
		let minX = run[2], minY = run[3], maxX = run[4], maxY = run[5];
		let widths = run.slice(6);
		// HEADER_AXIS_DIR_SHIFT = 1, per structured-document-text's constants.js
		let axisDir = (header >> 1) & 0b11;
		let vertical = axisDir === 1 || axisDir === 3; // isVertical, per constants.js
		let start = vertical ? minY : minX;
		let end = vertical ? maxY : maxX;

		if (widths.length === 0) {
			return [{ x1: start, x2: end }];
		}

		let positions = [];
		let pos = start;
		for (let w of widths) {
			if (Array.isArray(w)) {
				let [delta, width] = w;
				pos += delta;
				positions.push({ x1: pos, x2: pos + width });
				pos += width;
			}
			else {
				positions.push({ x1: pos, x2: pos + w });
				pos += w;
			}
		}
		return positions;
	},

	_buildRunData(runs) {
		let data = [];
		for (let run of runs) {
			if (!Array.isArray(run) || run.length < 6) continue;
			let header = run[0], pageIndex = run[1];
			let minX = run[2], minY = run[3], maxX = run[4], maxY = run[5];
			let axisDir = (header >> 1) & 0b11; // HEADER_AXIS_DIR_SHIFT = 1
			let vertical = axisDir === 1 || axisDir === 3;
			let positions = this._reconstructCharPositions(run);
			// HEADER_LAST_IS_SOFT_HYPHEN = 1 << 0, per constants.js
			if (header & 1) positions.pop();
			for (let pos of positions) {
				if (!pos || !Number.isFinite(pos.x1) || !Number.isFinite(pos.x2)) continue;
				let rect = vertical
					? [minX, pos.x1, maxX, pos.x2]
					: [pos.x1, minY, pos.x2, maxY];
				data.push({ rect, pageIndex, vertical });
			}
		}
		return data;
	},

	// ---- Ported from scripts/compute_document_structure.js's former
	// resolution logic (see git history) -- matching/rect-computation, now
	// run in-process instead of via a spawned Node subprocess. ----

	// Same character class as citation.js's own dash-stripping
	// normalization (see its groundCitations-era comments if still
	// present) -- whitespace + all dash variants, since a hyphen dropped at
	// a line-wrap becomes a bare joint between two words in the extracted
	// text, same as everywhere else in this pipeline.
	_matchJointsRegex: /[\s\x2D֊־᐀᠆‐-―⸗⸚⸺⸻〜〰゠︱︲﹘﹣－]/,

	_normalizeForMatch(str) {
		let re = new RegExp(this._matchJointsRegex.source, "g");
		return str.toLowerCase().replace(re, "");
	},

	// Walks all leaf text nodes in document order, building:
	//  - fullText: concatenation of every leaf node's raw .text
	//  - offsetMap: parallel array, offsetMap[i] = { node, localOffset } (or
	//    null for inserted inter-block separator chars that don't belong to
	//    any node)
	_buildFullTextWithOffsetMap(structure) {
		let fullText = "";
		let offsetMap = [];

		let appendSeparator = () => {
			if (fullText && !/\s$/.test(fullText)) {
				fullText += " ";
				offsetMap.push(null);
			}
		};

		let walk = (node) => {
			if (typeof node.text === "string") {
				for (let j = 0; j < node.text.length; j++) {
					offsetMap.push({ node, localOffset: j });
				}
				fullText += node.text;
				return;
			}
			if (Array.isArray(node.content)) {
				for (let child of node.content) walk(child);
			}
		};

		for (let block of structure.content) {
			appendSeparator();
			walk(block);
		}

		return { fullText, offsetMap };
	},

	_buildNormalizedIndex(text) {
		let normalized = [];
		let posMap = [];
		for (let i = 0; i < text.length; i++) {
			let ch = text[i];
			if (this._matchJointsRegex.test(ch)) continue;
			normalized.push(ch.toLowerCase());
			posMap.push(i);
		}
		return { normalized: normalized.join(""), posMap };
	},

	// buildRunData's output has ONE entry per GLYPH, but node.text also
	// contains synthetic separator characters (spaces inserted for word/
	// line breaks) that were never drawn and so have no position entry at
	// all. Confirmed empirically against a real document: node.text.length
	// - charData.length === the literal space count in node.text, exactly.
	// So charData[i] does NOT correspond to node.text[i] in general --
	// build the correct node.text-index -> charData-index mapping by
	// walking node.text and only advancing the charData cursor on non-
	// space characters.
	_buildNodeCharDataMap(node) {
		let runs = this._parseTextMap(node.anchor?.textMap);
		let charData = this._buildRunData(runs);
		let map = new Array(node.text.length).fill(null);
		let ci = 0;
		for (let i = 0; i < node.text.length; i++) {
			if (node.text[i] === " ") continue;
			map[i] = charData[ci++];
		}
		return map;
	},

	// Given a node and a LOCAL character range [start, end), decode its
	// textMap and slice out just the rects for that range, then group
	// consecutive same-page/same-line rects into per-line bounding rects --
	// a span crossing a line (or column) wrap naturally produces more than
	// one rect, the same "staircase" shape a normal PDF text highlight has.
	_getRectsForNodeRange(node, localStart, localEnd) {
		let charMap = this._buildNodeCharDataMap(node);
		let slice = charMap.slice(localStart, localEnd).filter(Boolean);
		if (!slice.length) return [];

		let rects = [];
		let current = null;
		for (let c of slice) {
			if (!c || !c.rect) continue;
			let [x1, y1, x2, y2] = c.rect;
			if (current && current.pageIndex === c.pageIndex && Math.abs(current.y1 - Math.min(y1, y2)) < 2) {
				current.x1 = Math.min(current.x1, x1, x2);
				current.x2 = Math.max(current.x2, x1, x2);
				current.y1 = Math.min(current.y1, y1, y2);
				current.y2 = Math.max(current.y2, y1, y2);
			}
			else {
				if (current) rects.push(current);
				current = { pageIndex: c.pageIndex, x1: Math.min(x1, x2), x2: Math.max(x1, x2), y1: Math.min(y1, y2), y2: Math.max(y1, y2) };
			}
		}
		if (current) rects.push(current);
		return rects;
	},

	// Building fullText/offsetMap/the normalized index is O(document size)
	// -- cheap once, wasteful to redo per query OR per request. Cached in
	// _textIndexCache, keyed off the SAME structure object identity check
	// implied by _structureCache already being item-keyed.
	_buildTextIndex(structure) {
		let { fullText, offsetMap } = this._buildFullTextWithOffsetMap(structure);
		let { normalized, posMap } = this._buildNormalizedIndex(fullText);
		return { fullText, offsetMap, normalized, posMap };
	},

	async _getTextIndex(item) {
		if (this._textIndexCache.has(item.id)) {
			return this._textIndexCache.get(item.id);
		}
		let structure = await this._getStructure(item);
		if (!structure) return null;
		let textIndex = this._buildTextIndex(structure);
		this._textIndexCache.set(item.id, textIndex);
		return textIndex;
	},

	// Conservative per-query edit budget for fuzzy first-tier matching.
	// Intentionally small ("few characters") to avoid anchoring a citation
	// to the wrong sentence when the text is repetitive.
	_fuzzyMaxEdits(queryLength) {
		if (queryLength < 40) return 1;
		if (queryLength < 120) return 2;
		if (queryLength < 260) return 3;
		return 4;
	},

	// Bounded Levenshtein with early stop. Returns maxEdits + 1 when the
	// distance exceeds the budget.
	_boundedLevenshtein(a, b, maxEdits) {
		let n = a.length;
		let m = b.length;
		if (Math.abs(n - m) > maxEdits) return maxEdits + 1;

		let prev = new Array(m + 1);
		let curr = new Array(m + 1);
		for (let j = 0; j <= m; j++) prev[j] = j;

		for (let i = 1; i <= n; i++) {
			curr[0] = i;
			let rowMin = curr[0];
			for (let j = 1; j <= m; j++) {
				let cost = a[i - 1] === b[j - 1] ? 0 : 1;
				let del = prev[j] + 1;
				let ins = curr[j - 1] + 1;
				let sub = prev[j - 1] + cost;
				let v = Math.min(del, ins, sub);
				curr[j] = v;
				if (v < rowMin) rowMin = v;
			}
			if (rowMin > maxEdits) return maxEdits + 1;
			let tmp = prev;
			prev = curr;
			curr = tmp;
		}

		return prev[m];
	},

	// Seeded candidate search for near-exact matches. Uses exact seed hits to
	// avoid scanning the whole document with edit distance.
	_resolveQueryAgainstTextIndexFuzzy(textIndex, normQuery) {
		let { offsetMap, normalized, posMap } = textIndex;
		let qLen = normQuery.length;
		if (!qLen) return null;

		let maxEdits = this._fuzzyMaxEdits(qLen);
		if (maxEdits <= 0 || normalized.length < qLen - maxEdits) return null;

		let seedLen = Math.max(4, Math.min(12, Math.floor(qLen / 4)));
		if (qLen < seedLen) return null;

		let seedPos = [
			0,
			Math.max(0, Math.floor((qLen - seedLen) / 2)),
			Math.max(0, qLen - seedLen),
		];
		let seenSeedPos = new Set();
		seedPos = seedPos.filter((p) => {
			if (seenSeedPos.has(p)) return false;
			seenSeedPos.add(p);
			return true;
		});

		let candidateStarts = new Set();
		for (let p of seedPos) {
			let seed = normQuery.slice(p, p + seedLen);
			let from = 0;
			while (true) {
				let hit = normalized.indexOf(seed, from);
				if (hit === -1) break;
				let start = hit - p;
				if (start >= 0 && start < normalized.length) {
					candidateStarts.add(start);
				}
				from = hit + 1;
			}
		}

		if (!candidateStarts.size) return null;

		let best = null;
		let secondBestDist = Infinity;
		for (let start of candidateStarts) {
			for (let len = Math.max(1, qLen - maxEdits); len <= qLen + maxEdits; len++) {
				if (start + len > normalized.length) break;
				let cand = normalized.slice(start, start + len);
				let dist = this._boundedLevenshtein(normQuery, cand, maxEdits);
				if (dist > maxEdits) continue;
				if (!best || dist < best.dist || (dist === best.dist && Math.abs(len - qLen) < Math.abs(best.len - qLen))) {
					if (best) {
						secondBestDist = Math.min(secondBestDist, best.dist);
					}
					best = { start, len, dist };
				}
				else {
					secondBestDist = Math.min(secondBestDist, dist);
				}
			}
		}

		if (!best) return null;
		// Reject ambiguous best hits.
		if (secondBestDist - best.dist < 1) return null;

		let matchStart = posMap[best.start];
		let matchEnd = posMap[best.start + best.len - 1] + 1;

		let nodeRanges = new Map();
		for (let i = matchStart; i < matchEnd; i++) {
			let entry = offsetMap[i];
			if (!entry) continue;
			let r = nodeRanges.get(entry.node);
			if (!r) {
				nodeRanges.set(entry.node, { min: entry.localOffset, max: entry.localOffset + 1 });
			}
			else {
				r.min = Math.min(r.min, entry.localOffset);
				r.max = Math.max(r.max, entry.localOffset + 1);
			}
		}

		let allRects = [];
		for (let [node, range] of nodeRanges) {
			allRects.push(...this._getRectsForNodeRange(node, range.min, range.max));
		}
		if (!allRects.length) return null;

		allRects.sort((a, b) => a.pageIndex - b.pageIndex || b.y1 - a.y1);
		let pageIndex = allRects[0].pageIndex;
		let rects = allRects.filter(r => r.pageIndex === pageIndex).map(r => [r.x1, r.y1, r.x2, r.y2]);
		return { pageIndex, rects };
	},

	_resolveQueryAgainstTextIndex(textIndex, query) {
		let { offsetMap, normalized, posMap } = textIndex;
		let normQuery = this._normalizeForMatch(query);
		if (!normQuery) return null;

		let idx = normalized.indexOf(normQuery);
		if (idx === -1) {
			return this._resolveQueryAgainstTextIndexFuzzy(textIndex, normQuery);
		}

		let matchStart = posMap[idx];
		let matchEnd = posMap[idx + normQuery.length - 1] + 1;

		let nodeRanges = new Map();
		for (let i = matchStart; i < matchEnd; i++) {
			let entry = offsetMap[i];
			if (!entry) continue;
			let r = nodeRanges.get(entry.node);
			if (!r) {
				nodeRanges.set(entry.node, { min: entry.localOffset, max: entry.localOffset + 1 });
			}
			else {
				r.min = Math.min(r.min, entry.localOffset);
				r.max = Math.max(r.max, entry.localOffset + 1);
			}
		}

		let allRects = [];
		for (let [node, range] of nodeRanges) {
			allRects.push(...this._getRectsForNodeRange(node, range.min, range.max));
		}
		if (!allRects.length) return null;

		allRects.sort((a, b) => a.pageIndex - b.pageIndex || b.y1 - a.y1);
		let pageIndex = allRects[0].pageIndex;
		let rects = allRects.filter(r => r.pageIndex === pageIndex).map(r => [r.x1, r.y1, r.x2, r.y2]);
		return { pageIndex, rects };
	},

	// ---- Public API ----

	// Resolves MANY queries against ONE shared (memory-cached, see
	// _getTextIndex) text index -- a chat reply commonly has several
	// citations against the same PDF (see llm/request.js's own prefetch call,
	// right after grounding). Returns a Map of query -> ({ pageIndex,
	// rects } or null), one entry per requested query, in the SAME order/
	// duplication as the input array.
	async resolvePositions(item, queries, onEmbeddingStart, onMessage) {
		let cache = await this._loadPositionCache(item);
		let results = new Map();
		let toResolve = []; // [{ query, key }], only queries not already cached

		for (let query of queries) {
			if (!query?.trim()) {
				results.set(query, null);
				continue;
			}
			let key = this._normalizeQueryKey(query);
			if (cache.has(key)) {
				results.set(query, cache.get(key));
			}
			else if (!toResolve.some(q => q.key === key)) {
				toResolve.push({ query, key });
			}
		}

		if (!toResolve.length) {
			this.log(`resolvePositions: all ${queries.length} quer${queries.length === 1 ? "y" : "ies"} already cached for item ${item.id}`);
			for (let query of queries) {
				if (!results.has(query)) results.set(query, cache.get(this._normalizeQueryKey(query)) ?? null);
			}
			return results;
		}

		let textIndex = null;
		try {
			textIndex = await this._getTextIndex(item);
		}
		catch (e) {
			this.log(`resolvePositions: failed to get text index for item ${item.id}: ${e.message}`);
		}

		let unresolved = []; // [{ query, key }] -- exact match found nothing
		for (let { query, key } of toResolve) {
			let position = null;
			if (textIndex) {
				try {
					position = this._resolveQueryAgainstTextIndex(textIndex, query);
				}
				catch (e) {
					this.log(`resolvePositions: failed to resolve "${query}" for item ${item.id}: ${e.message}`);
				}
			}
			if (position) {
				cache.set(key, position);
				results.set(query, position);
			}
			else {
				unresolved.push({ query, key });
			}
		}

		// Fallback for citations the exact matcher couldn't anchor at all --
		// a genuine paraphrase (reordered words, synonyms, a condensed
		// summary of a longer passage) has no literal match to find no
		// matter how the text is normalized, but IS close in embedding
		// space to the real sentence it's paraphrasing. The model is
		// instructed to quote exactly one full sentence verbatim (see
		// llm/prompt.js's citation format instructions) specifically to
		// keep this fallback rare, not to eliminate the need for it -- a
		// full sentence is easier for the model to reproduce verbatim than
		// an arbitrary short fragment would be (it's a complete, coherent
		// unit rather than a cut wherever felt "long enough"), and it means
		// this fallback compares LIKE with LIKE: getCitationIndex's own
		// embedding index is ALSO built from whole sentences (see
		// splitIntoSentences), so a full-sentence query lands in the same
		// length/context regime as what it's being compared against,
		// rather than a short-phrase query being matched against much
		// longer sentence embeddings. Embeddings (semantic similarity), not
		// fuzzy/edit-distance string matching, because the gap here is
		// MEANING (reordered/reworded text), not surface noise -- edit
		// distance would score a genuine paraphrase poorly for the same
		// reason it's not literally present via exact match; that class of
		// surface-level noise (extraction artifacts: dropped hyphens,
		// whitespace, case) is already handled by the exact matcher's own
		// normalization above, so a fuzzy-string tier here would mostly
		// duplicate that rather than add real coverage.
		if (unresolved.length && textIndex) {
			try {
				let text = await LLMPrompt.getAttachmentFullText(item);
				if (text?.trim()) {
					let citationIndex = await LLMCitation.getCitationIndex(item, text, onEmbeddingStart, onMessage);
					if (citationIndex?.sentences?.length) {
						// Batched (not one getEmbedding call per citation,
						// sequentially) -- see groundCitations' own comment
						// in citation.js for why that mattered enough
						// to fix here even though this path is already the
						// rare case.
						let queryEmbeddings = await LLMCitation.embedBatched(
							unresolved.map(u => u.query),
							citationIndex.model,
							citationIndex.provider
						);
						// One DB round trip for every unresolved citation's
						// nearest-sentence lookup (see getNearestSentences'
						// own comment) -- ranking runs via sqlite-vec MATCH,
						// same as getRelevantChunks, rather than the JS-side
						// cosineSimilarity scan over every sentence this
						// replaced.
						let bestSentences = await LLMCitation.getNearestSentences(citationIndex, queryEmbeddings);
						for (let i = 0; i < unresolved.length; i++) {
							let { query, key } = unresolved[i];
							let bestSentence = bestSentences[i];
							if (!bestSentence) continue;
							// The matched sentence is real text extracted
							// from this same document, so re-anchoring IT
							// (rather than the model's own possibly-
							// paraphrased wording) through the exact
							// matcher succeeds where the original query
							// didn't -- ending up with a real position, not
							// just a plausible-sounding sentence with
							// nowhere to navigate to.
							let position = null;
							try {
								position = this._resolveQueryAgainstTextIndex(textIndex, bestSentence);
							}
							catch (e) {
								this.log(`resolvePositions: failed to re-anchor embedding match for "${query}": ${e.message}`);
							}
							if (position) {
								cache.set(key, position);
								results.set(query, position);
							}
						}
					}
				}
			}
			catch (e) {
				this.log(`resolvePositions: embedding fallback failed for item ${item.id}: ${e.message}`);
			}
		}

		for (let { query, key } of unresolved) {
			if (!results.has(query)) {
				cache.set(key, null);
				results.set(query, null);
			}
		}

		await this._savePositionCache(item, cache);
		return results;
	},

	// Thin single-query convenience wrapper over resolvePositions -- used by
	// the click handler as a fallback for a query that (for whatever reason)
	// wasn't part of the prefetched batch for its response (see llm/request.js).
	// Returns { pageIndex, rects } on success, or null if the query
	// couldn't be resolved (caller should fall back to text-search
	// navigation -- see citation.js's navigateToText).
	async resolvePosition(item, query) {
		let results = await this.resolvePositions(item, [query]);
		return results.get(query) ?? null;
	},

	// Debug affordance ("Clear Cache" button) -- drops the structure cache
	// (disk AND memory, forcing the next resolvePosition call to re-run the
	// full ML classification), the text index memory cache, and the
	// resolved-position cache (disk AND memory) for this item.
	async clearCache(item) {
		this._positionCache.delete(item.id);
		this._structureCache.delete(item.id);
		this._textIndexCache.delete(item.id);
		try {
			await IOUtils.remove(await this._structureCachePath(item), { ignoreAbsent: true });
			let path = PathUtils.join(await this._positionCacheDir(), `${item.id}.json`);
			await IOUtils.remove(path, { ignoreAbsent: true });
			this.log(`clearCache: cleared for item ${item.id}`);
		}
		catch (e) {
			this.log(`clearCache: failed: ${e.message}`);
		}
	},
};
