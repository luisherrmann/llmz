// The "Logs" panel: a collapsible <details> in the chat pane's controls that
// collects System-level status messages (extraction/selection results,
// download-reference progress, errors, etc.) separately from the actual
// user/assistant conversation -- see llm-chat-pane.js's appendMessage, which
// routes anything with role "System" here instead of into the message list
// (ui/chat.js). Split out of llm-chat-pane.js's onRender (previously built
// inline as several of the many closures in one large render function)
// since it's a self-contained DOM component with its own append/format
// logic, no different in spirit from ui/chat.js.
LLMUILogs = {
	// [DD/MM/YYYY - hh:mm:ss], local time, zero-padded.
	_formatTimestamp() {
		let d = new Date();
		let pad = n => String(n).padStart(2, "0");
		return `[${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} - ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}]`;
	},

	// Builds the Logs panel for one item-pane render. Returns:
	//   element                     -- the <details> to place in the controls row
	//   appendMessage(text)         -- logs a plain status line, returns the
	//                                  content <span> (e.g. for makeClickable)
	//   appendRichMessage(parts)    -- logs a status line built from an ordered
	//                                  list of { text } / { label, title, onClick }
	//                                  parts, for inline clickable links mid-sentence
	//   makeClickable(el, onClick)  -- makes a whole logged entry's content
	//                                  clickable as one unit
	create(doc) {
		let details = doc.createElement("details");
		details.className = "llm-logs-details";
		let summary = doc.createElement("summary");
		summary.textContent = "Logs";
		let body = doc.createElement("div");
		body.className = "llm-collapsible-body llm-logs-body";
		details.append(summary, body);

		// Prepends a timestamped entry -- newest at the top, scrollTop reset
		// to show it, matching ui/chat.js's message list convention.
		let appendEntry = (contentEl) => {
			let entry = doc.createElement("div");
			entry.className = "llm-log-entry";
			let timestampEl = doc.createElement("span");
			timestampEl.className = "llm-log-timestamp";
			timestampEl.textContent = this._formatTimestamp() + " ";
			entry.append(timestampEl, contentEl);
			body.prepend(entry);
			body.scrollTop = 0;
			return entry;
		};

		let appendMessage = (text) => {
			let content = doc.createElement("span");
			content.className = "llm-log-text";
			content.textContent = text;
			appendEntry(content);
			return content;
		};

		// Renders a log entry built from an ordered list of parts -- each
		// either plain text ({ text }) or a real inline clickable link
		// ({ label, title, onClick }) -- so it reads as a normal sentence
		// with just specific words as the clickable parts (matching how the
		// model's own figure/table/reference links look). Used for the
		// download-reference results, which need independent links for both
		// the library item and its PDF source.
		let appendRichMessage = (parts) => {
			let content = doc.createElement("span");
			content.className = "llm-log-text";
			for (let part of parts) {
				if (part.text !== undefined) {
					content.append(doc.createTextNode(part.text));
					continue;
				}
				let link = doc.createElement("a");
				link.className = "llm-find-link";
				link.textContent = part.label;
				if (part.title) link.title = part.title;
				link.addEventListener("click", (e) => {
					e.preventDefault();
					part.onClick();
				});
				content.append(link);
			}
			appendEntry(content);
			return content;
		};

		// Makes a logged entry's whole content clickable as one unit -- e.g.
		// "Including 2 tables as context ... Click to jump to the first
		// one." jumping to that table on click. Navigation itself (e.g.
		// LLMCitation) is the caller's concern, not this UI module's --
		// onClick is just an opaque callback.
		let makeClickable = (messageEl, onClick) => {
			messageEl.classList.add("llm-clickable-message");
			messageEl.addEventListener("click", onClick);
		};

		return { element: details, appendMessage, appendRichMessage, makeClickable };
	},
};
