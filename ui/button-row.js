// Two button rows: `element` (Submit/Stop, plus ui/image-paste.js's own
// "Discard All" button), placed under the Prompt textarea, and `messagesRow`
// (Clear/Export/Import), placed right under the Messages header instead --
// see llm-chat-pane.js's onRender, which places the two in different parts
// of the layout despite both being built here together. Split out of
// llm-chat-pane.js's onRender for the same reason as the other ui/ modules.
// Clear Cache moved to ui/advanced.js (it's a debug/maintenance action, not
// a per-message one) -- not built here anymore.
//
// Submit/Stop's actual click BEHAVIOR is deliberately NOT wired up here --
// it's tightly coupled to the request/cancellation state machine in
// llm-chat-pane.js's submit handler (cancelStream/cancelled/rejectCancel/
// history), which this module has no business knowing about. This module
// only creates the buttons and hands them back for the caller to attach
// listeners to and toggle .disabled on. Export's handler IS self-contained
// (LLMExport.exportConversation + a status message), so it's wired up here
// directly. Import's is NOT -- rebuilding the conversation from an imported
// file needs the same table/figure/reference/equation link-resolution
// context a live request does (see llm-chat-pane.js's onImport), which is
// exactly the kind of business logic this module otherwise stays out of.
LLMUIButtonRow = {
	// `getActiveItem()` resolves the PDF attachment to clear cache for /
	// export against (the caller's LLMChatPane.getActiveReaderAttachment()).
	// `onMessage(text)` is called for user-facing status text -- routing
	// this (e.g. to the Logs panel) is the caller's concern, not this
	// module's. `getTranscript()` returns the current conversation as
	// [{ role, text }] (see ui/chat.js's exportTranscript()), for Export.
	// `onImport()` is called on an Import click -- everything else is the
	// caller's concern. `onExported()` is called after a successful (not
	// cancelled) Export -- the caller uses this to refresh
	// ui/past-conversations.js's table, which this module has no
	// business knowing about directly. `onClearConversation()` is called on
	// a Clear click -- wired directly to ui/chat.js's clear(), which this
	// module doesn't hold a reference to itself. `sendIconURL`/
	// `cancelIconURL`/`uploadIconURL`/`fileExportIconURL`/`clearAllIconURL`
	// are plain file:/jar: URLs (see llm-chat-pane.js's onRender, rootURI +
	// "icons/...svg"), rendered via LLMUIIcon.create -- `uploadIconURL`
	// covers Import (same icon LLMUIConversationHistory's Load button uses,
	// per the same "bringing something INTO the current view" idea).
	create(doc, { getActiveItem, onMessage, discardImagesButton, getTranscript, onImport, onExported, onClearConversation, sendIconURL, cancelIconURL, uploadIconURL, fileExportIconURL, clearAllIconURL } = {}) {
		let submitButton = doc.createElement("button");
		submitButton.className = "llm-submit";
		submitButton.title = "Submit (⌘ ⇧ Return)";
		submitButton.append(LLMUIIcon.create(doc, sendIconURL), doc.createTextNode("Submit"));

		let stopButton = doc.createElement("button");
		stopButton.className = "llm-stop";
		stopButton.disabled = true;
		stopButton.title = "Stop (⌘ ⇧ ⌫)";
		stopButton.append(LLMUIIcon.create(doc, cancelIconURL), doc.createTextNode("Stop"));

		// Wipes the visible conversation (see ui/chat.js's clear()) back to
		// the "No messages loaded yet..." placeholder state -- does NOT
		// touch any saved file on disk, so this is purely "start a fresh
		// conversation in the pane", distinct from Delete on a
		// ui/past-conversations.js card (which DOES remove a file).
		let clearConversationButton = doc.createElement("button");
		clearConversationButton.className = "llm-clear-conversation";
		clearConversationButton.title = "Clear the current conversation (does not delete any saved file)";
		clearConversationButton.append(LLMUIIcon.create(doc, clearAllIconURL), doc.createTextNode("Clear"));
		clearConversationButton.addEventListener("click", () => onClearConversation?.());

		// Exports the visible conversation (see ui/chat.js's
		// exportTranscript()) as a Markdown file -- prompts for a save
		// location via LLMExport.exportConversation's own file picker
		// (defaulting to $HOME/Zotero/zllm/chats/<item key>/<ddmmyy>_<NNN>.md),
		// so nothing more is needed here than gathering the inputs and
		// reporting how it went. onExported() fires after a
		// successful (not cancelled) save, whether that wrote a brand new
		// file or overwrote an existing one -- either way, the on-disk
		// conversation list for this PDF just changed.
		let exportButton = doc.createElement("button");
		exportButton.className = "llm-export";
		exportButton.title = "Export this conversation as Markdown";
		exportButton.append(LLMUIIcon.create(doc, fileExportIconURL), doc.createTextNode("Export"));
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
					onExported?.();
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
		importButton.className = "llm-import";
		importButton.title = "Import a previously exported conversation, replacing the current one";
		importButton.append(LLMUIIcon.create(doc, uploadIconURL), doc.createTextNode("Import"));
		importButton.addEventListener("click", () => onImport?.());

		let element = doc.createElement("div");
		element.className = "llm-button-row";
		element.append(submitButton, stopButton, discardImagesButton);

		// Clear/Export/Import -- placed under the Messages header instead
		// (see llm-chat-pane.js's onRender), not alongside Submit/Stop above.
		let messagesRow = doc.createElement("div");
		messagesRow.className = "llm-button-row llm-messages-actions-row";
		messagesRow.append(clearConversationButton, exportButton, importButton);

		return { element, messagesRow, submitButton, stopButton, clearConversationButton, exportButton, importButton };
	},
};
