// The collapsible "Past Conversations" panel: a fixed-height, independently scrolling
// list of cards, one per conversation previously saved (via Export -- see
// export.js/conversation-history.js) for the active PDF, one .md file per
// card under $HOME/Zotero/LLMz/chats/<PDF_ID>/. Split out of
// llm-chat-pane.js's onRender for the same reason as the other ui/ modules.
LLMUIConversationHistory = {
	// `onLoad(conversation)` is called on a card's Load click -- rebuilding
	// the chat pane's message list from an arbitrary saved file needs the
	// same table/figure/reference/equation link-resolution context a live
	// request does (see llm-chat-pane.js's loadTranscriptIntoChat), which is
	// exactly the kind of business logic this module otherwise stays out of
	// -- same rationale as ui/button-row.js's Import staying uninvolved in
	// that logic. Delete and the inline title editor, by contrast, ARE
	// handled directly here (a file removal/rename + a small DOM update
	// each), since neither needs any context this module doesn't already
	// have. `editIconURL`/`doneIconURL`/`loadIconURL`/`deleteIconURL` are
	// plain file:/jar: URLs (see llm-chat-pane.js's onRender, rootURI +
	// "icons/...svg") -- rendered via LLMUIIcon.create (CSS mask-image, see
	// style.css's shared .llm-icon class) rather than fetched-and-inlined
	// SVG markup, so each icon's actual visible color is entirely
	// controlled by background-color: currentColor regardless of whatever
	// fill the source SVG file itself hardcodes, and rendering doesn't
	// depend on however this chrome context happens to parse raw SVG
	// markup injected via innerHTML.
	create(doc, { onLoad, editIconURL, doneIconURL, loadIconURL, deleteIconURL } = {}) {
		let details = doc.createElement("details");
		details.className = "llm-history-details";
		let summary = doc.createElement("summary");
		summary.textContent = "Past Conversations";
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

		// Builds one timeline entry for `conv` (see conversation-history.js's
		// listConversations: { filename, path, preview, started, saved,
		// length }) -- any field the source file didn't have comes back as
		// the literal string "UNKNOWN" from that same call, and is shown
		// as-is here rather than specially handled. The dot/connecting line
		// are pure CSS (.llm-history-item's ::before/::after in style.css),
		// not DOM nodes built here.
		let createItem = (conv) => {
			let item = doc.createElement("div");
			item.className = "llm-history-item";

			// Sits to the left of the dot (see style.css's .llm-history-date
			// -- absolutely positioned within the space item's padding-left
			// reserves, same idea as the dot/line themselves), same
			// mid-green as those. This IS the "Saved" timestamp (no "Last:"
			// label -- its position alone conveys what it is), not repeated
			// in .llm-history-meta below.
			let dateEl = doc.createElement("span");
			dateEl.className = "llm-history-date";
			dateEl.textContent = conv.saved;
			item.appendChild(dateEl);

			// Stacked directly below the Saved date, same left-of-the-dot
			// column, but its OWN (unchanged, not green) color. No
			// "Started:" label -- same reasoning as the Saved date itself
			// having none: position alone conveys which is which (top =
			// Saved, bottom = Started), and a label here would make the
			// text long enough to risk the same overflow-past-the-dot bug
			// the Saved date needed a width/overflow fix for earlier.
			let startedEl = doc.createElement("span");
			startedEl.className = "llm-history-started";
			startedEl.textContent = conv.started;
			item.appendChild(startedEl);

			let header = doc.createElement("div");
			header.className = "llm-history-header";

			// The title + its inline rename editor. Toggles between two
			// states: a plain <span> (title text alone) and, once the Edit
			// button (in `actions` below, left of Load/Delete) is clicked, a
			// text <input> (pre-filled with the current title, focused+
			// selected) -- with the Edit button itself swapping to a "Done"
			// label/icon for the duration. Clicking Done (or pressing Enter)
			// saves -- see LLMConversationHistory.renameConversation, which
			// actually renames the file on disk -- and swaps back to the
			// plain span and the "Edit" label/icon. Escape cancels back to
			// the plain span WITHOUT saving.
			let titleRow = doc.createElement("span");
			titleRow.className = "llm-history-title-row";

			let titleEl = doc.createElement("span");
			titleEl.className = "llm-history-title";
			// Just the filename's stem -- ".md" is implied (every file in
			// this folder is one) and not worth the extra visual noise.
			titleEl.textContent = conv.filename.replace(/\.md$/i, "");

			// Styled the same as Load/Delete below (icon + text label), not
			// as a bare icon-only affordance next to the title anymore.
			let editButton = doc.createElement("button");
			editButton.className = "llm-history-edit";
			editButton.title = "Rename this conversation";
			let editIcon = LLMUIIcon.create(doc, editIconURL);
			let editLabel = doc.createTextNode("Edit");
			editButton.append(editIcon, editLabel);

			let titleInput = null;

			let enterEditMode = () => {
				titleInput = doc.createElement("input");
				titleInput.type = "text";
				titleInput.className = "llm-history-title-input";
				titleInput.value = titleEl.textContent;
				titleEl.replaceWith(titleInput);
				titleInput.focus();
				titleInput.select();
				editIcon.style.maskImage = `url("${doneIconURL}")`;
				editLabel.textContent = "Done";
				editButton.title = "Save this title";
				titleInput.addEventListener("keydown", (e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						saveTitle();
					}
					else if (e.key === "Escape") {
						e.preventDefault();
						cancelEdit();
					}
				});
			};

			let cancelEdit = () => {
				titleInput.replaceWith(titleEl);
				titleInput = null;
				editIcon.style.maskImage = `url("${editIconURL}")`;
				editLabel.textContent = "Edit";
				editButton.title = "Rename this conversation";
			};

			let saveTitle = async () => {
				let newStem = titleInput.value;
				editButton.disabled = true;
				try {
					let newPath = await LLMConversationHistory.renameConversation(conv.path, newStem);
					conv.path = newPath;
					conv.filename = PathUtils.filename(newPath);
					titleEl.textContent = conv.filename.replace(/\.md$/i, "");
					titleInput.replaceWith(titleEl);
					titleInput = null;
					editIcon.style.maskImage = `url("${editIconURL}")`;
					editLabel.textContent = "Edit";
					editButton.title = "Rename this conversation";
				}
				catch (e) {
					// Stays in edit mode (rather than reverting) so the
					// user can fix whatever caused the failure (e.g. a
					// name collision) and retry without retyping.
					Services.prompt.alert(doc.defaultView, "LLMz", `Rename failed: ${e.message}`);
				}
				finally {
					editButton.disabled = false;
				}
			};

			editButton.addEventListener("click", () => {
				if (titleInput) {
					saveTitle();
				}
				else {
					enterEditMode();
				}
			});

			titleRow.append(titleEl);

			let metaEl = doc.createElement("span");
			metaEl.className = "llm-history-meta";
			metaEl.textContent = `Prompts: ${conv.length}`;
			header.append(titleRow, metaEl);

			let previewEl = doc.createElement("div");
			previewEl.className = "llm-history-preview";
			previewEl.textContent = conv.preview;

			let actions = doc.createElement("div");
			actions.className = "llm-history-actions";

			let loadButton = doc.createElement("button");
			loadButton.className = "llm-history-load";
			loadButton.title = "Load this conversation, replacing the current one";
			loadButton.append(LLMUIIcon.create(doc, loadIconURL), doc.createTextNode("Load"));
			loadButton.addEventListener("click", () => onLoad?.(conv));

			let deleteButton = doc.createElement("button");
			deleteButton.className = "llm-history-delete";
			deleteButton.title = "Permanently delete this saved conversation";
			deleteButton.append(LLMUIIcon.create(doc, deleteIconURL), doc.createTextNode("Delete"));
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
					"LLMz",
					`Delete this saved conversation? This cannot be undone.\n\n${conv.filename}`
				);
				if (!confirmed) {
					return;
				}
				deleteButton.disabled = true;
				try {
					await LLMConversationHistory.deleteConversation(conv.path);
					item.remove();
					if (!list.children.length) showEmptyPlaceholder();
				}
				catch (e) {
					Zotero.debug(`LLM Chat Pane [Conversation History UI]: delete failed: ${e.message}`);
					deleteButton.disabled = false;
				}
			});

			actions.append(editButton, loadButton, deleteButton);
			item.append(header, previewEl, actions);
			return item;
		};

		// Replaces the list with one timeline entry per conversation --
		// `conversations` is already sorted newest-saved-first (see
		// listConversations), so the timeline reads top-to-bottom as most-
		// to-least recent.
		let render = (conversations) => {
			list.replaceChildren();
			if (!conversations.length) {
				showEmptyPlaceholder();
				return;
			}
			for (let conv of conversations) {
				list.appendChild(createItem(conv));
			}
		};

		return { element: details, render };
	},
};
