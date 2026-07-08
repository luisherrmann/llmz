// The Submit/Stop/Clear Cache button row (plus ui/image-paste.js's own
// "Discard All" button, appended at the same fixed position it held before
// this split -- between Stop and Clear Cache). Split out of
// llm-chat-pane.js's onRender for the same reason as the other ui/ modules.
//
// Submit/Stop's actual click BEHAVIOR is deliberately NOT wired up here --
// it's tightly coupled to the request/cancellation state machine in
// llm-chat-pane.js's submit handler (cancelStream/cancelled/rejectCancel/
// history), which this module has no business knowing about. This module
// only creates the buttons and hands them back for the caller to attach
// listeners to and toggle .disabled on. Clear Cache's and Export's handlers
// ARE self-contained (LLMTables/LLMFigures/LLMEquations/LLMReferences.
// clearCache + a status message; LLMExport.exportConversation + a status
// message), so they're wired up here directly. Import's is NOT -- rebuilding
// the conversation from an imported file needs the same table/figure/
// reference/equation link-resolution context a live request does (see
// llm-chat-pane.js's onImport), which is exactly the kind of business logic
// this module otherwise stays out of.
LLMUIButtonRow = {
	// `getActiveItem()` resolves the PDF attachment to clear cache for /
	// export against (the caller's LLMChatPane.getActiveReaderAttachment()).
	// `onMessage(text)` is called for user-facing status text -- routing
	// this (e.g. to the Logs panel) is the caller's concern, not this
	// module's. `getTranscript()` returns the current conversation as
	// [{ role, text }] (see ui/chat.js's exportTranscript()), for Export.
	// `onImport()` is called on an Import click -- everything else is the
	// caller's concern.
	create(doc, { getActiveItem, onMessage, discardImagesButton, getTranscript, onImport } = {}) {
		let submitButton = doc.createElement("button");
		submitButton.textContent = "Submit";
		submitButton.className = "llm-submit";
		submitButton.title = "Submit (⌘ ⇧ Return)";

		let stopButton = doc.createElement("button");
		stopButton.textContent = "Stop";
		stopButton.className = "llm-stop";
		stopButton.disabled = true;
		stopButton.title = "Stop (⌘ ⇧ ⌫)";

		// Debug affordance: drops the memory+disk cache for tables/figures/
		// equations/references on the active PDF (see each module's own
		// clearCache()), so the next submitted prompt re-runs extraction from
		// scratch instead of reusing whatever was cached from a prior run --
		// useful when a bundled extraction script has changed in a way
		// _scriptFingerprint() doesn't catch, or just to force a clean
		// re-extraction while debugging.
		let clearCacheButton = doc.createElement("button");
		clearCacheButton.textContent = "Clear Cache";
		clearCacheButton.className = "llm-clear-cache";
		clearCacheButton.title = "Clear cached table/figure/equation/reference extraction for this PDF";
		clearCacheButton.addEventListener("click", async () => {
			let item = getActiveItem?.();
			if (!item) {
				onMessage?.("Clear Cache: no active PDF.");
				return;
			}
			await Promise.all([
				LLMTables.clearCache(item),
				LLMFigures.clearCache(item),
				LLMEquations.clearCache(item),
				LLMReferences.clearCache(item),
			]);
			onMessage?.("Cleared extraction cache for the active PDF. The next prompt will re-run extraction from scratch.");
		});

		// Exports the visible conversation (see ui/chat.js's
		// exportTranscript()) as a Markdown file -- prompts for a save
		// location via LLMExport.exportConversation's own file picker
		// (defaulting to $HOME/Zotero/zllm/chats/<item key>_<ddmmyy>.md), so
		// nothing more is needed here than gathering the inputs and
		// reporting how it went.
		let exportButton = doc.createElement("button");
		exportButton.textContent = "Export";
		exportButton.className = "llm-export";
		exportButton.title = "Export this conversation as Markdown";
		exportButton.addEventListener("click", async () => {
			let item = getActiveItem?.();
			if (!item) {
				onMessage?.("Export: no active PDF.");
				return;
			}
			try {
				let result = await LLMExport.exportConversation(item, getTranscript?.() || []);
				if (!result.cancelled) {
					onMessage?.(`Exported conversation to ${result.path}`);
				}
			}
			catch (e) {
				onMessage?.(`Export failed: ${e.message}`);
			}
		});

		// Imports a conversation previously written by Export, REPLACING
		// whatever's currently in the conversation area -- see
		// llm-chat-pane.js's onImport for the actual file-picking/parsing/
		// rebuilding.
		let importButton = doc.createElement("button");
		importButton.textContent = "Import";
		importButton.className = "llm-import";
		importButton.title = "Import a previously exported conversation, replacing the current one";
		importButton.addEventListener("click", () => onImport?.());

		let element = doc.createElement("div");
		element.className = "llm-button-row";
		element.append(submitButton, stopButton, discardImagesButton, clearCacheButton, exportButton, importButton);

		return { element, submitButton, stopButton, clearCacheButton, exportButton, importButton };
	},
};
