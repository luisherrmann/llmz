// Resolves a table (or several) from the paper currently open in the reader
// -- by number, description, list, range, "all", or a criterion, same
// six-shape intent as tools/reference-retrieval.js/tools/reference-linker.js
// -- and exports them as CSV files bundled into a single zip archive on
// disk. Sibling to those two modules, following the exact same
// selection/resolution pattern (see intentTool/resolveExplicitIndices/
// resolveTableByDescription/resolveTableSelection below, each a close
// mirror of the reference-retrieval.js equivalent, just keyed off a
// table's own `table_num` instead of a reference's `index`) -- what
// differs entirely is what happens with the resolved numbers: this module
// pulls each table's (number, caption, content, and -- if every requested
// table has one and the current model supports image input -- its own
// cropped rendering) from document/tables.js's LLMTables.getTableIndex,
// hands them to the model in ONE prompt per batch of up to _BATCH_SIZE
// tables (not one call per table, unlike download/link's per-reference
// pipeline -- see exportTablesToZip/_formatTablesBatch), asking it to
// format each as a proper CSV table (using the rendered image as ground
// truth over the programmatically-extracted content, when attached), then
// splits each batch's response on a "[NEXT_TABLE]" separator, writes one
// file per table, and zips them all together.
LLMTableExport = {
	log(msg) {
		Zotero.debug("LLM Chat Pane [Table Export]: " + msg);
	},

	// `images`, if given, is passed straight through to streamModel -- an
	// array of data URIs, attached to this same one-off prompt (see
	// _buildCSVPrompt/exportTablesToZip, the only caller that ever passes
	// any).
	async _callModel(prompt, images) {
		let result = await LLMInterfaces.streamModel(prompt, () => {}, {}, images);
		return (result.text || "").trim();
	},

	// Native-tool-calling descriptor for this tool (see intent.js's
	// detectIntent/_registry) -- same shape/rationale as
	// LLMReferenceRetrieval.intentTool, see its own comment, including
	// `resolver` bundling the four functions request.js's
	// _resolveIntentIndices needs.
	intentTool: {
		name: "export_tables",
		description: [
			"Exports one or more tables from the paper currently open in the reader as",
			"CSV files bundled into a single zip archive, saved to disk. Use this when",
			"the user asks to export, save, extract, or download tables AS CSV/a zip",
			"file -- NOT for downloading or linking a bibliography reference (separate",
			"tools exist for those), and not for anything else about the PDF's content.",
		].join(" "),
		schema: {
			type: "object",
			properties: {
				type: {
					type: "string",
					enum: ["single", "describe", "list", "range", "all", "select"],
					description: [
						"single: one table by explicit number (set index). describe: one table",
						"identified by its caption/topic, no number given (set description).",
						"list: an enumerated set of specific numbers (set indices). range: a",
						"numeric range (set from/to). all: every table in the paper (no other",
						"fields needed). select: a criterion other than an explicit",
						"number/range/list, e.g. \"every table about latency\" (set description).",
					].join(" "),
				},
				index: { type: "integer", description: "Required when type is 'single' -- the table number." },
				description: { type: "string", description: "Required when type is 'describe' or 'select' -- the identifying text or selection criterion, in the user's own words." },
				indices: { type: "array", items: { type: "integer" }, description: "Required when type is 'list' -- the explicit table numbers." },
				from: { type: "integer", description: "Required when type is 'range' -- the start of the range." },
				to: { type: "integer", description: "Required when type is 'range' -- the end of the range." },
			},
			required: ["type"],
		},
		resolver: {
			getIndex: pdfItem => LLMTables.getTableIndex(pdfItem),
			explicit: (intent, index) => LLMTableExport.resolveExplicitIndices(intent, index),
			byDescription: (index, description) => LLMTableExport.resolveTableByDescription(index, description),
			selection: (index, description) => LLMTableExport.resolveTableSelection(index, description),
		},
	},

	// Same arithmetic as LLMReferenceRetrieval.resolveExplicitIndices, just
	// against a table's own `table_num` instead of a reference's `index`.
	resolveExplicitIndices(intent, tableIndex) {
		let valid = new Set((tableIndex?.tables || []).map(t => t.table_num));
		if (intent.type === "list") {
			return [...new Set(intent.indices)].filter(i => valid.has(i)).sort((a, b) => a - b);
		}
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

	// Same "give the LLM the short (number, caption) listing and let it
	// match loosely" approach as
	// LLMReferenceRetrieval.resolveReferenceByDescription -- a table's
	// caption is a much shorter, more reliable matching signal than its
	// full cell content, same reasoning as citation titles vs full
	// citations there.
	async resolveTableByDescription(tableIndex, description) {
		let tables = tableIndex?.tables || [];
		if (!tables.length) return null;
		let listing = tables.map(t => `[${t.table_num}] ${t.caption}`).join("\n");
		let prompt = [
			"Below is a list of tables from a paper, by number and caption. Identify",
			"which table (if any) matches the following description of a table the",
			'user wants to export. Respond with ONLY the table number. If no entry is',
			'a confident match, respond with exactly "none". Do not explain.',
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

	// Same cap/rationale as LLMReferenceRetrieval._MAX_SELECTION_RESULTS --
	// an overly broad criterion (or the model being overzealous) could
	// otherwise match most of a long table list, turning one export
	// request into a huge CSV-formatting prompt.
	_MAX_SELECTION_RESULTS: 10,

	async resolveTableSelection(tableIndex, description) {
		let tables = tableIndex?.tables || [];
		if (!tables.length) return [];
		let listing = tables.map(t => `[${t.table_num}] ${t.caption}`).join("\n");
		let prompt = [
			"Below is a list of tables from a paper, by number and caption. Identify",
			"every table that matches the following selection criterion, up to a",
			`maximum of ${this._MAX_SELECTION_RESULTS} entries (if more than`,
			`${this._MAX_SELECTION_RESULTS} match, pick the best/most confident`,
			'matches). Respond with ONLY a comma-separated list of table numbers (e.g.',
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
		let indices = [...new Set((text.match(/\d+/g) || []).map(n => parseInt(n, 10)))];
		return indices.slice(0, this._MAX_SELECTION_RESULTS);
	},

	// Builds the single combined prompt asking the model to turn every
	// requested table's raw extracted content into a proper CSV -- listed
	// as (number, caption) tuples followed by that table's own flattened
	// content (LLMTables._flattenTableData's output, already computed as
	// `contentText` by getTableIndex), in the SAME order `tables` is given
	// in, since the response is split back apart purely by position (see
	// exportTablesToZip) -- there's no per-table tagging in the requested
	// output, just the [NEXT_TABLE] separator and matching order.
	// `withImages` adds a paragraph telling the model each table's own
	// cropped rendering is attached, in the SAME order as the tuples below
	// -- see exportTablesToZip, which actually attaches
	// tab.image_data (the bounding-box crop extract_tables.py already
	// produces and caches, same source LLMTables' own image-embedding
	// pipeline uses) as `images` on this same streamModel call. The raw
	// extracted `contentText` can be messy (merged cells, multi-row
	// headers, OCR-like artifacts from pdfplumber's table detection) --
	// the actual rendered image is the more reliable ground truth for
	// resolving that, so the model's told explicitly to prefer it.
	_buildCSVPrompt(tables, withImages) {
		let tuples = tables.map((t, i) =>
			`${i + 1}. (number=${t.table_num}, caption="${t.caption}")\n${t.contentText}`
		).join("\n\n");
		let lines = [
			"Below are tables extracted from a scientific paper, given as (number,",
			"caption) tuples followed by that table's own raw content, listed in",
			"sequential order. For EACH table, produce a single, well-formed CSV",
			"representation of its data -- reproduce the actual rows/columns given",
			"below exactly; do not invent, omit, merge, or reorder any data. Output",
			"ONLY the CSV tables, in the SAME order as listed below, with each one",
			"separated from the next by a line containing EXACTLY:",
			"[NEXT_TABLE]",
			"Do not include the table number, caption, any explanation, or markdown",
			"code fences in your output -- only the raw CSV content for each table, and",
			"the separator between them.",
		];
		if (withImages) {
			lines.push(
				"",
				"You are also given each table's own cropped image, attached in the SAME",
				"order as the tuples below (the first image is the first table's crop, and",
				"so on). The raw content below was extracted programmatically and can be",
				"messy (merged cells, misaligned columns, multi-row headers) -- use the",
				"image as the source of truth for the table's actual structure and values",
				"whenever it disagrees with the raw content."
			);
		}
		lines.push("", tuples);
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
	// item work in this plugin (e.g. request.js's _runReferenceWorkerPool)
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

	// Starts _WRITE_CONCURRENCY workers pulling jobs ({path, content,
	// tableNum}) off `queue` (see _createWriteQueue) and writing each
	// one's `content` to its `path` via IOUtils.writeUTF8, until the
	// queue is closed and drained. Call this BEFORE `queue` has any jobs
	// enqueued yet, and WITHOUT awaiting it immediately -- each worker's
	// own loop starts running (up to its first await, blocked on
	// queue.dequeue()) the moment this function is called, same as any
	// async function, so the workers are already live and waiting by the
	// time the caller's own producer loop starts enqueueing jobs; only
	// await the returned promise once the caller is done enqueueing (see
	// exportTablesToZip). Returns { succeededCount, failedNums } once
	// every worker has stopped -- write failures are per-job (a single
	// bad table doesn't stop the others, same tolerance
	// Promise.allSettled gave before this pipelining was added), collected
	// here rather than thrown, since the caller wants an accurate tally
	// at the end, not an aborted operation over one bad file.
	async _runTableWriters(queue, onProgress) {
		let succeededCount = 0;
		let failedNums = [];
		let runWriter = async () => {
			while (true) {
				let job = await queue.dequeue();
				if (!job) return;
				try {
					await IOUtils.writeUTF8(job.path, job.content);
					succeededCount++;
				}
				catch (e) {
					failedNums.push(job.tableNum);
					let msg = `Failed to write table ${job.tableNum}: ${e.message}`;
					this.log(`exportTablesToZip: ${msg}`);
					onProgress?.(msg);
				}
			}
		};
		await Promise.all(Array.from({ length: this._WRITE_CONCURRENCY }, () => runWriter()));
		return { succeededCount, failedNums };
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
		let raw = await this._callModel(this._buildCSVPrompt(batchTables, !!batchImages), batchImages);
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
	// $HOME/Zotero/zllm/tables/ as its initial directory and "tables.zip"
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
			let dir = PathUtils.join(Zotero.DataDirectory.dir, "zllm", "tables");
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

	// Resolves `tableNums` (already-resolved table numbers -- see
	// request.js's _resolveIntentIndices) to their (number, caption,
	// content) tuples, asks the model to format ALL of them as CSV in ONE
	// call (see _buildCSVPrompt), splits the result on "[NEXT_TABLE]", and
	// writes one table_<number>.csv per table into a temp directory before
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
	async exportTablesToZip(tableNums, pdfItem, onProgress, onStage) {
		if (!pdfItem) {
			return { success: false, message: "No active PDF to export tables from." };
		}

		onProgress?.(`Looking up ${tableNums.length} table${tableNums.length === 1 ? "" : "s"} in the paper...`);
		let tableIndex = await LLMTables.getTableIndex(pdfItem);
		let tables = tableNums
			.map(n => tableIndex?.tables?.find(t => t.table_num === n))
			.filter(Boolean);
		if (!tables.length) {
			return { success: false, message: `None of the requested table(s) (${tableNums.join(", ")}) were found in this paper.` };
		}

		// Attaches each table's own cropped rendering (tab.image_data --
		// see extract_tables.py's own doc comment: a base64 JPEG of the
		// bounding box extract_tables.py found for the table, caption
		// included -- cached alongside everything else getTableIndex
		// returns, preserved as-is by embed_tables.py) as `images`, in the
		// SAME order as the tuples in the prompt, so the model can use the
		// actual rendered table (a much more reliable source of truth than
		// the programmatically-extracted `contentText`, which can have
		// merged cells/misaligned columns/OCR-like artifacts) to produce a
		// more accurate CSV. Only attempted if EVERY requested table
		// actually has an image (a partial set would misalign the "first
		// image = first table" correspondence the prompt promises) and the
		// current model supports image input at all -- falls back to
		// text-only otherwise, same degraded-but-working behavior as
		// before this was added.
		let images = tables.every(t => t.image_data) ? tables.map(t => t.image_data) : null;
		if (images) {
			let model = await LLMInterfaces.getCurrentModel().catch(() => null);
			let supportsImages = model ? await LLMInterfaces.modelSupportsImages(model).catch(() => false) : false;
			if (!supportsImages) {
				this.log("exportTablesToZip: current model has no image support -- formatting from extracted text only");
				onProgress?.("Current model has no image support -- formatting tables from extracted text only.");
				images = null;
			}
		}

		onProgress?.(`Formatting ${tables.length} table${tables.length === 1 ? "" : "s"} as CSV${images ? " (using each table's rendered image)" : ""}...`);
		onStage?.("Formatting tables as CSV...");

		let tmpDir = PathUtils.join(Zotero.DataDirectory.dir, "zllm", "tables", `tmp_${pdfItem.id}_${Date.now()}`);
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
					let msg = `Formatting batch ${b + 1}/${batchCount} (${batchTables.length} table${batchTables.length === 1 ? "" : "s"}: ${batchTables.map(t => t.table_num).join(", ")})...`;
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
						path: PathUtils.join(tmpDir, `table_${batchTables[i].table_num}.csv`),
						content: batchParts[i],
						tableNum: batchTables[i].table_num,
					});
				}
			}
			queue.close();
			let { succeededCount, failedNums } = await writersPromise;

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
			let summary = `Wrote ${succeededCount} table(s) to ${fp.file.path}${failedNums.length ? ` (failed: ${failedNums.join(", ")})` : ""}`;
			this.log(`exportTablesToZip: ${summary}`);
			onProgress?.(summary);
			return {
				success: true,
				path: fp.file.path,
				count: succeededCount,
				warning: failedNums.length
					? `Table${failedNums.length === 1 ? "" : "s"} ${failedNums.join(", ")} failed to write and ${failedNums.length === 1 ? "was" : "were"} skipped.`
					: null,
			};
		}
		finally {
			IOUtils.remove(tmpDir, { recursive: true }).catch(() => {});
		}
	},
};
