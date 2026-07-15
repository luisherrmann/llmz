// Executes one chat-pane request: a short-circuited "download this reference
// to my library" lookup, a short-circuited "link this reference to the
// matching library item" lookup, a short-circuited "export these tables as
// CSV" request, or (if no tool intent matches) the full normal chat flow
// (PDF-context building, table/figure/equation/note/reference
// extraction+selection, image handling, streaming the model's reply,
// citation grounding, and markdown+link rendering of the result). Each of
// these four intents is handled by its own method (_handleDownload/
// _handleLink/_handleTableExport/_handleNormalChat) -- send() itself is
// just a thin orchestrator: set up cancellation state, detect which intent
// applies (see llm/intent.js's detectIntent), and dispatch to the matching
// handler. Split out of chat-pane.js's submitButton click handler,
// which used to contain this whole flow inline -- what's left there now is
// just reading/validating the prompt, input history bookkeeping, and
// Submit/Stop button state, all of which are UI concerns distinct from the
// request itself.
//
// `chatPane` is the LLMChatPane singleton, passed explicitly to every
// handler below (rather than any of them depending on the global) so every
// "look at the active reader tab" / "render markdown" / "log" call is
// unambiguous about which object it's calling into:
// chatPane.getActiveReaderAttachment(), .getReaderSelection(),
// .getReaderPageText(), .getSelectedAnnotation(), ._renderMarkdown(),
// ._openLibraryItem(), .log().
//
// `ctx` (built once in send(), passed to every handler) bundles the handful
// of rendering callbacks/elements + cancellation plumbing this flow needs
// but doesn't own:
//   appendMessage/makeMessageClickable -- routing to ui/logs.js or
//     ui/chat.js, decided by the caller.
//   chat -- for chat.appendImages/updateMessageText/finalizeRichMessage/
//     setMessageText.
//   doc -- for creating the rendered-reply <div>.
//   imagePaste -- ui/image-paste.js's instance, for getDataUris().
//   takeCapturedSelection() -- reads-and-clears the reader-text-selection
//     snapshot the caller stashes on input focus (see chat-pane.js's
//     `capturedSelection`), needed as a fallback for when the reader's live
//     selection has already been cleared by the time this request runs
//     (e.g. focusing the prompt textarea can itself clear a page
//     selection).
//   replyLabel/providerLabel -- the active provider/model, resolved once up
//     front in send() so every handler's reply bubbles/messages show the
//     same label without each resolving it separately.
//   submissionTime -- captured in send() before ANY async work at all (see
//     its own comment there), so a handler's "You" bubble can show the
//     EXACT moment of submission via appendMessage's own `time` param,
//     rather than whenever that particular appendMessage call happens to
//     run (which can be noticeably later, e.g. after an LLM-based
//     detectIntent call).
//   isCancelled()/setCancelStream(fn) -- send()'s own `cancelled` flag and
//     `cancelStream` callback are plain closure variables there (so
//     cancel() below can flip/read them directly), exposed to the handlers
//     as functions rather than passed as raw values, since a raw boolean
//     copied into a handler's own arguments wouldn't reflect a LATER call
//     to cancel() made while that handler is still running.
LLMRequest = {
	log(msg) {
		Zotero.debug("LLM Chat Pane [Request]: " + msg);
	},

	// How many references may be downloaded (or linked) at once for a multi-
	// reference request (see _runReferenceWorkerPool below). Bounded rather
	// than unbounded, since "download/link all references" can mean 50+
	// papers. Unlike _CANDIDATE_CONCURRENCY (where launching MORE than
	// needed to reach the winning candidate's rank is pure waste -- see
	// tools/reference-retrieval.js), there's no early-stop dynamic here:
	// every requested reference has to be processed regardless, so raising
	// this doesn't have that same "overshoot" downside -- the tradeoff is
	// purely local resource pressure, since each reference's own download
	// pipeline can spin up to _CANDIDATE_CONCURRENCY HiddenBrowser instances
	// of its own (worst case _REFERENCE_CONCURRENCY * _CANDIDATE_CONCURRENCY
	// at once). Linking has no such per-reference fan-out (just one LLM call
	// + one local DB search each), so this bound is more conservative than
	// linking strictly needs, but shared for simplicity.
	_REFERENCE_CONCURRENCY: 8,

	// Resolves `intent` (see llm/intent.js's detectIntent) down to a concrete
	// list of numbers, against whichever index `tool`'s own resolver bundle
	// (see llm/intent.js's getResolver -- each tool's intentTool.resolver,
	// registered alongside its name/description/schema in llm/intent.js's
	// _registry, rather than a second per-tool map kept here) operates on.
	// Shared across every tool, since this resolution step is structurally
	// identical for all of them -- only which INDEX it resolves against,
	// and what's DONE with the resulting numbers afterward, differs per
	// tool.
	// "single"/"describe" resolve to at most one entry each; "list"/"range"/
	// "all" are pure arithmetic against the paper's own index (explicit, no
	// model call); "select" (a criterion like "all papers by Kaiming He",
	// "every table about latency") needs a further model call to actually
	// read the index and pick matches, same as "describe" already does for
	// a single entry -- just capped at several results instead of one.
	//
	// "single"/"list" check for an optional resolver.single/resolver.list
	// FIRST, before falling back to trusting intent.index/indices as
	// literal numbers -- references/etc. don't define either (a reference's
	// own number IS the answer, no lookup needed), but tables do (see
	// tools/table-export.js's own comment): the model never saw this
	// paper's actual table list at intent-detection time, so a name like
	// "D.2" needs a further table-listing-aware call to resolve, exactly
	// like "describe" already does.
	//
	// `pageNum` (the user's own current reader page, from send()'s own
	// getReaderPageText() call) is passed through to every resolver call
	// that involves an actual model lookup against the paper's index
	// (single/describe/select/list -- NOT explicit, which is pure
	// arithmetic with no model call), so a page-scoped table request
	// ("export the table on this page") has something to match against --
	// same reader-context signal llm/prompt.js's selectXWithLLM family
	// already gets. References/etc. simply ignore the extra argument (a
	// bibliography entry has no page of its own).
	async _resolveIntentIndices(tool, intent, pdfItem, pageNum) {
		let resolver = LLMIntent.getResolver(tool);
		if (intent.type === "single") {
			if (resolver.single) {
				let index = await resolver.getIndex(pdfItem);
				let resolved = await resolver.single(intent, index, pageNum);
				return resolved === null ? [] : [resolved];
			}
			return [intent.index];
		}
		if (intent.type === "describe") {
			let index = await resolver.getIndex(pdfItem);
			let resolved = await resolver.byDescription(index, intent.description, pageNum);
			return resolved === null ? [] : [resolved];
		}
		if (intent.type === "select") {
			let index = await resolver.getIndex(pdfItem);
			return resolver.selection(index, intent.description, pageNum);
		}
		if (intent.type === "list" && resolver.list) {
			let index = await resolver.getIndex(pdfItem);
			return resolver.list(intent, index, pageNum);
		}
		// list (references/etc, which have no resolver.list) / range / all
		let index = await resolver.getIndex(pdfItem);
		return resolver.explicit(intent, index);
	},

	// Builds a placeholder reply bubble for one reference, plus the
	// onProgress/onStage callback pair downloadReferenceToLibrary/
	// linkReferenceToLibrary both take -- shared boilerplate between
	// _handleDownload's/_handleLink's own per-reference work, split out
	// since it's identical either way. Visible placeholder, shown
	// immediately (rather than only once the whole, potentially slow,
	// multi-stage lookup finishes) and updated live as it proceeds -- via
	// onStage, kept separate from onProgress (full step-by-step detail,
	// Logs panel only) since the bubble only wants a few coarse, general
	// status lines, not every query/candidate onProgress reports.
	//
	// Created with an empty timestamp (see ui/chat.js's appendMessage/
	// setMessageTime) -- _handleDownload/_handleLink set the real one once
	// this reference's own lookup actually finishes, not here, so the
	// bubble doesn't show a misleadingly-early time for work that can take
	// several seconds.
	_createReferenceReply(refNum, ctx) {
		let { appendMessage, chat, replyLabel, isCancelled } = ctx;
		let reply = appendMessage(replyLabel, `Looking up reference ${refNum}...`, "");
		let onProgress = (msg) => {
			if (isCancelled()) return;
			appendMessage("System", msg);
		};
		let onStage = (msg) => {
			if (isCancelled()) return;
			chat.updateMessageText(reply, msg);
		};
		return { reply, onProgress, onStage };
	},

	// Runs `processOne(refNum)` -- _handleDownload's/_handleLink's own
	// per-reference work -- across every entry in `indices`, in parallel
	// (bounded by _REFERENCE_CONCURRENCY). Shared between the two since
	// this scheduling/error-handling shell is identical either way; only
	// what `processOne` actually does differs. `progressVerb` ("Downloading"/
	// "Linking") is used in the "Found N matching references..." message
	// for a multi-reference request; `failureNoun` ("download"/"linking")
	// in the per-reference failure message.
	//
	// Parallel across references, not sequential -- benchmarked concretely
	// (4 real references, 2 fast + 2 slow) that running references one at
	// a time makes total wall-clock time the SUM of every reference's own
	// time, while running them in parallel collapses it toward the
	// SLOWEST single reference instead, since each one mostly hits
	// different hosts (arXiv, Semantic Scholar, OpenReview, etc.) with no
	// shared bottleneck to serialize on -- confirmed ~2x faster on that
	// real test. The one shared bottleneck that DOES exist, DuckDuckGo's
	// search endpoint (see tools/reference-retrieval.js's
	// _findPDFViaWebSearch), is serialized separately via
	// _throttledSearchWeb, so parallelizing here doesn't make that worse.
	// Bounded (not a free-for-all Promise.all over every index) since
	// "download/link all references" can mean 50+ papers at once -- an
	// unbounded fan-out would mean that many simultaneous HiddenBrowser
	// instances/Translate calls (download) or LLM calls (link). A single
	// reference throwing (e.g. a network error) is caught per-reference so
	// it doesn't abort the rest of the batch.
	async _runReferenceWorkerPool(indices, ctx, progressVerb, failureNoun, processOne) {
		let { appendMessage, isCancelled } = ctx;

		if (indices.length > 1) {
			appendMessage("System", `Found ${indices.length} matching references: ${indices.join(", ")}. ${progressVerb}...`);
		}

		let nextIndexPos = 0;
		let worker = async () => {
			while (nextIndexPos < indices.length) {
				if (isCancelled()) return;
				let refNum = indices[nextIndexPos++];
				try {
					await processOne(refNum);
				}
				catch (e) {
					if (isCancelled()) return;
					this.log(`processOne(${refNum}) [${failureNoun}] failed: ${e.message}`);
					appendMessage("System", `Reference ${refNum} ${failureNoun} failed: ${e.message}`);
				}
			}
		};
		let workerCount = Math.min(this._REFERENCE_CONCURRENCY, indices.length);
		await Promise.all(Array.from({ length: workerCount }, () => worker()));
	},

	// Handles a resolved "download" tool intent -- see
	// _runReferenceWorkerPool for the shared scheduling shell. See the
	// module-level comment for `ctx`.
	async _handleDownload(indices, pdfItem, chatPane, ctx) {
		let { chat } = ctx;
		await this._runReferenceWorkerPool(indices, ctx, "Downloading", "download", async (refNum) => {
			let { reply, onProgress, onStage } = this._createReferenceReply(refNum, ctx);
			let result = await LLMReferenceRetrieval.downloadReferenceToLibrary(refNum, pdfItem, onProgress, onStage);
			if (ctx.isCancelled()) return;
			// Looked up fresh here rather than threaded through
			// downloadReferenceToLibrary's own result -- getReferenceIndex is
			// memoized in-memory per item (see document/references.js), and
			// was already computed once inside downloadReferenceToLibrary
			// itself, so this is a cheap Map lookup, not a re-extraction.
			// `position` can be null (see references.js's own comment on
			// when a reference entry has none), in which case no link is
			// shown -- same fallback-to-plain-text treatment as every other
			// makeMessageClickable/finalizeRichMessage caller in this file.
			let referenceIndex = await LLMReferences.getReferenceIndex(pdfItem).catch(() => null);
			let ref = referenceIndex?.references?.find(r => LLMReferences.displayNumber(r) === refNum);
			let referenceLink = ref?.position
				// "[N]" -- same bracket notation llm/prompt.js's own
				// _formatReferenceContext uses for a reference's label
				// elsewhere in this plugin.
				? { label: `[${refNum}]`, title: "Jump to this reference in the paper", onClick: () => LLMCitation.navigateToPosition(ref.position) }
				: null;

			if (result.alreadyInLibrary) {
				let parts = [
					{ text: "The paper is already included in your Zotero library: " },
				];
				if (referenceLink) parts.push(referenceLink, { text: " " });
				parts.push(
					{ label: result.item.getField("title"), title: "Open in Zotero", onClick: () => chatPane._openLibraryItem(result.item) },
				);
				parts.push({ text: "." });
				chat.finalizeRichMessage(reply, parts);
			}
			else if (result.success) {
				let statusText = result.hasPDF ? " with its PDF" : " (metadata only — no PDF could be found)";
				let parts = [
					{ text: "Added " },
				];
				if (referenceLink) parts.push(referenceLink, { text: " " });
				parts.push(
					{ label: result.item.getField("title"), title: "Open in Zotero", onClick: () => chatPane._openLibraryItem(result.item) },
					{ text: statusText },
				);
				if (result.sourceURL) {
					parts.push(
						{ text: " (source: " },
						{ label: result.sourceURL, title: "Open source in browser", onClick: () => Zotero.launchURL(result.sourceURL) },
						{ text: ")" }
					);
				}
				parts.push({ text: "." });
				chat.finalizeRichMessage(reply, parts);
			}
			else {
				chat.updateMessageText(reply, result.message);
			}
			// Only shown once this reference's own lookup is actually done
			// -- see _createReferenceReply's own comment.
			chat.setMessageTime(reply, chat.formatTimestamp());
		});
	},

	// Handles a resolved "link" tool intent -- see _runReferenceWorkerPool
	// for the shared scheduling shell. See the module-level comment for
	// `ctx`.
	async _handleLink(indices, pdfItem, chatPane, ctx) {
		let { chat } = ctx;
		await this._runReferenceWorkerPool(indices, ctx, "Linking", "linking", async (refNum) => {
			let { reply, onProgress, onStage } = this._createReferenceReply(refNum, ctx);
			let result = await LLMReferenceLinker.linkReferenceToLibrary(refNum, pdfItem, onProgress, onStage);
			if (ctx.isCancelled()) return;
			if (result.success && result.linked) {
				let verb = result.alreadyLinked ? "is already linked to" : "linked to";
				chat.finalizeRichMessage(reply, [
					{ text: `"` },
					{ label: result.item.getField("title"), title: "Open in Zotero", onClick: () => chatPane._openLibraryItem(result.item) },
					{ text: `" ${verb} the current paper.` },
				]);
			}
			else {
				// Either the reference's title couldn't be
				// resolved, or a title WAS resolved but nothing
				// matching exists in the library yet (see
				// linkReferenceToLibrary -- deliberately never
				// downloads anything itself) -- both cases
				// already carry a complete, user-facing message.
				chat.updateMessageText(reply, result.message);
			}
			// Only shown once this reference's own lookup is actually done
			// -- see _createReferenceReply's own comment.
			chat.setMessageTime(reply, chat.formatTimestamp());
		});
	},

	// Handles a resolved "tables" tool intent -- a single combined
	// operation over ALL resolved table numbers at once (one CSV-
	// formatting prompt covering every requested table -- see
	// tools/table-export.js's exportTablesToZip), unlike
	// _handleDownload's/_handleLink's per-reference pipeline, so this gets
	// its own small, standalone handler rather than sharing
	// _runReferenceWorkerPool. See the module-level comment for `ctx`.
	async _handleTableExport(indices, pdfItem, ctx) {
		let { appendMessage, chat, replyLabel, isCancelled } = ctx;

		// Empty timestamp until the export actually finishes (see the
		// setMessageTime calls below) -- see ui/chat.js's appendMessage/
		// setMessageTime.
		let reply = appendMessage(replyLabel, `Exporting ${indices.length} table${indices.length === 1 ? "" : "s"}...`, "");
		let onProgress = (msg) => {
			if (isCancelled()) return;
			appendMessage("System", msg);
		};
		let onStage = (msg) => {
			if (isCancelled()) return;
			chat.updateMessageText(reply, msg);
		};
		try {
			let result = await LLMTableExport.exportTablesToZip(indices, pdfItem, onProgress, onStage);
			if (isCancelled()) return;
			if (result.cancelled) {
				chat.updateMessageText(reply, "Export cancelled.");
			}
			else if (result.success) {
				let parts = [
					{ text: `Exported ${result.count} table${result.count === 1 ? "" : "s"} to ` },
					{ label: result.path, title: "Open containing folder", onClick: () => Zotero.File.reveal(result.path) },
					{ text: "." },
				];
				// Set alongside a normal successful path/count when SOME
				// (not all) tables failed to write -- see
				// exportTablesToZip's own comment -- appended rather than
				// replacing the success message, since the export still
				// went through for whichever tables DID write.
				if (result.warning) {
					parts.push({ text: ` ${result.warning}` });
				}
				chat.finalizeRichMessage(reply, parts);
			}
			else {
				chat.updateMessageText(reply, result.message);
			}
			// Only shown once this reply's own final text is actually set
			// (see appendMessage's/setMessageTime's own doc comments in
			// ui/chat.js) -- reply started with an empty timestamp.
			chat.setMessageTime(reply, chat.formatTimestamp());
		}
		catch (e) {
			if (isCancelled()) return;
			this.log(`exportTablesToZip failed: ${e.message}`);
			chat.updateMessageText(reply, `Table export failed: ${e.message}`);
			chat.setMessageTime(reply, chat.formatTimestamp());
		}
	},

	// Awaits `tableIndexPromise`, runs table selection against `prompt`, and
	// reports status along the way -- split out of _handleNormalChat so
	// each of the five context-building steps (this, equations, notes,
	// images/figures, references) lives in its own function instead of one
	// large inline block. Returns { index, addition } -- `index` is the
	// raw table index (needed later for linkIndex construction), `addition`
	// the `<TABLE_CONTEXT>...</TABLE_CONTEXT>` string to append to
	// modelPrompt, or "" if there's nothing to add (no PDF, extraction
	// failed/found nothing, or nothing matched the question closely
	// enough) -- returned rather than mutating modelPrompt directly, so
	// this function doesn't need write access to the caller's own local.
	async _buildTableContext(tableIndexPromise, prompt, readerContext, ctx) {
		let { appendMessage, makeMessageClickable, isCancelled } = ctx;
		let tableIndex = await tableIndexPromise;
		if (isCancelled()) return { index: tableIndex, addition: "" };
		if (tableIndex === null) {
			appendMessage("System", "Table extraction: no PDF attached.");
			return { index: tableIndex, addition: "" };
		}
		if (tableIndex.error) {
			appendMessage("System", `Table extraction failed: ${tableIndex.error}`);
			return { index: tableIndex, addition: "" };
		}
		if (!tableIndex.tables.length) {
			appendMessage("System", "Table extraction: no tables found in PDF.");
			return { index: tableIndex, addition: "" };
		}
		let selectedTables = [];
		try {
			selectedTables = await LLMPrompt.selectTablesWithLLM(tableIndex, prompt, readerContext);
		}
		catch (e) {
			this.log(`selectTablesWithLLM failed: ${e.message}`);
		}
		if (isCancelled()) return { index: tableIndex, addition: "" };
		if (!selectedTables.length) {
			appendMessage("System", `Extracted ${tableIndex.tables.length} table${tableIndex.tables.length === 1 ? "" : "s"} from PDF; none matched your question closely enough to include.`);
			return { index: tableIndex, addition: "" };
		}
		let tableBlock = selectedTables.map(t => LLMPrompt._formatTableMarkdown(t)).join("\n\n");
		let addition = `\n\n<TABLE_CONTEXT>\n${tableBlock}\n</TABLE_CONTEXT>`;
		let labels = selectedTables.map(t => t.label).join(", ");
		let msg = appendMessage("System", `Including ${selectedTables.length} table${selectedTables.length === 1 ? "" : "s"} as context (out of ${tableIndex.tables.length} extracted): ${labels}. Click to jump to the first one.`);
		makeMessageClickable(msg, selectedTables[0]);
		return { index: tableIndex, addition };
	},

	// Same shape/rationale as _buildTableContext above, for equations.
	// Unlike tables (present in most papers), the large majority of PDFs
	// have zero *numbered* equations at all -- so, unlike the table
	// version, this stays silent for the "none found"/"none matched" cases
	// rather than announcing an absence that's the overwhelmingly common
	// case and not something the user asked about.
	async _buildEquationContext(equationIndexPromise, prompt, readerContext, ctx) {
		let { appendMessage, makeMessageClickable, isCancelled } = ctx;
		let equationIndex = await equationIndexPromise;
		if (isCancelled()) return { index: equationIndex, addition: "" };
		if (equationIndex?.error) {
			appendMessage("System", `Equation extraction failed: ${equationIndex.error}`);
			return { index: equationIndex, addition: "" };
		}
		if (!equationIndex?.equations?.length) {
			return { index: equationIndex, addition: "" };
		}
		let selectedEquations = [];
		try {
			selectedEquations = await LLMPrompt.selectEquationsWithLLM(equationIndex, prompt, readerContext);
		}
		catch (e) {
			this.log(`selectEquationsWithLLM failed: ${e.message}`);
		}
		if (isCancelled()) return { index: equationIndex, addition: "" };
		if (!selectedEquations.length) {
			return { index: equationIndex, addition: "" };
		}
		let eqBlock = selectedEquations.map(eq => LLMPrompt._formatEquationText(eq)).join("\n\n");
		let addition = `\n\n<EQUATION_CONTEXT>\n${eqBlock}\n</EQUATION_CONTEXT>`;
		let labels = selectedEquations.map(eq => eq.label).join(", ");
		let msg = appendMessage("System", `Including ${selectedEquations.length} equation${selectedEquations.length === 1 ? "" : "s"} as equation context (out of ${equationIndex.equations.length} extracted): ${labels}. Click to jump to the first one.`);
		// caption fallback mirrors linkIndex's equation entries elsewhere --
		// selectedEquations entries have no `caption` field, only `text`.
		makeMessageClickable(msg, {
			position: selectedEquations[0].position,
			caption: selectedEquations[0].text.split(/\s+/).slice(0, 8).join(" "),
		});
		return { index: equationIndex, addition };
	},

	// Same shape/rationale as _buildTableContext above, for notes. Always
	// announced, even on the "found none"/"none matched" paths -- unlike
	// the equation version, this stays visible (matching the table
	// version's style) since it's useful for debugging whether annotations
	// are being picked up as expected. Returns `notes` (the selected ones,
	// possibly empty) alongside `addition` -- unlike the other four
	// context builders, the caller needs this back too, for
	// linkIndex's ref:note:KEY resolution.
	async _buildNoteContext(notesPromise, prompt, readerContext, ctx) {
		let { appendMessage, makeMessageClickable, isCancelled } = ctx;
		let notes = await notesPromise;
		if (isCancelled()) return { notes: [], addition: "" };
		if (!notes.length) {
			appendMessage("System", "Notes: no highlights, underlines, or notes found on this PDF.");
			return { notes: [], addition: "" };
		}
		let selectedNotes = [];
		try {
			selectedNotes = await LLMPrompt.selectNotesWithLLM(notes, prompt, readerContext);
		}
		catch (e) {
			this.log(`selectNotesWithLLM failed: ${e.message}`);
		}
		if (isCancelled()) return { notes: selectedNotes, addition: "" };
		if (!selectedNotes.length) {
			appendMessage("System", `Extracted ${notes.length} note${notes.length === 1 ? "" : "s"}/highlight${notes.length === 1 ? "" : "s"} from PDF; none matched your question closely enough to include.`);
			return { notes: selectedNotes, addition: "" };
		}
		let noteBlock = selectedNotes.map((n, i) => LLMPrompt._formatNoteContext(n, i + 1)).join("\n\n");
		let addition = `\n\n<NOTE_CONTEXT>\n${noteBlock}\n</NOTE_CONTEXT>`;
		let titles = selectedNotes.map(n => n.title).join(", ");
		let msg = appendMessage("System", `Including ${selectedNotes.length} note${selectedNotes.length === 1 ? "" : "s"} as context (out of ${notes.length} extracted): ${titles}. Click to jump to the first one.`);
		// Whole-message click only jumps to the first selected note --
		// makeMessageClickable is a single click target, not one per
		// note -- good enough as a quick way in, the rest are visible in
		// the model's own answer either way (each individually
		// clickable via its own [Note N](<ref:note:KEY>) link, if the
		// model includes one).
		makeMessageClickable(msg, selectedNotes[0]);
		return { notes: selectedNotes, addition };
	},

	// Gathers `images` for this turn -- the user's own pasted image(s), if
	// the current model supports image input, plus (only when the user
	// DIDN'T paste any themselves) the best-matching figure(s) for `prompt`,
	// if any have their own image data and the model supports vision.
	// Unlike the other four context builders, `images` (the data URIs to
	// actually send) aren't injected as prompt TEXT -- but `addition`
	// (returned same as those other builders) still is: a figure attached
	// as a pure image has no OTHER way to tell the model its own citable
	// ref:figure:N/ref:figureExtra:N target the way a numbered figure's own
	// printed caption (visible right there in the crop) implicitly can --
	// this matters specifically for a figure_num === null figure (an
	// appendix-lettered caption, or a synthetic heading-derived label for
	// an uncaptioned one -- see scripts/extract_figures_sdt.js), which the
	// model has no way to derive a citable number for just by looking at
	// the image. `index` is the raw figure index, needed later for
	// linkIndex's citation-link resolution on figures the model's text
	// mentions, regardless of whether any of them ended up attached as
	// images here.
	async _buildImageContext(figureIndexPromise, pastedImageDataUris, prompt, readerContext, pdfItem, ctx) {
		let { appendMessage, makeMessageClickable, isCancelled } = ctx;
		let images = [];
		let addition = "";
		let figureIndex = await figureIndexPromise;
		if (isCancelled()) return { index: figureIndex, images, addition };
		try {
			let currentModel = await LLMInterfaces.getCurrentModel();
			let supportsImages = await LLMInterfaces.modelSupportsImages(currentModel);
			// pastedImageDataUris was already snapshotted by the caller
			// (before this request's async work began), so a mid-request
			// removal via the thumbnail's "x" doesn't retroactively change
			// what's sent for a request already in flight.
			if (pastedImageDataUris.length) {
				if (supportsImages) {
					images.push(...pastedImageDataUris);
				}
				else {
					appendMessage("System", `${currentModel} doesn't support image input -- the ${pastedImageDataUris.length} attached image${pastedImageDataUris.length === 1 ? "" : "s"} won't be sent.`);
				}
			}
			// Skipped when the user already attached image(s) themselves --
			// no need to spend an extra LLM call hunting for a figure to use
			// as image context when image context has already been provided.
			// figureIndex itself is still fetched above regardless (used by
			// the caller for citation-link resolution on figures the
			// model's text mentions).
			if (figureIndex?.figures?.length && supportsImages && !pastedImageDataUris.length) {
				let bestFigures = await LLMPrompt.selectFiguresWithLLM(figureIndex, prompt, readerContext);
				if (isCancelled()) return { index: figureIndex, images, addition };
				// image_data is no longer part of the figure index cache itself
				// (see LLMFigures.renderMissingImages's own comment) -- rendered
				// lazily here, on demand, only for whichever of the LLM-selected
				// `bestFigures` don't already have one, against each figure's own
				// cached bounding box (`position`, no re-detection needed). Same
				// on-demand pattern as tools/table-export.js's own table
				// rendering, just triggered by a chat turn instead of an export.
				if (bestFigures.some(f => !f.image_data)) {
					try {
						await LLMFigures.renderMissingImages(pdfItem, bestFigures);
					}
					catch (e) {
						// Not surfaced via appendMessage here -- same convention as
						// _buildTableContext's own selectTablesWithLLM catch (Debug-
						// Output-only for an internal-step failure); the "selected
						// but couldn't render" message below already tells the user
						// the user-visible OUTCOME (whether total or partial), which
						// is what actually matters to them.
						this.log(`_buildImageContext: renderMissingImages failed: ${e.message}`);
					}
				}
				let figuresWithImages = bestFigures.filter(f => f.image_data);
				if (figuresWithImages.length) {
					images.push(...figuresWithImages.map(f => f.image_data));
					let labels = figuresWithImages.map(f => f.label || `figure ${f.figure_num}`).join(", ");
					let msg = appendMessage("System", `Including ${figuresWithImages.length} figure${figuresWithImages.length === 1 ? "" : "s"} as image context (best match for your question, ${currentModel} supports vision): ${labels}. Click to jump to the first one.`);
					makeMessageClickable(msg, figuresWithImages[0]);
					let figureBlock = figuresWithImages.map(f => LLMPrompt._formatFigureCitationHint(f)).join("\n");
					addition = `\n\n<FIGURE_CONTEXT>\n${figureBlock}\n</FIGURE_CONTEXT>`;
				}
				// bestFigures non-empty but every render attempt still came up
				// image-data-less (e.g. render_crops.py failed for all of them,
				// or every candidate lacked a usable `position`) -- previously
				// silent (figuresWithImages.length === 0 just skipped the block
				// above with no trace anywhere in the chat's own Logs panel),
				// which made a render regression indistinguishable from the LLM
				// legitimately finding no relevant figure at all. Surfaced
				// separately from the renderMissingImages catch above since a
				// PARTIAL failure (some rendered, some didn't) throws no
				// exception there at all -- rendered.length simply comes back
				// short.
				else if (bestFigures.length) {
					appendMessage("System", `Selected ${bestFigures.length} relevant figure${bestFigures.length === 1 ? "" : "s"} but couldn't render ${bestFigures.length === 1 ? "its" : "their"} image(s) -- continuing without image context.`);
				}
			}
		}
		catch (e) {
			if (!isCancelled()) this.log(`Image context setup failed: ${e.message}`);
		}
		return { index: figureIndex, images, addition };
	},

	// Same shape/rationale as _buildTableContext above, for the
	// bibliography -- inclusion here is an LLM judgment call
	// (shouldIncludeReferencesWithLLM), not a top-K selection like the
	// other four, since a whole bibliography is either worth including in
	// full or not at all (there's no sensible "some of the references").
	async _buildReferenceContext(referenceIndexPromise, prompt, readerContext, ctx) {
		let { appendMessage, isCancelled } = ctx;
		let referenceIndex = await referenceIndexPromise;
		if (isCancelled()) return { index: referenceIndex, addition: "" };
		if (!referenceIndex?.references?.length) {
			return { index: referenceIndex, addition: "" };
		}
		let includeReferences = false;
		try {
			includeReferences = await LLMPrompt.shouldIncludeReferencesWithLLM(referenceIndex, prompt, readerContext);
		}
		catch (e) {
			this.log(`shouldIncludeReferencesWithLLM failed: ${e.message}`);
		}
		if (isCancelled()) return { index: referenceIndex, addition: "" };
		if (!includeReferences) {
			appendMessage("System", `Extracted ${referenceIndex.references.length} reference${referenceIndex.references.length === 1 ? "" : "s"} from bibliography; not relevant enough to include.`);
			return { index: referenceIndex, addition: "" };
		}
		let addition = `\n\n<REFERENCE_CONTEXT>\n${LLMPrompt._formatReferenceContext(referenceIndex.references)}\n</REFERENCE_CONTEXT>`;
		appendMessage("System", `Including bibliography (${referenceIndex.references.length} references) as context.`);
		return { index: referenceIndex, addition };
	},

	// Unlike the five _buildXContext methods above (each selecting AMONG
	// candidates already extracted from THIS paper), there's no index to
	// await here -- LLMCitation.getCrossLibraryChunks searches the whole
	// library's own embeddings DB directly, so this only runs at all
	// once shouldIncludeCrossLibraryWithLLM says the OTHER papers in the
	// library are actually worth searching for this question. Skipped
	// entirely with no active PDF (pdfItem null) -- "the current paper" and
	// "every OTHER paper" both stop being meaningful without one.
	async _buildCrossLibraryContext(prompt, readerContext, pdfItem, title, ctx) {
		let { appendMessage, isCancelled } = ctx;
		if (!pdfItem) return { addition: "" };

		let includeCrossLibrary = false;
		try {
			includeCrossLibrary = await LLMPrompt.shouldIncludeCrossLibraryWithLLM(prompt, title, readerContext);
		}
		catch (e) {
			this.log(`shouldIncludeCrossLibraryWithLLM failed: ${e.message}`);
		}
		this.log(`_buildCrossLibraryContext: shouldIncludeCrossLibraryWithLLM -> ${includeCrossLibrary}`);
		if (isCancelled()) return { addition: "" };
		// Logged either way (not just on inclusion) -- without this, "cross-
		// library context never showed up" and "it was never even considered
		// relevant for this question" are indistinguishable from the Logs
		// panel alone.
		if (!includeCrossLibrary) {
			appendMessage("System", "Cross-library context: judged not relevant to this question, skipping.");
			return { addition: "" };
		}

		let chunks = [];
		try {
			let model = await LLMCitation.getEmbeddingModel();
			let provider = LLMInterfaces._embeddingProvider;
			chunks = await LLMCitation.getCrossLibraryChunks(prompt, model, provider, LLMPrompt.crossLibraryTopK, pdfItem.id);
		}
		catch (e) {
			this.log(`getCrossLibraryChunks failed: ${e.message}`);
		}
		if (isCancelled()) return { addition: "" };
		if (!chunks.length) {
			appendMessage("System", "Cross-library context judged relevant, but no matching paragraphs were found in other papers.");
			return { addition: "" };
		}

		let addition = `\n\n<CROSS_LIBRARY_CONTEXT>\n${LLMPrompt._formatCrossLibraryContext(chunks)}\n</CROSS_LIBRARY_CONTEXT>`;
		// Grouped by paper (chunks.length counts PARAGRAPHS, several of
		// which can come from the same paper) so this reads as "which papers
		// got pulled in" rather than a flat, possibly-repetitive per-chunk
		// list -- exactly what to check to confirm cross-library retrieval
		// is actually pulling from the papers you'd expect, not something
		// misconfigured (e.g. the wrong embedding model, or a paper that
		// silently never got indexed).
		let byPaper = new Map();
		for (let chunk of chunks) {
			let entry = byPaper.get(chunk.paperId);
			if (!entry) byPaper.set(chunk.paperId, entry = { title: chunk.title, count: 0 });
			entry.count++;
		}
		appendMessage("System", `Including cross-library context (${chunks.length} paragraph${chunks.length === 1 ? "" : "s"} from ${byPaper.size} other paper${byPaper.size === 1 ? "" : "s"}).`);
		for (let [paperId, { title, count }] of byPaper) {
			appendMessage("System", `  - "${title}" [paper_id: ${paperId}]: ${count} paragraph${count === 1 ? "" : "s"}`);
		}
		return { addition };
	},

	// Handles the "no tool intent matched" case -- the full normal chat
	// flow: PDF-context building, table/figure/equation/note/reference
	// extraction+selection (see the five _buildXContext methods above),
	// image handling, streaming the model's reply, citation grounding, and
	// markdown+link rendering of the result. See the module-level comment
	// for `ctx`. Owns its own try/catch (unlike _handleDownload/
	// _handleLink/_handleTableExport, whose caller wraps the intent-
	// detection step that leads to them in one shared try/catch) since
	// this is the fallback path once tool-intent detection has already
	// fully finished.
	async _handleNormalChat(prompt, chatPane, ctx) {
		let { doc, appendMessage, chat, imagePaste, takeCapturedSelection, replyLabel, providerLabel, submissionTime, isCancelled, setCancelStream } = ctx;

		try {
			// Snapshotted BEFORE this turn's own "You" bubble (and reply
			// placeholder) get appended below -- see the messages-array
			// build further down, right before streamModel -- so history
			// naturally excludes the CURRENT turn (which gets sent
			// separately, as the full context-stuffed modelPrompt, not
			// this turn's own raw/placeholder transcript entries).
			let priorTranscript = chat.exportTranscript();
			let { text: liveText, info: selectionInfo } = chatPane.getReaderSelection();
			let selectedText = liveText || takeCapturedSelection();
			let { text: pageText, pageNum, info: pageInfo } = await chatPane.getReaderPageText();
			if (isCancelled()) return;
			// Shared reader-context signal for every selectXWithLLM call
			// below (tables/equations/figures/notes) -- if the user has an
			// annotation actively selected/highlighted in the reader right
			// now (clicked on the page or in the sidebar), that's about as
			// strong a relevance hint as it gets for a query like "explain
			// this".
			let { item: selectedAnnotationItem } = chatPane.getSelectedAnnotation();
			let selectedAnnotationNote = selectedAnnotationItem
				? LLMNotes.formatAnnotation(selectedAnnotationItem)
				: null;
			let readerContext = { pageNum, selectedText, selectedAnnotationNote };

			// Created here -- BEFORE embedding recompute/context-building --
			// rather than after, so onEmbeddingStart below has a reply
			// bubble to update. Order relative to each other matters (see
			// ui/chat.js's list.prepend -- each new message ends up ABOVE
			// the previous one, so creating userReply first/reply second
			// preserves the existing visual order: reply above userReply).
			let userReply = appendMessage("You", prompt, submissionTime);
			// Fire-and-forget (not awaited) -- LLMSemanticHistory.selectRelevant
			// (used by "semantic" mode, see the messages-array build further
			// down) only ever looks at whatever's landed in its cache BY THE
			// TIME a later query needs it; embedding this message now, in the
			// background, doesn't block the reply that's about to stream in
			// for THIS turn. Gated on "semantic" mode -- selectRelevant is
			// the only thing that ever reads this cache, and it's itself
			// gated the same way (see the messages-array build further
			// down), so embedding here in "none"/"last-k" mode would just
			// be a wasted embedding-provider call for a cache nothing will
			// consult. Switching TO "semantic" mid-conversation backfills
			// the whole transcript in one go instead (see ui/advanced.js's
			// "Use message history" row), so there's no gap for messages
			// sent before the switch.
			if (LLMPrompt.useMessageHistory === "semantic") {
				LLMSemanticHistory.embedNewMessage({ role: "You", time: submissionTime, text: prompt });
			}
			// A visual record of what was actually attached to this
			// specific message -- imagePaste's own list keeps accumulating
			// across turns (see ui/image-paste.js), so this snapshot is what
			// distinguishes "attached to THIS message" from "currently
			// sitting in the attach tray for the next one".
			let pastedImageDataUris = imagePaste.getDataUris();
			if (pastedImageDataUris.length) {
				chat.appendImages(userReply, pastedImageDataUris);
			}

			// Visible placeholder, shown immediately -- BEFORE context-building
			// (table/figure/equation/note/reference extraction+selection, or
			// even the embedding recompute below, all of which can take a
			// while) rather than only once it finishes -- updated to
			// "Waiting for ..." right before the actual model call starts
			// (see below), then filled with streamed tokens once the reply
			// actually begins. Created with an empty timestamp (see
			// ui/chat.js's appendMessage/setMessageTime) -- set to the real
			// completion time only once the full response has actually
			// streamed in below, not here, so the bubble doesn't show a
			// misleadingly-early time for a reply that can take several
			// seconds to finish.
			let reply = appendMessage(replyLabel, "Building context...", "");

			// Jump to the next event loop step for UI updates -- without
			// this, the two DOM appends above don't actually paint until
			// something ELSE yields long enough for a repaint, which (once
			// context-building/embedding recompute is largely local
			// microtask work) can end up being the first streamed token
			// from the model, making the "You" bubble appear to sit there
			// un-rendered for the whole request. Same idiom Zotero core
			// itself uses for this (see e.g. integration.js's own "Jump to
			// next event loop step for UI updates" comments).
			await Zotero.Promise.delay();
			if (isCancelled()) return;

			let activePDFItem = chatPane.getActiveReaderAttachment();
			let pendingCacheLabels = activePDFItem ? LLMPrompt.consumePendingCacheRecompute(activePDFItem) : null;
			if (pendingCacheLabels) {
				let labelsText = pendingCacheLabels.length ? pendingCacheLabels.join(", ") : "selected";
				appendMessage("System", `Recomputing ${labelsText} cache${pendingCacheLabels.length === 1 ? "" : "s"} for this PDF (triggered by Clear Cache).`);
			}

			// Posted (to Logs, since role "System" routes there -- see
			// appendMessage below) AND mirrored onto the reply bubble itself
			// (so a slow embedding recompute is visible in the actual
			// conversation, not just the Logs panel) -- only when a cache
			// miss/staleness actually forces embeddings to be recomputed
			// (e.g. after switching providers in Advanced settings), not on
			// every request -- see citation.js's getTextIndex/
			// document/figures.js's getFigureIndex, which both only call
			// this on that path. `setProgress(current, total)` is called
			// once per item as recomputation runs -- the Logs line gets the
			// full "[bar] current/total (pct%)" (see LLMCitation.
			// _formatProgressBar), but the reply bubble gets just the bare
			// percentage, since a full text progress bar reads poorly
			// inside a chat message. `textContent` (get/set) is for the
			// start/completion lines, which are identical in both places.
			let onEmbeddingStart = (provider, model) => {
				let baseText = `Recomputing embeddings using ${provider} ${model}...`;
				let logEl = appendMessage("System", baseText);
				chat.updateMessageText(reply, baseText);
				return {
					get textContent() { return logEl.textContent; },
					set textContent(text) {
						logEl.textContent = text;
						chat.updateMessageText(reply, text);
					},
					setProgress(current, total) {
						let pct = total > 0 ? Math.round((current / total) * 100) : 0;
						logEl.textContent = `${baseText} ${LLMCitation._formatProgressBar(current, total)}`;
						chat.updateMessageText(reply, `${baseText} ${pct}%`);
					},
				};
			};
			let onStructureMessage = (text) => appendMessage("System", text);
			let { prompt: modelPrompt, systemPrompt, contextInfo, item: pdfItem } = await LLMPrompt.buildPromptWithActivePDFContext(prompt, selectedText, pageText, onEmbeddingStart, onStructureMessage);
			if (isCancelled()) return;
			let tableIndexPromise = pdfItem
				? LLMTables.getTableIndex(pdfItem, onStructureMessage).catch((e) => {
					this.log(`getTableIndex failed: ${e.message}`);
					return { error: e.message };
				})
				: Promise.resolve(null);
			let figureIndexPromise = pdfItem
				? LLMFigures.getFigureIndex(pdfItem, onEmbeddingStart, onStructureMessage).catch((e) => {
					this.log(`getFigureIndex failed: ${e.message}`);
					return null;
				})
				: Promise.resolve(null);
			let referenceIndexPromise = pdfItem
				? LLMReferences.getReferenceIndex(pdfItem, onStructureMessage).catch((e) => {
					this.log(`getReferenceIndex failed: ${e.message}`);
					return null;
				})
				: Promise.resolve(null);
			let equationIndexPromise = pdfItem
				? LLMEquations.getEquationIndex(pdfItem, onStructureMessage).catch((e) => {
					this.log(`getEquationIndex failed: ${e.message}`);
					return { error: e.message };
				})
				: Promise.resolve(null);
			let notesPromise = pdfItem
				? LLMNotes.getNotes(pdfItem).catch((e) => {
					this.log(`getNotes failed: ${e.message}`);
					return [];
				})
				: Promise.resolve([]);
			// Debug/status metadata about the request, not part of the actual
			// message -- logged rather than shown inline in the "You" bubble
			// (which now shows just the raw prompt), same reasoning as every
			// other appendMessage("System", ...) call routing to the Logs
			// panel.
			appendMessage("System", selectedText
				? `Selected Text: "${selectedText.slice(0, 120)}${selectedText.length > 120 ? "…" : ""}"`
				: `Selected Text: (none — ${selectionInfo})`);
			appendMessage("System", pageText
				? `Page Context: page ${pageNum}`
				: `Page Context: (none — ${pageInfo})`);
			appendMessage("System", contextInfo ? `PDF: ${contextInfo.title}` : "PDF: (none)");

			if (contextInfo?.missingText) {
				appendMessage("System", `No extracted text was available for "${contextInfo.title}". Asking without PDF context.`);
			}
			else if (contextInfo) {
				appendMessage(
					"System",
					contextInfo.retrieved
						? `Using PDF context from "${contextInfo.title}" (full PDF too large — showing top ${contextInfo.chunkCount} relevant paragraphs).`
						: `Using PDF context from "${contextInfo.title}" (${contextInfo.charCount} characters${contextInfo.truncated ? ", truncated" : ""}).`
				);
			}
			else {
				appendMessage("System", "No active PDF reader tab found. Asking without PDF context.");
			}

			// Each of these five awaits its own index promise and reports
			// its own status messages -- see each _buildXContext method
			// above for what it does. Run sequentially (not
			// Promise.all'd) since their onProgress-style System messages
			// are meant to appear in the same fixed order every time
			// (table, equation, note, image, reference), for a
			// predictable Logs panel read -- the underlying index
			// promises themselves were already all kicked off in parallel
			// above, so this doesn't serialize the actual extraction
			// work, just the (cheap, already-settled-or-nearly-so)
			// awaiting of it.
			let tableResult = await this._buildTableContext(tableIndexPromise, prompt, readerContext, ctx);
			if (isCancelled()) return;
			modelPrompt += tableResult.addition;

			let equationResult = await this._buildEquationContext(equationIndexPromise, prompt, readerContext, ctx);
			if (isCancelled()) return;
			modelPrompt += equationResult.addition;

			let noteResult = await this._buildNoteContext(notesPromise, prompt, readerContext, ctx);
			if (isCancelled()) return;
			modelPrompt += noteResult.addition;

			let imageResult = await this._buildImageContext(figureIndexPromise, pastedImageDataUris, prompt, readerContext, pdfItem, ctx);
			if (isCancelled()) return;
			let images = imageResult.images;
			modelPrompt += imageResult.addition;

			let referenceResult = await this._buildReferenceContext(referenceIndexPromise, prompt, readerContext, ctx);
			if (isCancelled()) return;
			modelPrompt += referenceResult.addition;

			let crossLibraryResult = await this._buildCrossLibraryContext(prompt, readerContext, pdfItem, contextInfo?.title, ctx);
			if (isCancelled()) return;
			modelPrompt += crossLibraryResult.addition;

			// Lets the model's own text mentions of any extracted table/figure/
			// reference/equation/note (not just the one injected as full context)
			// become clickable links -- see _renderMarkdown's `ref:table:N` /
			// `ref:figure:N` / `ref:reference:N` / `ref:equation:N` /
			// `ref:formula:N` / `ref:note:KEY` handling. Built via
			// LLMPrompt.buildLinkIndex so import (see import.js and
			// chat-pane.js's onImport) can reconstruct identical links
			// for a historical message too, from the same PDF's cached
			// indexes (and, for notes, its still-existing annotations) --
			// see buildLinkIndex's own comment for how.
			let linkIndex = LLMPrompt.buildLinkIndex({
				tableIndex: tableResult.index,
				figureIndex: imageResult.index,
				referenceIndex: referenceResult.index,
				equationIndex: equationResult.index,
				notes: noteResult.notes,
			});

			// `reply` was already created (as "Building context...") right
			// after the "You" bubble above -- just update it now that
			// context-building is done and the actual model call is about
			// to start.
			chat.updateMessageText(reply, `Waiting for ${providerLabel}...`);
			this.log(`Submitting prompt to ${providerLabel}: ${prompt}`);
			reply.textContent = "";

			// Prior turns (see priorTranscript, snapshotted before this
			// turn's own bubbles were appended) plus the current turn's
			// full context-stuffed prompt as the final entry -- "You" ->
			// "user", everything else (a provider/feature reply label) ->
			// "assistant". Which prior entries get included depends on
			// LLMPrompt.useMessageHistory's own 3-way mode (see its own
			// comment): "none" sends no history at all, trading conversation
			// continuity for lower per-request token usage (every past turn
			// otherwise gets resent, in full, on every subsequent request --
			// none of these backends remember anything server-side);
			// "last-k" is a plain recency cutoff (slice(-N), a no-op if
			// there are fewer than N entries to begin with); "semantic"
			// additionally pulls in whichever earlier entries are most
			// relevant to THIS turn's own raw prompt (not modelPrompt --
			// see LLMSemanticHistory.selectRelevant's own call below), via
			// embedding similarity, on top of the same last-K recency cutoff.
			let historyEntries;
			if (LLMPrompt.useMessageHistory === "none") {
				historyEntries = [];
			}
			else if (LLMPrompt.useMessageHistory === "semantic") {
				historyEntries = await LLMSemanticHistory.selectRelevant(
					priorTranscript, prompt, LLMPrompt.maxHistoryMessages, LLMPrompt.maxSemanticHistoryMessages
				).catch((e) => {
					this.log(`selectRelevant failed, falling back to last-k: ${e.message}`);
					return priorTranscript.slice(-LLMPrompt.maxHistoryMessages);
				});
			}
			else {
				// "last-k" (the default), or a stale persisted boolean
				// `true` from before this was a 3-way enum -- see
				// LLMPrompt.applyAdvancedSettingsFor's own migration for why
				// that's not expected to reach here as a raw boolean
				// anymore, but falling through to the same behavior it used
				// to mean either way costs nothing.
				historyEntries = priorTranscript.slice(-LLMPrompt.maxHistoryMessages);
			}
			let messages = historyEntries.map(({ role, text }) => ({ role: role === "You" ? "user" : "assistant", content: text }));
			messages.push({ role: "user", content: modelPrompt });

			let result = await LLMInterfaces.streamModel(messages, (token) => {
				if (!isCancelled()) reply.textContent += token;
			}, {
				onReady(cancelFn) {
					setCancelStream(cancelFn);
				},
				systemPrompt,
			}, images);
			if (isCancelled()) return;
			// Set in both branches below, read once at the unified
			// "turn is complete" point further down (chat.setMessageTime) --
			// see LLMSemanticHistory.embedNewMessage's own call there for why.
			let finalReplyText;
			if (!result.text) {
				reply.textContent = "(No response)";
				chat.setMessageText(reply, "(No response)");
				finalReplyText = "(No response)";
			}
			else {
				let groundedText = LLMCitation.groundCitations(result.text);
				if (isCancelled()) return;
				// Resolves EVERY citation's position in ONE batched call
				// (see document/citations.js's LLMCitationPosition.
				// resolvePositions) before rendering at all -- this is now
				// citation VERIFICATION as much as navigation prefetch (see
				// _renderMarkdown's own comment on citationPositions): a
				// phrase that fails to resolve to a real position anywhere
				// in the PDF's own text gets flagged in the rendered link
				// rather than silently presented as equally trustworthy as
				// a verified one, so this has to happen before render, not
				// after. Awaiting it here is acceptable because the PRIMARY
				// path (exact match against the SDT structure) is fast and
				// in-process for every case except the very first citation
				// ever resolved for a given PDF (which pays the one-time
				// structure computation cost, ONCE per PDF rather than once
				// per request). resolvePositions does still fall back to a
				// (now BATCHED, not sequential) embedding lookup for a
				// citation the exact matcher can't anchor at all -- a
				// genuine paraphrase, which the model is instructed to keep
				// rare by quoting one full verbatim sentence (see
				// llm/prompt.js's citation format instructions) but can't
				// eliminate -- so this can occasionally cost one batched
				// network round trip, not per-citation ones.
				let citationPositions = null;
				if (pdfItem) {
					// Boundary lookahead (matching _renderMarkdown's own
					// regex and citation.js's groundCitations exactly --
					// see either one's comment for why) so a citation
					// phrase that happens to contain a literal ">)" doesn't
					// get truncated at that false terminator. Must extract
					// the SAME payload string _renderMarkdown will (below),
					// or citationPositions' lookup-by-payload silently
					// misses.
					let queries = [...groundedText.matchAll(/\(<find:([\s\S]+?)>\)(?=[\s.,;:!?)\]]|\[|$)/g)].map(m => m[1]);
					if (queries.length) {
						try {
							citationPositions = await LLMCitationPosition.resolvePositions(pdfItem, queries, onEmbeddingStart, onStructureMessage);
						}
						catch (e) {
							this.log(`Citation position resolution failed: ${e.message}`);
						}
					}
				}
				if (isCancelled()) return;
				finalReplyText = groundedText;
				// Keeps chat's own exportTranscript() (see export.js) in sync
				// with the final grounded markdown -- reply's DOM content
				// below ends up as rendered HTML, not something export.js
				// could read back out directly.
				chat.setMessageText(reply, groundedText);
				let html = chatPane._renderMarkdown(groundedText, linkIndex, citationPositions);
				if (html) {
					let rendered = doc.createElement("div");
					// llm-message-content too, not just llm-markdown -- this
					// element replaces the <pre class="llm-message-content">
					// that held the response during streaming (see
					// reply.replaceWith below), and without that class it'd
					// silently lose the "body" background/padding/spacing that
					// class provides once the response finishes streaming and
					// gets swapped from plain text to rendered markdown.
					rendered.className = "llm-markdown llm-message-content";
					try {
						rendered.innerHTML = html;
					}
					catch (e) {
						// Logs the FULL generated HTML string, not just e.message --
						// past occurrences of this exact failure ("innerHTML: An
						// invalid or illegal string was specified") couldn't be
						// pinned down from the error message/stack alone, since it
						// depends on the SPECIFIC content Gecko's parser rejected
						// (seemingly MathML/foreign-content-related, based on prior
						// investigation, but not reproducible via plain string-level
						// testing outside a real Gecko innerHTML parse). Falls back
						// to the unrendered markdown as plain text -- no math/links/
						// formatting, but the user still gets the actual response
						// instead of losing it entirely.
						this.log(`rendered.innerHTML assignment failed: ${e.message}\nFull generated HTML:\n${html}`);
						rendered.textContent = groundedText;
					}
					rendered.addEventListener("click", async (e) => {
						let anchor = e.target.closest(".llm-find-link");
						if (!anchor) return;
						e.preventDefault();
						if (anchor.dataset.annotationKey) {
							LLMCitation.navigateToAnnotation(anchor.dataset.annotationKey);
							return;
						}
						if (anchor.dataset.pageNum) {
							LLMCitation.navigateToPage(parseInt(anchor.dataset.pageNum, 10));
							return;
						}
						if (anchor.dataset.position) {
							try {
								await LLMCitation.navigateToPosition(JSON.parse(anchor.dataset.position));
							}
							catch (err) {
								this.log(`Failed to parse position for link: ${err.message}`);
							}
							return;
						}
							if (anchor.dataset.query) {
								LLMCitation.navigateToText(anchor.dataset.query);
							}
					});
					reply.replaceWith(rendered);
				}
			}
			// Only shown once the reply is actually complete (covers both
			// branches above) -- reply started with an empty timestamp (see
			// its own creation comment). Still resolves correctly even
			// after reply.replaceWith above -- see setMessageTime's own
			// comment in ui/chat.js.
			let finalReplyTime = chat.formatTimestamp();
			chat.setMessageTime(reply, finalReplyTime);
			// Fire-and-forget, same reasoning (and same "semantic" mode
			// gate) as the "You" message's own embedNewMessage call above --
			// replyLabel (not providerLabel) matches the role
			// chat.appendMessage originally stored `reply` under (see its
			// own creation, `appendMessage(replyLabel, ...)`), which is what
			// chat.exportTranscript() will report back for this entry -- the
			// fingerprint here MUST match that exactly, or a later
			// selectRelevant call would never find this embedding.
			if (LLMPrompt.useMessageHistory === "semantic") {
				LLMSemanticHistory.embedNewMessage({ role: replyLabel, time: finalReplyTime, text: finalReplyText });
			}
			this.log(`Received response from ${providerLabel} model ${result.model}`);
		}
		catch (e) {
			if (isCancelled()) return;
			appendMessage(providerLabel, `${providerLabel} request failed: ${e.message}`);
			// reply itself is abandoned on this path (the error message
			// above is a separate, new bubble) -- still give it a real
			// timestamp rather than leaving it blank forever, since it
			// started empty (see its own creation comment) and nothing else
			// on this path will ever set one.
			chat.setMessageTime(reply, chat.formatTimestamp());
			// Only e.message was logged before -- this whole try wraps
			// everything from PDF-context building through table/figure/
			// equation/note extraction, streamModel, citation grounding,
			// and markdown+KaTeX rendering, so without e.stack there was no
			// way to tell WHERE in that chain a given error actually came
			// from.
			this.log(`${providerLabel} request failed: ${e.message}\n${e.stack || "(no stack)"}`);
		}
	},

	// Starts the request. Returns a handle:
	//   promise    -- resolves once the request finishes (successfully,
	//                 with an internally-caught/logged error, or by
	//                 rejecting if cancelled -- see cancel() below)
	//   cancelled  -- true if cancel() was called on this handle
	//   cancel()   -- cancels the in-flight request: stops any active model
	//                 stream, and rejects `promise` (if it hasn't already
	//                 settled) so the caller's await unblocks immediately.
	//                 Whatever step the request was in when cancelled keeps
	//                 running to completion in the background (there's no
	//                 way to hard-abort a Zotero.Translate call or
	//                 HiddenBrowser page load partway through), but it
	//                 checks `cancelled` before doing anything more, so a
	//                 stray message can't land after the caller has already
	//                 shown "Cancelled."
	send(chatPane, prompt, ui) {
		let { doc, appendMessage, makeMessageClickable, chat, imagePaste, takeCapturedSelection } = ui;

		let cancelled = false;
		let cancelStream = null;
		let rejectCancel = null;
		let cancelPromise = new Promise((_, reject) => { rejectCancel = reject; });

		let providerLabel = LLMInterfaces.getProviderLabel(LLMInterfaces._provider);

		// The entire request -- tool-intent lookup or normal chat -- runs
		// inside this one closure so it can be raced against cancelPromise
		// as a whole, rather than needing every internal step to separately
		// understand cancellation.
		let work = (async () => {
			// Captured BEFORE any async work at all (getCurrentModel,
			// detectIntent, PDF-context building, ...) so the "You" bubble
			// -- created further down, sometimes noticeably later, e.g.
			// detectIntent alone is a real LLM call -- can show the EXACT
			// moment the user actually hit submit rather than whenever its
			// own appendMessage call happens to run.
			let submissionTime = chat.formatTimestamp();

			// Resolved up front (rather than only once the reply bubble is
			// about to stream) so it's available immediately both for the
			// reply bubble's title AND for every tool-intent handler's own
			// result messages below, which used to hardcode role "Zotero"
			// instead of showing the actually-active provider/model -- there's
			// no real "Zotero" agent, just this plugin acting on the user's
			// behalf, so it should read the same as any other reply.
			let currentModel = null;
			try {
				currentModel = await LLMInterfaces.getCurrentModel();
			}
			catch (e) {
				this.log(`getCurrentModel failed before creating reply message: ${e.message}`);
			}
			let replyLabel = currentModel ? `${providerLabel} - ${currentModel}` : providerLabel;

			// See the module-level comment for what each field is for --
			// passed to every _handleX method below instead of each one
			// closing over send()'s own locals directly, so they're
			// standalone functions rather than needing to stay nested
			// inside send() itself.
			let ctx = {
				doc,
				appendMessage,
				makeMessageClickable,
				chat,
				imagePaste,
				takeCapturedSelection,
				replyLabel,
				providerLabel,
				submissionTime,
				isCancelled: () => cancelled,
				setCancelStream: (fn) => { cancelStream = fn; },
			};

			// Checked FIRST, before building the (comparatively expensive)
			// full PDF-context prompt -- a "download reference N"/"link
			// reference N"/"export table N as CSV" request short-circuits
			// the normal chat flow entirely, since the main model has
			// nothing useful to add to a request this specific.
			// LLMIntent.detectIntent (see llm/intent.js) owns deciding WHICH of
			// the three tools (if any) applies, via native tool-calling.
			try {
				let detected = await LLMIntent.detectIntent(prompt, (msg) => {
					if (cancelled) return;
					appendMessage("System", msg);
				});
				if (cancelled) return;
				if (detected !== null) {
					let { tool, intent } = detected;
					appendMessage("You", prompt, submissionTime);
					let pdfItem = chatPane.getActiveReaderAttachment();
					if (!pdfItem) {
						appendMessage("System", "No active PDF to look up references from.");
						return;
					}

					// The user's own current reader page -- see
					// _resolveIntentIndices' own comment for why. Fetched
					// here rather than reusing _handleNormalChat's own
					// getReaderPageText() call, since the two paths are
					// mutually exclusive per request (a tool-intent match
					// returns before _handleNormalChat would ever run), so
					// there's no actual double-fetch in practice.
					let { pageNum } = await chatPane.getReaderPageText();
					if (cancelled) return;

					// Resolves `intent` down to a concrete list of numbers --
					// see _resolveIntentIndices above, shared regardless of
					// which tool matched (against the bibliography for
					// download/link, the extracted tables for tables).
					let indices = await this._resolveIntentIndices(tool, intent, pdfItem, pageNum);
					if (cancelled) return;

					let noun = tool === "tables" ? "tables" : "references";
					if (!indices || !indices.length) {
						appendMessage("System", intent.description
							? `Could not find any ${noun} matching "${intent.description}" in this paper.`
							: `Could not find any matching ${noun} in this paper.`);
						return;
					}

					if (tool === "tables") {
						await this._handleTableExport(indices, pdfItem, ctx);
					}
					else if (tool === "download") {
						await this._handleDownload(indices, pdfItem, chatPane, ctx);
					}
					else {
						await this._handleLink(indices, pdfItem, chatPane, ctx);
					}
					return;
				}
			}
			catch (e) {
				if (cancelled) return;
				this.log(`LLMIntent.detectIntent failed: ${e.message}`);
				appendMessage("System", `Tool lookup failed: ${e.message}`);
				return;
			}

			await this._handleNormalChat(prompt, chatPane, ctx);
		})();

		return {
			promise: Promise.race([work, cancelPromise]),
			get cancelled() {
				return cancelled;
			},
			cancel() {
				cancelled = true;
				cancelStream?.();
				rejectCancel?.(new Error("Cancelled"));
			},
		};
	},
};
