// The collapsible "History" panel: a fixed-height, independently scrolling
// list of cards, one per conversation previously saved (via Export -- see
// export.js/ui/conversation-history.js) for the active PDF, one .md file per
// card under $HOME/Zotero/zllm/chats/<PDF_ID>/. Split out of
// llm-chat-pane.js's onRender for the same reason as the other ui/ modules.
LLMUIConversationHistory = {
	// `onLoad(conversation)` is called on a card's Load click -- rebuilding
	// the chat pane's message list from an arbitrary saved file needs the
	// same table/figure/reference/equation link-resolution context a live
	// request does (see llm-chat-pane.js's loadTranscriptIntoChat), which is
	// exactly the kind of business logic this module otherwise stays out of
	// -- same rationale as ui/button-row.js's Import staying uninvolved in
	// that logic. Delete, by contrast, IS handled directly here (just a
	// file removal + removing the card from the DOM), since it doesn't need
	// any context this module doesn't already have.
	create(doc, { onLoad } = {}) {
		let details = doc.createElement("details");
		details.className = "llm-history-details";
		let summary = doc.createElement("summary");
		summary.textContent = "History";
		let body = doc.createElement("div");
		body.className = "llm-history-body";

		// Fixed-height, independently scrolling container (see style.css's
		// .llm-history-scroll) -- so a long history doesn't grow the whole
		// item-pane section along with it, same technique as ui/logs.js's
		// .llm-logs-body.
		let list = doc.createElement("div");
		list.className = "llm-history-scroll";

		body.appendChild(list);
		details.append(summary, body);

		// Same dummy-element treatment as ui/chat.js's own "No messages
		// loaded yet..." placeholder (same CSS class, so it looks and reads
		// identically) -- shown whenever the list has no cards in it,
		// whether that's render() being handed an empty conversations array
		// or the delete handler below removing the last remaining card.
		let showEmptyPlaceholder = () => {
			let empty = doc.createElement("div");
			empty.className = "llm-message-placeholder";
			empty.textContent = "No conversations saved yet...";
			list.appendChild(empty);
		};

		// Builds one card for `conv` (see ui/conversation-history.js's
		// listConversations: { filename, path, preview, started, saved,
		// length }) -- any field the source file didn't have comes back as
		// the literal string "UNKNOWN" from that same call, and is shown
		// as-is here rather than specially handled.
		let createCard = (conv) => {
			let card = doc.createElement("div");
			card.className = "llm-history-card";

			let header = doc.createElement("div");
			header.className = "llm-history-header";
			let titleEl = doc.createElement("span");
			titleEl.className = "llm-history-title";
			titleEl.textContent = conv.filename;
			let metaEl = doc.createElement("span");
			metaEl.className = "llm-history-meta";
			metaEl.textContent = `Started: ${conv.started}   Last: ${conv.saved}   Prompts: ${conv.length}`;
			header.append(titleEl, metaEl);

			let previewEl = doc.createElement("div");
			previewEl.className = "llm-history-preview";
			previewEl.textContent = conv.preview;

			let actions = doc.createElement("div");
			actions.className = "llm-history-actions";

			let loadButton = doc.createElement("button");
			loadButton.textContent = "Load";
			loadButton.className = "llm-history-load";
			loadButton.title = "Load this conversation, replacing the current one";
			loadButton.addEventListener("click", () => onLoad?.(conv));

			let deleteButton = doc.createElement("button");
			deleteButton.textContent = "Delete";
			deleteButton.className = "llm-history-delete";
			deleteButton.title = "Permanently delete this saved conversation";
			deleteButton.addEventListener("click", async () => {
				// Services.prompt.confirm, not the plain DOM confirm() --
				// the Web confirm() API has no title parameter at all, so
				// Gecko fills in a generic "[JavaScript Application]"
				// title; nsIPromptService's confirm() takes one explicitly,
				// so the dialog reads as coming from this plugin rather
				// than an unbranded system prompt. Deleting a file is not
				// undoable, unlike everything else a button click does in
				// this pane, hence confirming at all.
				let confirmed = Services.prompt.confirm(
					doc.defaultView,
					"ZLLM",
					`Delete this saved conversation? This cannot be undone.\n\n${conv.filename}`
				);
				if (!confirmed) {
					return;
				}
				deleteButton.disabled = true;
				try {
					await LLMConversationHistory.deleteConversation(conv.path);
					card.remove();
					if (!list.children.length) showEmptyPlaceholder();
				}
				catch (e) {
					Zotero.debug(`LLM Chat Pane [Conversation History UI]: delete failed: ${e.message}`);
					deleteButton.disabled = false;
				}
			});

			actions.append(loadButton, deleteButton);
			card.append(header, previewEl, actions);
			return card;
		};

		// Replaces the list with one card per conversation -- `conversations`
		// is already sorted newest-saved-first (see listConversations).
		let render = (conversations) => {
			list.replaceChildren();
			if (!conversations.length) {
				showEmptyPlaceholder();
				return;
			}
			for (let conv of conversations) {
				list.appendChild(createCard(conv));
			}
		};

		return { element: details, render };
	},
};
