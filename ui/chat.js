// The main conversation area: the "Conversation" label + scrollable message
// list holding the user's own messages and the model's replies (as opposed
// to ui/logs.js's separate Logs panel, which holds System-level status
// messages instead). Split out of llm-chat-pane.js's onRender for the same
// reason as ui/logs.js.
LLMUIChat = {
	// Builds the conversation area for one item-pane render. Returns:
	//   label, list                       -- the section label and scrollable
	//                                         message-list elements to place
	//                                         in the pane layout
	//   appendMessage(role, text)         -- appends a plain-text message
	//                                         bubble ("You" or the model's
	//                                         provider label) and returns its
	//                                         content <pre>, ready for either
	//                                         further plain-text updates
	//                                         (streaming tokens) or a later
	//                                         swap to rendered HTML (done at
	//                                         the call site in
	//                                         llm-chat-pane.js, since that
	//                                         requires citation/link
	//                                         resolution this module doesn't
	//                                         know about)
	//   appendImages(contentEl, dataUris) -- attaches a row of image
	//                                         thumbnails below a message
	//                                         (e.g. images the user pasted
	//                                         and sent with their prompt)
	create(doc) {
		let label = doc.createElement("div");
		label.className = "llm-section-label";
		label.textContent = "Conversation";

		let list = doc.createElement("div");
		list.className = "llm-message-list";

		let appendMessage = (role, text) => {
			let message = doc.createElement("div");
			// role is "You" for the user, or the provider's own label (e.g.
			// "Ollama", "OpenAI") for the model's reply -- System messages
			// never reach here, see llm-chat-pane.js's appendMessage, which
			// routes those to ui/logs.js instead.
			message.className = `llm-message ${role === "You" ? "llm-message-user" : "llm-message-assistant"}`;

			let labelEl = doc.createElement("div");
			labelEl.className = "llm-message-label";
			labelEl.textContent = role;

			let content = doc.createElement("pre");
			content.className = "llm-message-content";
			content.textContent = text;

			message.append(labelEl, content);
			list.prepend(message);
			list.scrollTop = 0;
			return content;
		};

		let appendImages = (contentEl, dataUris) => {
			let thumbsRow = doc.createElement("div");
			thumbsRow.className = "llm-message-images";
			for (let dataUri of dataUris) {
				let img = doc.createElement("img");
				img.src = dataUri;
				img.className = "llm-message-image-thumb";
				thumbsRow.appendChild(img);
			}
			contentEl.parentElement.appendChild(thumbsRow);
		};

		return { label, list, appendMessage, appendImages };
	},
};
