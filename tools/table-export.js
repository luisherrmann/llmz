// Resolves a table (or several) from the paper currently open in the reader
// -- by id, description, list, range, "all", or a criterion, same six-shape
// intent as tools/reference-retrieval.js/tools/reference-linker.js -- and
// exports them as CSV files bundled into a single zip archive on disk.
// Sibling to those two modules, following the exact same selection/
// resolution pattern (see intentTool/resolveExplicitIndices/
// resolveTableByDescription/resolveTableSelection below, each a close
// mirror of the reference-retrieval.js equivalent), keyed off a table's own
// `table_id` -- a plain sequential integer assigned to EVERY table
// regardless of whether it has a real printed number (an SDT-detected
// appendix-lettered or uncaptioned table has no real `table_num` at all,
// see document/tables.js/scripts/extract-tables-sdt.js).
//
// UNLIKE a reference's own `index` (which the user reads directly off the
// bibliography and can name outright, e.g. "download reference 5" -> just
// extract the digit, no lookup needed), a table's `table_id` is an internal
// identifier the user has never seen -- LLMIntent.detectIntent (see
// llm/intent.js) classifies the tool call from the raw prompt text ALONE, with
// no access to this paper's actual table list, so a user naming a table by
// its own printed label ("D.2", "D1") can only ever be captured as a STRING
// at that stage; resolving which table_id it actually refers to needs a
// SECOND call that's shown the real (id, label, caption) listing -- see
// "single"/"list" below, both routed through resolveTableByDescription
// (already exactly this: given a listing and a description/term, ask the
// model which table_id it means) rather than trusted as a literal id.
// "range"/"all" don't have this problem (a range of ids, or "every table",
// needs no string-to-id resolution at all) and stay pure table_id
// arithmetic, no extra model call.
//
// What happens with the resolved ids, regardless of how they got resolved:
// this module pulls each table's (id, label, caption, content, and -- if
// every requested table has one and the current model supports image
// input -- its own cropped rendering) from document/tables.js's
// LLMTables.getTableIndex, hands them to the model in ONE prompt per batch
// of up to _BATCH_SIZE tables (not one call per table, unlike download/
// link's per-reference pipeline -- see exportTablesToZip/
// _formatTablesBatch), asking it to format each as a proper CSV table
// (using the rendered image as ground truth over the programmatically-
// extracted content, when attached), then splits each batch's response on
// a "[NEXT_TABLE]" separator, writes one file per table, and zips them all
// together.
LLMTableExport = {
	log(msg) {
		Zotero.debug("LLM Chat Pane [Table Export]: " + msg);
	},

	// `images`, if given, is passed straight through to streamModel -- an
	// array of { label, dataUri } entries (see _formatTablesBatch, the only
	// caller that ever passes any), attached to this same one-off prompt
	// (see _buildCSVPrompt/exportTablesToZip) with each image's own label
	// interleaved right before it (see llm/interfaces.js's
	// streamOpenAICompatible/streamAnthropic) so the model has an explicit
	// anchor for "which image is which table" instead of a purely
	// positional guess across however many tables got batched together.
	async _callModel(prompt, images) {
		let result = await LLMInterfaces.streamModel(prompt, () => {}, {}, images);
		return (result.text || "").trim();
	},

	// Native-tool-calling descriptor for this tool (see llm/intent.js's
	// detectIntent/_registry) -- same shape/rationale as
	// LLMReferenceRetrieval.intentTool, see its own comment, including
	// `resolver` bundling the four functions llm/request.js's
	// _resolveIntentIndices needs.
	intentTool: {
		name: "export_tables",
		description: [
			"Exports one or more tables from the paper currently open in the reader as",
			"CSV files bundled into a single zip archive, saved to disk. Use this when",
			"the user asks to export, save, extract, or download tables AS CSV/a zip",
			"file -- NOT for downloading or linking a bibliography reference (separate",
			"tools exist for those), and not for anything else about the PDF's content.",
			"Do NOT use if the user asks to format, print, show, or display the tables",
			"as a CSV."
		].join(" "),
		schema: {
			type: "object",
			properties: {
				type: {
					type: "string",
					enum: ["single", "describe", "list", "range", "all", "select"],
					description: [
						"single: one table, named explicitly by the user's own wording -- a",
						"number, letter, or label like '3' or 'D.1' (set index). describe: one",
						"table identified by its caption/topic instead of a name (set",
						"description). list: an enumerated set of specific tables, each named",
						"explicitly the same way as 'single' (set indices). range: a numeric",
						"range of table ids (set from/to). all: every table in the paper (no",
						"other fields needed). select: a criterion other than an explicit",
						"name/range/list, e.g. \"every table about latency\" or \"every table on",
						"pages 7 and 11\" (set description) -- also use this for a request naming",
						"PDF page numbers rather than table ids/labels, since a page number is",
						"not itself a valid 'index'/'indices' value.",
					].join(" "),
				},
				index: { type: "string", description: "Required when type is 'single' -- the table exactly as the user named it (e.g. '3', 'D.1', 'D2') -- copy their own wording, do not invent or guess a different form of it." },
				description: { type: "string", description: "Required when type is 'describe' or 'select' -- the identifying text or selection criterion, in the user's own words." },
				indices: { type: "array", items: { type: "string" }, description: "Required when type is 'list' -- the explicit table names, same format as 'index' above, one per table." },
				from: { type: "integer", description: "Required when type is 'range' -- the start table id." },
				to: { type: "integer", description: "Required when type is 'range' -- the end table id." },
			},
			required: ["type"],
		},
		resolver: {
			getIndex: pdfItem => LLMTables.getTableIndex(pdfItem, undefined),
			// "single"/"list" both route through resolveTableByDescription
			// (the SAME table-listing-aware lookup "describe" already uses)
			// rather than trusting intent.index/indices as literal ids --
			// see this module's own header comment for why: the model never
			// saw this paper's actual table list at intent-detection time,
			// so a name like "D.2" can only be resolved against it in a
			// second call, not assumed to already be — or even
			// correctly convertible to — a table_id.
			single: (intent, index, pageNum) => LLMTableExport.resolveTableByDescription(index, intent.index, pageNum),
			list: (intent, index, pageNum) => LLMTableExport.resolveTableTerms(intent.indices, index, pageNum),
			explicit: (intent, index) => LLMTableExport.resolveExplicitIndices(intent, index),
			byDescription: (index, description, pageNum) => LLMTableExport.resolveTableByDescription(index, description, pageNum),
			selection: (index, description, pageNum) => LLMTableExport.resolveTableSelection(index, description, pageNum),
		},
	},

	// Handles "range"/"all" only -- "list" is resolved elsewhere (see
	// resolver.list/resolveTableTerms) since its entries are user-named
	// strings ("D.2"), not literal table_ids, unlike a reference's own
	// `indices` (always plain numbers -- see
	// LLMReferenceRetrieval.resolveExplicitIndices, which this otherwise
	// mirrors). "range"/"all" don't have that problem (a range/all of ids
	// needs no string-to-id resolution), and since table_id is assigned to
	// EVERY table uniformly (not just plainly-numbered ones), they now
	// naturally cover lettered/synthetic-labeled tables too, unlike the old
	// table_num-keyed version this replaced.
	resolveExplicitIndices(intent, tableIndex) {
		let valid = new Set((tableIndex?.tables || []).map(t => t.table_id));
		if (intent.type === "range") {
			let from = Math.min(intent.from, intent.to);
			let to = Math.max(intent.from, intent.to);
			let result = [];
			for (let i = from; i <= to; i++) {
				if (valid.has(i)) result.push(i);
			}
			return result;
		}
		if (intent.type === "all") {
			return [...valid].sort((a, b) => a - b);
		}
		return null;
	},

	// Same "give the LLM the short (id, label, caption) listing and let it
	// match loosely" approach as
	// LLMReferenceRetrieval.resolveReferenceByDescription -- a table's
	// caption is a much shorter, more reliable matching signal than its
	// full cell content, same reasoning as citation titles vs full
	// citations there. Asks for the table_id, not the label -- the model
	// never has to reproduce a label string at all, just copy the small
	// integer already shown next to the table it picked.
	//
	// `pageNum`, if given, adds the same "user is currently viewing page N"
	// reader-context line llm/prompt.js's selectXWithLLM family already
	// shows (reused directly via LLMPrompt._buildReaderContextLines, rather
	// than duplicating that phrasing here), and each table's own page
	// number is shown alongside its listing entry -- together these let a
	// page-scoped request ("export the table on this page") resolve
	// correctly instead of having nothing to match against.
	async resolveTableByDescription(tableIndex, description, pageNum) {
		let tables = tableIndex?.tables || [];
		if (!tables.length) return null;
		let listing = tables.map(t => `[${t.table_id}] (p.${t.page_num}) ${t.label}: ${t.caption}`).join("\n");
		let prompt = [
			"Below is a list of tables from a paper, by id, page number, label, and",
			"caption.",
			...LLMPrompt._buildReaderContextLines({ pageNum }),
			"Identify which table (if any) matches the following description of a",
			'table the user wants to export. Respond with ONLY the table id number.',
			'If no entry is a confident match, respond with exactly "none". Do not',
			"explain.",
			"",
			`Description: "${description}"`,
			"",
			"Tables:",
			listing,
		].join("\n");
		let text = await this._callModel(prompt);
		if (!text || /none/i.test(text)) return null;
		let match = text.match(/\d+/);
		return match ? parseInt(match[0], 10) : null;
	},

	// Resolves several EXPLICITLY-named terms (see intentTool's "list" type
	// -- e.g. ["D1", "D.2"] for "export tables D1 and D.2") to their own
	// table_id each, one resolveTableByDescription call per term, run in
	// PARALLEL (each is an independent lookup against the same fixed
	// listing, not a multi-step conversation, so there's no ordering
	// dependency to serialize on). Deduplicates and sorts the results --
	// terms that don't resolve to anything are just dropped, same
	// "whatever matched" tolerance resolveExplicitIndices' own "list" case
	// already has for invalid entries.
	async resolveTableTerms(terms, tableIndex, pageNum) {
		let resolved = await Promise.all(terms.map(term => this.resolveTableByDescription(tableIndex, String(term), pageNum)));
		let seen = new Set();
		let result = [];
		for (let id of resolved) {
			if (id !== null && !seen.has(id)) {
				seen.add(id);
				result.push(id);
			}
		}
		return result.sort((a, b) => a - b);
	},

	// Same cap/rationale as LLMReferenceRetrieval._MAX_SELECTION_RESULTS --
	// an overly broad criterion (or the model being overzealous) could
	// otherwise match most of a long table list, turning one export
	// request into a huge CSV-formatting prompt.
	_MAX_SELECTION_RESULTS: 10,

	// Same comma-separated-ids response format LLMReferenceRetrieval.
	// resolveReferenceSelection already uses -- safe again now that the
	// model is answering with table_id (a plain integer) rather than a
	// label string, which could itself contain a comma for a synthetic
	// section-derived label (e.g. "Appendix B. FSQ codebook, Unlabelled
	// Table 1") and would fragment a comma-separated response. `pageNum`
	// -- see resolveTableByDescription's own comment.
	async resolveTableSelection(tableIndex, description, pageNum) {
		let tables = tableIndex?.tables || [];
		if (!tables.length) return [];
		let listing = tables.map(t => `[${t.table_id}] (p.${t.page_num}) ${t.label}: ${t.caption}`).join("\n");
		let prompt = [
			"Below is a list of tables from a paper, by id, page number, label, and",
			"caption.",
			...LLMPrompt._buildReaderContextLines({ pageNum }),
			"Identify every table that matches the following selection criterion, up to a",
			`maximum of ${this._MAX_SELECTION_RESULTS} entries (if more than`,
			`${this._MAX_SELECTION_RESULTS} match, pick the best/most confident`,
			'matches). Respond with ONLY a comma-separated list of table ids (e.g.',
			'"3, 7, 12"). If nothing matches, respond with exactly "none". Do not',
			"explain.",
			"",
			`Criterion: "${description}"`,
			"",
			"Tables:",
			listing,
		].join("\n");
		let text = await this._callModel(prompt);
		if (!text || /^none$/i.test(text.trim())) return [];
		let ids = [...new Set((text.match(/\d+/g) || []).map(n => parseInt(n, 10)))];
		return ids.slice(0, this._MAX_SELECTION_RESULTS);
	},

	// Builds the single combined prompt asking the model to turn every
	// requested table's raw extracted content into a proper CSV -- listed
	// as (number, caption) tuples followed by that table's own flattened
	// content (LLMTables._flattenTableData's output, already computed as
	// `contentText` by getTableIndex), in the SAME order `tables` is given
	// in, since the response is split back apart purely by position (see
	// exportTablesToZip) -- there's no per-table tagging in the requested
	// output, just the [NEXT_TABLE] separator and matching order.
	// `withImages` switches which instruction paragraph is used (see below)
	// -- see exportTablesToZip, which actually attaches tab.image_data (the
	// bounding-box crop, rendered lazily on demand via
	// LLMTables.renderMissingImages against SDT's own detected bbox -- see
	// document/tables.js) as `images` on this same streamModel call.
	_buildCSVPrompt(tables, withImages) {
		let tuples = tables.map((t, i) =>
			`${i + 1}. (label=${t.label}, caption="${t.caption}")\n${t.contentText}`
		).join("\n\n");
		let lines = [
			"Below are tables extracted from a scientific paper, given as (label,",
			"caption) tuples followed by that table's own raw content, listed in",
			"sequential order. For EACH table, produce a single, well-formed CSV",
			"representation of its data.",
		];
		if (withImages) {
			// The raw extracted `contentText` can be messy (SDT's table
			// content is often an unstructured flattened-text fallback --
			// no row/column breaks at all, every cell run together in
			// reading order -- rather than a real grid, confirmed
			// concretely on real papers) -- the older wording here told the
			// model to both "reproduce the rows/columns given below exactly"
			// AND prefer the image, which competed badly on exactly these
			// flattened tables: "do not merge/reorder" reads as a strong
			// directive anchored to the text's own (structure-less) word
			// order. Still keeps "reproduce exactly / do not invent, omit,
			// merge, or reorder any data" as an instruction -- the fix is
			// telling the model WHERE structure must come from (the image,
			// always) vs. where it must not (the raw text's word order),
			// not softening the exactness requirement itself.
			lines.push(
				"",
				"You are also given each table's own cropped image, attached in the SAME",
				"order as the tuples below (the first image is the first table's crop, and",
				"so on). Reproduce the table exactly as shown in the image -- do not invent,",
				"omit, merge, or reorder any data. Use the IMAGE as the primary source of",
				"truth for the table's STRUCTURE: how many rows/columns it has, multi-row/",
				"multi-column headers, and which cells belong together. The raw content text",
				"below is often flattened/unstructured by automated extraction (merged cells,",
				"misaligned columns, or every cell run together with no row/column breaks at",
				"all) -- do NOT rely on its word order for structure. Use the text only to",
				"help confirm individual field values where the image is hard to read."
			);
		}
		else {
			lines.push(
				"",
				"Reproduce the actual rows/columns given below exactly; do not invent,",
				"omit, merge, or reorder any data."
			);
		}
		lines.push(
			"",
			// Academic tables routinely have an in-cell citation like
			// "(Smith et al., 2020)" -- a literal comma inside a field
			// value, not a column break. Confirmed concretely this needed
			// spelling out: left unstated, a comma like that silently
			// shifts every later column in that row, corrupting the row
			// rather than merely mis-rendering one cell.
			"Wrap any field value that itself contains a comma in double quotes",
			'(e.g. the field XU ET AL., 2019 becomes "XU ET AL., 2019").',
			"",
			"Output ONLY the CSV tables, in the SAME order as listed below, with each one",
			"separated from the next by a line containing EXACTLY:",
			"[NEXT_TABLE]",
			"Do not include the table label, caption, any explanation, or markdown",
			"code fences in your output -- only the raw CSV content for each table, and",
			"the separator between them.",
			"",
			tuples
		);
		return lines.join("\n");
	},

	// If a request has more than this many tables, the CSV-formatting call
	// (see _formatTablesBatch/exportTablesToZip) is split into multiple
	// SEQUENTIAL batches of at most this many tables each, rather than one
	// single prompt covering all of them. A "generous" cap -- most export
	// requests are well under this, but "export all tables" on a long
	// paper isn't impossible, and an unbounded single prompt risks
	// exceeding the model's context window (especially with images
	// attached) or simply degrading output quality as the prompt grows.
	// Batches run sequentially, not in parallel, unlike most other multi-
	// item work in this plugin (e.g. llm/request.js's _runReferenceWorkerPool)
	// -- each batch is its own full (potentially large, potentially
	// multimodal) model call, and firing several of those at once risks
	// tripping a provider's per-minute rate limit in a way the smaller,
	// cheaper calls elsewhere in this plugin don't.
	_BATCH_SIZE: 25,

	// How many writer workers exportTablesToZip's producer/consumer
	// pipeline runs concurrently to drain the CSV-write queue (see its own
	// comment). Local disk I/O, not a network call -- much cheaper than
	// _BATCH_SIZE's model calls or _REFERENCE_CONCURRENCY's HiddenBrowser
	// instances elsewhere in this plugin, so this can comfortably run
	// higher than either without the same rate-limit/resource-pressure
	// concerns.
	_WRITE_CONCURRENCY: 8,

	// A minimal async work queue, used by exportTablesToZip's producer/
	// consumer CSV-write pipeline (see _runTableWriters/its own comment)
	// to let writing start as soon as the FIRST batch's CSVs are ready,
	// rather than waiting for every batch to finish first. enqueue(job)
	// adds an item and immediately wakes any worker currently blocked in
	// dequeue() waiting for one; dequeue() resolves with the next item
	// once available, or `null` once close() has been called AND the
	// queue has drained (a worker's own stop signal). Not a library --
	// this chrome context has no npm queue package available, and the
	// need here is too narrow to justify pulling one in.
	_createWriteQueue() {
		let items = [];
		let waiters = [];
		let closed = false;
		return {
			enqueue(job) {
				let waiter = waiters.shift();
				if (waiter) waiter(job);
				else items.push(job);
			},
			dequeue() {
				if (items.length) return Promise.resolve(items.shift());
				if (closed) return Promise.resolve(null);
				return new Promise(resolve => waiters.push(resolve));
			},
			close() {
				closed = true;
				while (waiters.length) waiters.shift()(null);
			},
		};
	},

	// Filesystem-safe stand-in for a table's own `label`, used for its CSV's
	// filename (see exportTablesToZip's queue.enqueue below) -- a label can
	// contain spaces/commas/periods (plainly-numbered ones are simple, e.g.
	// "3", but a lettered-appendix or section-derived synthetic one, e.g.
	// "Appendix B. FSQ codebook, Unlabelled Table 1", isn't filesystem-safe
	// as-is). Collapses anything outside [a-zA-Z0-9.-] to a single
	// underscore and caps length, rather than rejecting/erroring -- the
	// filename only needs to be valid and reasonably identifiable, not an
	// exact copy of the label (the label itself is still shown to the user
	// in every progress/result message).
	_sanitizeFilename(label) {
		return label.replace(/[^a-zA-Z0-9.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "table";
	},

	// Starts _WRITE_CONCURRENCY workers pulling jobs ({path, content,
	// label}) off `queue` (see _createWriteQueue) and writing each
	// one's `content` to its `path` via IOUtils.writeUTF8, until the
	// queue is closed and drained. Call this BEFORE `queue` has any jobs
	// enqueued yet, and WITHOUT awaiting it immediately -- each worker's
	// own loop starts running (up to its first await, blocked on
	// queue.dequeue()) the moment this function is called, same as any
	// async function, so the workers are already live and waiting by the
	// time the caller's own producer loop starts enqueueing jobs; only
	// await the returned promise once the caller is done enqueueing (see
	// exportTablesToZip). Returns { succeededCount, failedLabels } once
	// every worker has stopped -- write failures are per-job (a single
	// bad table doesn't stop the others, same tolerance
	// Promise.allSettled gave before this pipelining was added), collected
	// here rather than thrown, since the caller wants an accurate tally
	// at the end, not an aborted operation over one bad file.
	async _runTableWriters(queue, onProgress) {
		let succeededCount = 0;
		let failedLabels = [];
		let runWriter = async () => {
			while (true) {
				let job = await queue.dequeue();
				if (!job) return;
				try {
					await IOUtils.writeUTF8(job.path, job.content);
					succeededCount++;
				}
				catch (e) {
					failedLabels.push(job.label);
					let msg = `Failed to write table ${job.label}: ${e.message}`;
					this.log(`exportTablesToZip: ${msg}`);
					onProgress?.(msg);
				}
			}
		};
		await Promise.all(Array.from({ length: this._WRITE_CONCURRENCY }, () => runWriter()));
		return { succeededCount, failedLabels };
	},

	// Formats one batch's tables as CSV in a single model call (see
	// _buildCSVPrompt) -- split out of exportTablesToZip so it can be
	// called once per batch when the total table count exceeds
	// _BATCH_SIZE (see its own comment). `batchImages`, if not null, must
	// be the same length as `batchTables` (the caller's own slice of the
	// full images array, already aligned to this batch). Returns this
	// batch's own csvParts array (split on "[NEXT_TABLE]", fences
	// stripped) -- may come back shorter than `batchTables.length` if the
	// model didn't return as many blocks as expected; the caller (not
	// this function) logs/reports that, since only the caller knows which
	// batch number this was, for a useful message.
	async _formatTablesBatch(batchTables, batchImages) {
		// Labeled with the EXACT SAME "N. (label=...)" numbering
		// _buildCSVPrompt uses for this same batch's tuples (both derived
		// from batchTables' own index), so the label interleaved before
		// each image in the actual API call (see llm/interfaces.js's
		// streamOpenAICompatible/streamAnthropic) points the model straight
		// back to the matching tuple instead of leaving it to count
		// positionally through a same-length, separately-listed image list.
		let labeledImages = batchImages
			? batchTables.map((t, i) => ({ label: `Image for table ${i + 1} (${t.label}):`, dataUri: batchImages[i] }))
			: null;
		let raw = await this._callModel(this._buildCSVPrompt(batchTables, !!batchImages), labeledImages);
		return raw
			.split(/\n?\[NEXT_TABLE\]\n?/)
			// Defensive, same reasoning as _extractCitationMetadata's own
			// markdown-fence stripping elsewhere in this plugin -- the model
			// is explicitly told not to add code fences, but strips them if
			// it does anyway rather than shipping them into the CSV file.
			.map(s => s.replace(/^```(?:csv)?\s*|\s*```$/g, "").trim())
			.filter(Boolean);
	},

	// An nsIFilePicker in save mode, filtered to *.zip, defaulting to
	// $HOME/Zotero/LLMz/tables/ as its initial directory and "tables.zip"
	// as the filename -- same pattern export.js's own _createFilePicker
	// uses for exporting a conversation, just a different default directory
	// (tables/ instead of chats/<item key>/, since a table export isn't
	// scoped to one specific conversation the way a chat transcript is) and
	// filter. `onProgress`, if given, mirrors every this.log call here to
	// the Logs panel (see exportTablesToZip's own comment for why) --
	// optional since export.js's own _createFilePicker (which this one
	// mirrors) has no equivalent caller-supplied progress channel either.
	async _createFilePicker(onProgress) {
		let win = Zotero.getMainWindow();
		let fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
		fp.init(win.browsingContext, "Export Tables", Ci.nsIFilePicker.modeSave);
		fp.appendFilter("ZIP Archive", "*.zip");
		try {
			let dir = PathUtils.join(Zotero.DataDirectory.dir, "LLMz", "tables");
			await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
			let dirFile = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
			dirFile.initWithPath(dir);
			fp.displayDirectory = dirFile;
		}
		catch (e) {
			let msg = `Could not set the save dialog's default folder: ${e.message}`;
			this.log(`_createFilePicker: failed to set default directory: ${e.message}`);
			onProgress?.(msg);
		}
		fp.defaultString = "tables.zip";
		fp.defaultExtension = "zip";
		return fp;
	},

	// Resolves `tableIds` (already-resolved table_ids -- see llm/request.js's
	// _resolveIntentIndices) to their (label, caption, content) tuples,
	// asks the model to format ALL of them as CSV in ONE call (see
	// _buildCSVPrompt), splits the result on "[NEXT_TABLE]", and writes one
	// <label>.csv per table into a temp directory before
	// zipping it via Zotero.File.zipDirectory (Zotero's own zip-a-directory
	// helper, chrome/content/zotero/xpcom/file.js -- avoids hand-rolling
	// nsIZipWriter directly). Prompts for a save location via a native save
	// dialog (see _createFilePicker), same UX as export.js's own
	// exportConversation. The temp directory is always cleaned up
	// (finally), regardless of outcome.
	// Returns { success, cancelled, path, count, warning, message } --
	// `cancelled` only set true if the user dismissed the save dialog
	// (still `success: true`, since nothing went WRONG, the user just
	// changed their mind); `path`/`count` only set on an actual successful
	// save; `warning` set (alongside a normal successful `path`/`count`)
	// if SOME, but not all, tables failed to write -- the export still
	// goes ahead with whichever ones succeeded, rather than discarding all
	// of them over one bad table; `message` a user-facing status string
	// for every other (non-warning) case.
	async exportTablesToZip(tableIds, pdfItem, onProgress, onStage) {
		if (!pdfItem) {
			return { success: false, message: "No active PDF to export tables from." };
		}

		onProgress?.(`Looking up ${tableIds.length} table${tableIds.length === 1 ? "" : "s"} in the paper...`);
		let tableIndex = await LLMTables.getTableIndex(pdfItem, undefined, onProgress);
		let tables = tableIds
			.map(id => tableIndex?.tables?.find(t => t.table_id === id))
			.filter(Boolean);
		if (!tables.length) {
			return { success: false, message: `None of the requested table(s) (${tableIds.join(", ")}) were found in this paper.` };
		}

		// Attaches each table's own cropped rendering (tab.image_data) as
		// `images`, in the SAME order as the tuples in the prompt, so the
		// model can use the actual rendered table (a much more reliable
		// source of truth than the programmatically-extracted `contentText`,
		// which can have merged cells/misaligned columns/OCR-like
		// artifacts) to produce a more accurate CSV. Only attempted if
		// EVERY requested table actually has an image (a partial set would
		// misalign the "first image = first table" correspondence the
		// prompt promises) and the current model supports image input at
		// all -- falls back to text-only otherwise, same degraded-but-
		// working behavior as before this was added.
		//
		// Checked BEFORE rendering (not after) so a model with no image
		// support skips rendering entirely, rather than paying for it and
		// throwing the result away. image_data is never persisted to disk at
		// all -- the SDT-only detection pipeline (see document/tables.js/
		// scripts/extract-tables-sdt.js) only caches each table's bounding
		// box, not a rendering of it, so renderMissingImages lazily renders
		// (in memory only, for the rest of THIS session -- see its own
		// comment) whichever of `tables` don't have one yet, against that
		// cached bbox.
		let images = null;
		let model = await LLMInterfaces.getCurrentModel().catch(() => null);
		let supportsImages = model ? await LLMInterfaces.modelSupportsImages(model).catch(() => false) : false;
		if (!supportsImages) {
			this.log("exportTablesToZip: current model has no image support -- formatting from extracted text only");
			onProgress?.("Current model has no image support -- formatting tables from extracted text only.");
		}
		else {
			if (tables.some(t => !t.image_data)) {
				onProgress?.("Rendering table image(s)...");
				try {
					await LLMTables.renderMissingImages(pdfItem, tables);
				}
				catch (e) {
					this.log(`exportTablesToZip: renderMissingImages failed: ${e.message}`);
				}
			}
			images = tables.every(t => t.image_data) ? tables.map(t => t.image_data) : null;
		}

		onProgress?.(`Formatting ${tables.length} table${tables.length === 1 ? "" : "s"} as CSV${images ? " (using each table's rendered image)" : ""}...`);
		onStage?.("Formatting tables as CSV...");

		let tmpDir = PathUtils.join(Zotero.DataDirectory.dir, "LLMz", "tables", `tmp_${pdfItem.id}_${Date.now()}`);
		await IOUtils.makeDirectory(tmpDir, { ignoreExisting: true, createAncestors: true });
		try {
			// Producer/consumer pipeline, NOT "format everything, then
			// write everything" -- batches are still formatted
			// SEQUENTIALLY (see _BATCH_SIZE's own comment for why), but
			// writing doesn't wait for every batch to finish first: each
			// batch's own CSVs are enqueued the moment THAT batch comes
			// back, and _runTableWriters' workers (started below, BEFORE
			// this producer loop, and deliberately NOT awaited yet) are
			// already running, draining the queue concurrently with
			// whichever batch is still being formatted -- so batch 1's
			// files are being written to disk while batch 2 is still
			// waiting on the model, instead of sitting idle until the very
			// last batch also finishes.
			let queue = this._createWriteQueue();
			let writersPromise = this._runTableWriters(queue, onProgress);

			let batchCount = Math.ceil(tables.length / this._BATCH_SIZE);
			for (let b = 0; b < batchCount; b++) {
				let start = b * this._BATCH_SIZE;
				let end = Math.min(start + this._BATCH_SIZE, tables.length);
				let batchTables = tables.slice(start, end);
				let batchImages = images ? images.slice(start, end) : null;

				if (batchCount > 1) {
					let msg = `Formatting batch ${b + 1}/${batchCount} (${batchTables.length} table${batchTables.length === 1 ? "" : "s"}: ${batchTables.map(t => t.label).join(", ")})...`;
					onProgress?.(msg);
					onStage?.(`Formatting tables as CSV (batch ${b + 1}/${batchCount})...`);
				}

				let batchParts;
				try {
					batchParts = await this._formatTablesBatch(batchTables, batchImages);
				}
				catch (e) {
					// Lets whatever's already enqueued from EARLIER batches
					// finish writing (they're perfectly good; only THIS
					// batch failed), then reports the hard failure -- the
					// finally block below still removes tmpDir regardless,
					// so there's no risk of a half-written export lingering
					// on disk from this early return.
					queue.close();
					await writersPromise;
					let where = batchCount > 1 ? ` (batch ${b + 1}/${batchCount})` : "";
					return { success: false, message: `Failed to format tables as CSV${where}: ${e.message}` };
				}
				if (batchParts.length !== batchTables.length) {
					let where = batchCount > 1 ? ` from batch ${b + 1}/${batchCount}` : " from the model";
					let msg = `Expected ${batchTables.length} CSV block(s)${where}, got ${batchParts.length} -- proceeding with whatever matched, in order.`;
					this.log(`exportTablesToZip: ${msg}`);
					onProgress?.(msg);
				}
				for (let i = 0; i < Math.min(batchTables.length, batchParts.length); i++) {
					queue.enqueue({
						path: PathUtils.join(tmpDir, `${this._sanitizeFilename(batchTables[i].label)}.csv`),
						content: batchParts[i],
						label: batchTables[i].label,
					});
				}
			}
			queue.close();
			let { succeededCount, failedLabels } = await writersPromise;

			if (!succeededCount) {
				return { success: false, message: "The model did not return any usable CSV output." };
			}

			onProgress?.("Choosing where to save tables.zip...");
			let fp = await this._createFilePicker(onProgress);
			let result = await new Promise(resolve => fp.open(resolve));
			if (result === Ci.nsIFilePicker.returnCancel) {
				return { success: true, cancelled: true };
			}

			onStage?.("Creating zip archive...");
			// zipDirectory only ever sees whatever actually made it onto
			// disk in tmpDir -- a failed write above just means one fewer
			// file exists there, no special-casing needed here to exclude
			// it.
			await Zotero.File.zipDirectory(tmpDir, fp.file.path);
			let summary = `Wrote ${succeededCount} table(s) to ${fp.file.path}${failedLabels.length ? ` (failed: ${failedLabels.join(", ")})` : ""}`;
			this.log(`exportTablesToZip: ${summary}`);
			onProgress?.(summary);
			return {
				success: true,
				path: fp.file.path,
				count: succeededCount,
				warning: failedLabels.length
					? `Table${failedLabels.length === 1 ? "" : "s"} ${failedLabels.join(", ")} failed to write and ${failedLabels.length === 1 ? "was" : "were"} skipped.`
					: null,
			};
		}
		finally {
			IOUtils.remove(tmpDir, { recursive: true }).catch(() => {});
		}
	},
};
