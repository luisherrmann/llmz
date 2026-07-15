// "Index All" -- runs the full extraction pipeline (tables, figures,
// references, equations, citation/paragraph embeddings) for a PDF
// attachment, so a user can pre-warm a paper's caches in one go instead of
// paying the extraction cost the first time they ask a question about it.
//
// _indexItem (the actual per-paper extraction work) is reused directly by
// ui/advanced.js's Cache section "Index All" button, which runs it over
// just the currently-UNINDEXED papers in "My Library" and reports progress
// through the Cache section's own "Library index status" bar -- see
// advanced.js's own comment for why that button doesn't call run() below.
//
// run()/_showProgressOverlay (the rest of this file) is a separate,
// still-available whole-overlay flow -- re-indexes EVERY PDF unconditionally
// (not just unindexed ones), via a fixed-position overlay built directly
// into the item pane's own document (see _showProgressOverlay) plus a
// live-updating Logs panel line, rather than a separate top-level window --
// four different window-opening approaches were tried and abandoned (see
// _showProgressOverlay's own comment) before settling on this. Not
// currently wired to a button anywhere.
LLMUIIndexAll = {
	// Papers indexed at once -- same worker-pool concurrency pattern as
	// LLMCitation.embedBatched's own concurrent batch submission (see its
	// own comment), applied here one level up: each paper's own embedding
	// calls (getTextIndex, latency-bound network round-trips) benefit from
	// overlapping several papers' pipelines
	// rather than sitting fully idle between one paper's own sequential
	// steps. Lowered from 8 to 4 -- fewer PDFs open at once through
	// whatever native path LLMPrompt.getAttachmentFullText's PDFWorker
	// fallback goes through, as a lever against macOS's CGPDFService
	// process's memory growth over a long Index All run (see
	// ui/advanced.js's runIndexAll, which also periodically nudges Gecko's
	// own memory-pressure observers). Trades some wall-clock time for
	// that -- being tried out to see how much it actually costs in
	// practice before deciding whether it's worth keeping permanently.
	CONCURRENCY_LEVEL: 4,

	log(msg) {
		Zotero.debug("LLM Chat Pane [IndexAll]: " + msg);
	},

	// Every top-level item in "My Library" that either IS a PDF attachment
	// itself (a standalone/loose PDF, no parent item) or whose own best
	// attachment is one (the common case: a regular item, e.g. a
	// journalArticle, with an attached PDF) -- same
	// getBestAttachment()/isPDFAttachment() combination already used
	// elsewhere in this plugin (see tools/reference-retrieval.js's
	// downloadReferenceToLibrary). Deliberately scoped to "My Library"
	// only (Zotero.Libraries.userLibraryID), not group libraries, matching
	// this feature's own description.
	async _getPDFItems() {
		let topLevelItems = await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, true, false, false);
		let pdfItems = [];
		for (let item of topLevelItems) {
			if (item.isAttachment()) {
				if (item.isPDFAttachment()) pdfItems.push(item);
				continue;
			}
			if (!item.isRegularItem()) continue;
			let attachment = await item.getBestAttachment();
			if (attachment?.isPDFAttachment()) pdfItems.push(attachment);
		}
		return pdfItems;
	},

	// A PDF attachment's OWN title/filename rarely reads as well as its
	// parent (regular) item's actual paper title -- preferred here purely
	// for a more recognizable progress-window label, not used anywhere
	// extraction-related.
	_labelFor(item) {
		return item.parentItem?.getField("title") || item.getField("title") || item.libraryKey;
	},

	// Runs every extraction step for one PDF attachment -- same set of
	// calls (and the same "one failure doesn't abort the others" via
	// individual .catch()) as llm/request.js's own live-request path, minus
	// LLMNotes (not an extraction step at all -- getNotes just reads
	// existing Zotero annotations, nothing to pre-warm) and minus actually
	// building a prompt: buildPromptWithActivePDFContext is tied to
	// LLMChatPane.getActiveReaderAttachment() (the CURRENTLY open reader
	// tab), not usable for an arbitrary background item, so the text index
	// is built directly here instead via LLMPrompt.getAttachmentFullText +
	// LLMCitation.getTextIndex, which takes `item` as an explicit parameter
	// rather than reading the active reader themselves.
	// Never throws -- returns { ok: true } or { ok: false, error }, so the
	// caller's batch loop doesn't need its own try/catch per item.
	// `onMessage`, if given, is forwarded to getTextIndex/getFigureIndex
	// purely so their own embeddings.sqlite sync (see citation.js's/
	// figures.js's own comments) has somewhere to report a visible
	// confirmation line -- everything else here stays on the Debug-Output-
	// only this.log() it already used.
	async _indexItem(item, onMessage) {
		try {
			let text = await LLMPrompt.getAttachmentFullText(item);
			if (text.trim()) {
				// getTextIndex always builds BOTH sentence and paragraph
				// chunks/embeddings together (see citation.js's own comment) --
				// unlike buildPromptWithActivePDFContext's own chunking
				// condition (which only retrieves paragraph-level chunks for
				// THIS paper's own single-paper context when its full text
				// exceeds maxPDFContextChars -- a short paper just gets shown
				// in full there, no retrieval needed), the paragraph half is
				// still built here regardless of paper length, since
				// LLMCitation.getCrossLibraryChunks (cross-library retrieval,
				// see llm/prompt.js's shouldIncludeCrossLibraryWithLLM) only
				// ever searches source:"paragraph" embeddings -- confirmed
				// concretely that gating this the same way as the single-
				// paper path left every paper short enough to fit under
				// maxPDFContextChars permanently unfindable via cross-library
				// search, even after a full (re-)index. Indexing (this
				// function, via either "Index" or "Index All") is exactly the
				// place that should pre-warm for BOTH use cases, not just the
				// single-paper one.
				await LLMCitation.getTextIndex(item, text, undefined, onMessage).catch((e) => {
					this.log(`getTextIndex failed for ${item.libraryKey}: ${e.message}`);
				});
			}
			await Promise.all([
				LLMTables.getTableIndex(item).catch((e) => this.log(`getTableIndex failed for ${item.libraryKey}: ${e.message}`)),
				LLMFigures.getFigureIndex(item, undefined, onMessage).catch((e) => this.log(`getFigureIndex failed for ${item.libraryKey}: ${e.message}`)),
				LLMReferences.getReferenceIndex(item).catch((e) => this.log(`getReferenceIndex failed for ${item.libraryKey}: ${e.message}`)),
				LLMEquations.getEquationIndex(item).catch((e) => this.log(`getEquationIndex failed for ${item.libraryKey}: ${e.message}`)),
			]);
			return { ok: true };
		}
		catch (e) {
			this.log(`_indexItem failed for ${item.libraryKey}: ${e.message}`);
			return { ok: false, error: e.message };
		}
	},

	_formatDuration(ms) {
		let totalSeconds = Math.round(ms / 1000);
		let minutes = Math.floor(totalSeconds / 60);
		let seconds = totalSeconds % 60;
		if (minutes === 0) return `${seconds}s`;
		return `${minutes}m ${seconds}s`;
	},

	// Four separate attempts at a genuinely SEPARATE top-level window
	// (Services.ww.openWindow with "about:blank"; the same plus a data: URI;
	// a plain win.open(); openDialog loading a real packaged XUL file, the
	// same call Zotero's own Zotero.ProgressWindow.show() uses) all either
	// rendered blank or opened nothing at all, with no clear signal why --
	// this environment (a bootstrapped, unpacked-at-runtime XPI) may simply
	// not support opening a new top-level window the way a restart-installed
	// extension with a registered chrome.manifest can. Rather than keep
	// guessing at window-opening mechanics, this builds a fixed-position
	// overlay directly into `doc` -- the SAME document reference
	// ui/advanced.js already builds every other Cache-section element into,
	// proven reliable for the entirety of this plugin's own UI throughout
	// this whole codebase. No window API of any kind is involved.
	//
	// `cancelIconURL` is a plain file:/jar: URL (see chat-pane.js's
	// onRender, rootURI + "res/icons/cancel_*.svg"), rendered via LLMUIIcon.create
	// -- same "cancel" icon ui/button-row.js's own Stop button uses.
	// Returns { setTotal(total), update(current, label), finish(summaryText),
	// error(message), isClosed() } -- `isClosed()` is polled between items
	// by run() below as a cancellation signal. The button (Cancel while
	// running, Close once finished/errored/cancelled) always removes the
	// overlay IMMEDIATELY on click, regardless of which state it's in --
	// run()'s own loop notices isClosed() and stops itself on its own time
	// (it can't abort whichever item is already mid-extraction), but the
	// overlay itself shouldn't visibly linger waiting for that.
	_showProgressOverlay(doc, cancelIconURL) {
		let backdrop = doc.createElement("div");
		backdrop.className = "llm-index-all-backdrop";
		let card = doc.createElement("div");
		card.className = "llm-index-all-card";
		let title = doc.createElement("h2");
		title.textContent = "Preparing…";
		let track = doc.createElement("div");
		track.className = "llm-index-all-track";
		let fill = doc.createElement("div");
		fill.className = "llm-index-all-fill";
		track.appendChild(fill);
		let status = doc.createElement("div");
		status.className = "llm-index-all-status";
		status.textContent = "Scanning My Library for PDFs…";
		let eta = doc.createElement("div");
		eta.className = "llm-index-all-eta";
		let cancelButton = doc.createElement("button");
		let cancelButtonLabel = doc.createTextNode("Cancel");
		cancelButton.append(LLMUIIcon.create(doc, cancelIconURL), cancelButtonLabel);
		card.append(title, track, status, eta, cancelButton);
		backdrop.appendChild(card);
		(doc.body || doc.documentElement).appendChild(backdrop);

		let cancelled = false;
		// Resolves the instant Cancel is clicked -- run() below races this
		// against the whole worker pool finishing, so cancelling doesn't
		// block on whichever items are still mid-extraction (there's no
		// cheap way to forcibly abort those -- see run()'s own comment).
		let resolveCancelPromise;
		let cancelPromise = new Promise((resolve) => { resolveCancelPromise = resolve; });
		cancelButton.addEventListener("click", () => {
			cancelled = true;
			backdrop.remove();
			resolveCancelPromise();
		});

		let total = 0;
		let startTime = null;
		return {
			setTotal(t) {
				total = t;
				startTime = Date.now();
				title.textContent = "Indexing library…";
				status.textContent = `0 / ${total}`;
			},
			update(current, currentLabel) {
				let pct = total > 0 ? Math.round((current / total) * 100) : 0;
				fill.style.width = `${pct}%`;
				// Full label kept in the title attribute (a native hover
				// tooltip) even though the visible text itself is clipped
				// with an ellipsis by .llm-index-all-status's own CSS (fixed
				// card width, see style.css) -- long paper titles shouldn't
				// resize the card on every item.
				let statusText = `${current} / ${total}${currentLabel ? ` — ${currentLabel}` : ""}`;
				status.textContent = statusText;
				status.title = statusText;
				if (current > 0 && startTime) {
					let elapsed = Date.now() - startTime;
					let remaining = Math.max(0, (elapsed / current) * (total - current));
					eta.textContent = `Estimated time remaining: ${LLMUIIndexAll._formatDuration(remaining)}`;
				}
			},
			finish(summaryText) {
				title.textContent = "Indexing complete";
				fill.style.width = "100%";
				status.textContent = summaryText;
				status.title = summaryText;
				eta.textContent = "";
				cancelButtonLabel.textContent = "Close";
			},
			error(message) {
				title.textContent = "Indexing failed";
				status.textContent = message;
				status.title = message;
				eta.textContent = "";
				cancelButtonLabel.textContent = "Close";
			},
			cancelledState(message) {
				title.textContent = "Indexing cancelled";
				status.textContent = message;
				status.title = message;
				eta.textContent = "";
				cancelButtonLabel.textContent = "Close";
			},
			isClosed() { return cancelled; },
			cancelPromise,
		};
	},

	// Entry point -- called from ui/advanced.js's "Index all" button.
	// `doc` is the item pane's own document (same one every other Cache-
	// section element is built into), used to host the progress overlay --
	// see _showProgressOverlay's own comment for why this replaced a
	// separate window. `onMessage(text)` is called for user-facing status
	// text -- routed by the caller to the Logs panel (ui/advanced.js passes
	// `(text) => appendMessage("System", text)`), same as the rest of the
	// Cache section's own actions. Its RETURN VALUE is used here too, not
	// just its side effect: chat-pane.js's appendMessage passes through
	// whatever logs.appendMessage(text) itself returns -- the log entry's
	// own content <span> -- so holding onto it and setting .textContent
	// repeatedly turns one log line into a live-updating progress display,
	// exactly the same pattern llm/request.js's onEmbeddingStart already uses
	// for embedding-recompute progress (LLMCitation._formatProgressBar
	// reused here verbatim, per the same idea: `[████░░░░] 4/20 (20%)`).
	// Progress is shown in both places at once -- the overlay and one
	// live-updating Logs panel line -- so it's still visible from the Logs
	// panel if the overlay ever gets dismissed early.
	//
	// Up to CONCURRENCY_LEVEL papers are indexed at once, via the same
	// shared-cursor worker-pool pattern as LLMCitation.embedBatched (see its
	// own comment) -- `nextIndex` is a plain shared counter, safe without
	// locking since JS is single-threaded and the increment happens with no
	// `await` in between, and `completed`/`succeeded`/`failed` are only ever
	// updated AFTER an item's own extraction finishes, one worker at a time,
	// for the same reason. Progress updates reflect the most recently
	// COMPLETED item, not "about to start" as the old sequential version
	// showed -- with several papers in flight at once, there's no single
	// well-defined "current" item to show before the fact.
	//
	// Wrapped in one try/catch around the ENTIRE run (not just the library
	// scan) so ANY failure always surfaces via onMessage instead of
	// becoming a silent unhandled rejection the button's own .finally()
	// would otherwise mask.
	async run(doc, onMessage, cancelIconURL) {
		let progress = this._showProgressOverlay(doc, cancelIconURL);
		try {
			let items = await this._getPDFItems();
			if (!items.length) {
				onMessage?.("Index All: no PDFs found in My Library.");
				progress.error("No PDFs found in My Library.");
				return;
			}

			let baseText = `Index All: indexing ${items.length} PDF${items.length === 1 ? "" : "s"} from My Library (up to ${this.CONCURRENCY_LEVEL} at once)…`;
			let logEl = onMessage?.(baseText);
			progress.setTotal(items.length);
			let startTime = Date.now();
			let succeeded = 0, failed = 0, completed = 0;
			let nextIndex = 0;

			let worker = async () => {
				while (nextIndex < items.length) {
					// Stops picking up NEW items once cancelled -- but an
					// item already grabbed by a worker still runs to
					// completion in that worker's own background loop (see
					// the Promise.race below for why run() itself doesn't
					// wait around for that).
					if (progress.isClosed()) return;
					let item = items[nextIndex++];
					let result = await this._indexItem(item, onMessage);
					if (result.ok) succeeded++;
					else failed++;
					completed++;
					let label = this._labelFor(item);
					progress.update(completed, label);
					if (logEl) {
						let eta = completed > 0 ? ` — est. ${this._formatDuration((Date.now() - startTime) / completed * (items.length - completed))} remaining` : "";
						logEl.textContent = `${baseText} ${LLMCitation._formatProgressBar(completed, items.length)}${eta} — ${label}`;
					}
				}
			};
			let workerPoolPromise = Promise.all(Array.from({ length: Math.min(this.CONCURRENCY_LEVEL, items.length) }, () => worker()));
			// Races the whole worker pool finishing against the user
			// clicking Cancel, rather than always `await`ing the pool
			// directly -- there's no cheap way to forcibly abort an
			// in-flight extraction (LLMPrompt.getAttachmentFullText/
			// LLMCitation.getTextIndex/etc. would all need
			// AbortController plumbing threaded through every network call
			// and subprocess spawn they make, a much bigger change), so
			// cancelling here means DISCARDING whichever items are already
			// mid-extraction -- letting them keep running unobserved in the
			// background -- rather than blocking run()'s own return (and
			// therefore the Index All button's re-enable) on them. They
			// still populate their own caches normally when they finish;
			// nothing here waits for or reports on them past this point.
			let outcome = await Promise.race([
				workerPoolPromise.then(() => "done"),
				progress.cancelPromise.then(() => "cancelled"),
			]);
			if (outcome === "cancelled") {
				workerPoolPromise.catch((e) => this.log(`run: a background worker failed after cancellation: ${e.message}`));
				let cancelMsg = `Cancelled after ${completed} / ${items.length} items (any still in-flight are being discarded).`;
				progress.cancelledState(cancelMsg);
				if (logEl) logEl.textContent = `${baseText} ${cancelMsg}`;
				else onMessage?.(`Index All: ${cancelMsg}`);
				return;
			}

			let summary = `Indexed ${succeeded} / ${items.length} PDFs${failed ? ` (${failed} failed -- see Logs/console for details)` : ""}.`;
			progress.finish(summary);
			if (logEl) logEl.textContent = `Index All: ${summary}`;
			else onMessage?.(`Index All: ${summary}`);
		}
		catch (e) {
			this.log(`run: failed: ${e.stack || e.message}`);
			onMessage?.(`Index All: failed (${e.message}).`);
			progress.error(e.message);
		}
	},
};
