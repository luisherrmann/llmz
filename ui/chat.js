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
	//   appendMessage(role, text, time)   -- appends a plain-text message
	//                                         bubble ("You" or the model's
	//                                         provider label), with `time`
	//                                         (default: now, formatted
	//                                         "dd/mm/yyyy - hh:mm:ss") shown
	//                                         to the label's right -- pass an
	//                                         explicit `time` to preserve a
	//                                         historical timestamp (e.g. when
	//                                         rebuilding from an imported
	//                                         conversation, see
	//                                         llm-chat-pane.js's onImport).
	//                                         Returns the content <pre>,
	//                                         ready for either further
	//                                         plain-text updates (streaming
	//                                         tokens) or a later swap to
	//                                         rendered HTML (done at the
	//                                         call site in llm-chat-pane.js,
	//                                         since that requires citation/
	//                                         link resolution this module
	//                                         doesn't know about)
	//   appendRichMessage(role, parts,
	//     time)                           -- like appendMessage, but for a
	//                                         message built from an ordered
	//                                         list of parts -- each either
	//                                         plain text ({ text }) or a
	//                                         real inline clickable link
	//                                         ({ label, title, onClick }) --
	//                                         so it reads as a normal
	//                                         sentence with just specific
	//                                         words as the clickable parts.
	//                                         Used for e.g. the
	//                                         download-reference flow's
	//                                         result, which needs
	//                                         independent links for both
	//                                         the library item and its PDF
	//                                         source. Returns the content
	//                                         <div>.
	//   appendImages(contentEl, dataUris) -- attaches a row of image
	//                                         thumbnails below a message
	//                                         (e.g. images the user pasted
	//                                         and sent with their prompt)
	//   setMessageText(contentEl, text)   -- updates the exportable text
	//                                         recorded for a message
	//                                         previously returned by
	//                                         appendMessage/appendRichMessage,
	//                                         WITHOUT touching its visible
	//                                         DOM content -- for a streamed
	//                                         reply, the caller already
	//                                         updates the DOM directly
	//                                         (plain text while streaming,
	//                                         then rendered HTML once done),
	//                                         so this just keeps
	//                                         exportTranscript() in sync
	//                                         with the FINAL text (e.g. the
	//                                         grounded markdown) rather than
	//                                         an initial "Waiting for..."
	//                                         placeholder.
	//   exportTranscript()                -- returns a snapshot
	//                                         ([{ role, time, text }]) of
	//                                         every message appended so far,
	//                                         in the order they were sent
	//                                         (see export.js)
	//   clear()                           -- removes every message from
	//                                         both the visible list and the
	//                                         transcript (e.g. before
	//                                         repopulating from an imported
	//                                         conversation -- see
	//                                         import.js's importConversation)
	//   renderMarkdownMessage(contentEl,
	//     html, fallbackText)             -- swaps a plain-text message's
	//                                         content (as returned by
	//                                         appendMessage) for rendered
	//                                         markdown+link HTML, in place
	//                                         -- the click-delegation half
	//                                         of what a live streamed reply
	//                                         does (see request.js), used
	//                                         here so an imported historical
	//                                         message can get the same
	//                                         treatment (see
	//                                         llm-chat-pane.js's import
	//                                         handling) without duplicating
	//                                         the LLMCitation click-dispatch
	//                                         logic a second time. Falls
	//                                         back to `fallbackText` as
	//                                         plain text if `html` can't be
	//                                         parsed (same XML-well-
	//                                         formedness concern as a live
	//                                         reply -- see _renderMarkdown).
	create(doc) {
		let label = doc.createElement("div");
		label.className = "llm-section-label";
		label.textContent = "Conversation";

		let list = doc.createElement("div");
		list.className = "llm-message-list";

		// Mirrors the visible message list as plain { role, time, text }
		// entries, for export.js -- kept separate from the DOM rather than
		// read back out of it, since a reply's DOM content ends up as
		// rendered HTML (citation links, KaTeX, etc.), not the plain
		// markdown export.js actually wants.
		let transcript = [];
		let transcriptByContent = new WeakMap();

		// dd/mm/yyyy - hh:mm:ss, local time, zero-padded.
		let formatTimestamp = () => {
			let d = new Date();
			let pad = n => String(n).padStart(2, "0");
			return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} - ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
		};

		// Shared by appendMessage/appendRichMessage below: builds the message
		// bubble shell (label+time row + empty content container), prepends
		// it, and records a transcript entry for it, leaving the caller to
		// fill `content` in however suits it (plain text vs. mixed text/link
		// nodes) and to set the entry's initial text.
		let appendShell = (role, contentTag, time) => {
			let message = doc.createElement("div");
			// role is "You" for the user, or a provider/feature label (e.g.
			// "Ollama", "OpenAI - gpt-5.4", "Zotero") for everything else --
			// System messages never reach here, see llm-chat-pane.js's
			// appendMessage, which routes those to ui/logs.js instead.
			message.className = `llm-message ${role === "You" ? "llm-message-user" : "llm-message-assistant"}`;

			let labelRow = doc.createElement("div");
			labelRow.className = "llm-message-label-row";
			let labelEl = doc.createElement("span");
			labelEl.className = "llm-message-label";
			labelEl.textContent = role;
			let timeEl = doc.createElement("span");
			// No color of its own (see style.css) -- inherits the page's
			// default text color, deliberately NOT the role label's
			// green/red, so it doesn't read as "part of" the role.
			timeEl.className = "llm-message-time";
			timeEl.textContent = time;
			labelRow.append(labelEl, timeEl);

			let content = doc.createElement(contentTag);
			content.className = "llm-message-content";

			message.append(labelRow, content);
			list.prepend(message);
			list.scrollTop = 0;

			let entry = { role, time, text: "" };
			transcript.push(entry);
			transcriptByContent.set(content, entry);
			return content;
		};

		let appendMessage = (role, text, time = formatTimestamp()) => {
			let content = appendShell(role, "pre", time);
			content.textContent = text;
			transcriptByContent.get(content).text = text;
			return content;
		};

		let appendRichMessage = (role, parts, time = formatTimestamp()) => {
			let content = appendShell(role, "div", time);
			let text = "";
			for (let part of parts) {
				if (part.text !== undefined) {
					content.append(doc.createTextNode(part.text));
					text += part.text;
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
				text += part.label;
			}
			transcriptByContent.get(content).text = text;
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

		let setMessageText = (contentEl, text) => {
			let entry = transcriptByContent.get(contentEl);
			if (entry) entry.text = text;
		};

		let exportTranscript = () => transcript.map(entry => ({ ...entry }));

		let clear = () => {
			list.replaceChildren();
			transcript.length = 0;
			// transcriptByContent entries for the now-removed content
			// elements are simply unreachable garbage now -- WeakMap needs
			// no explicit cleanup.
		};

		let renderMarkdownMessage = (contentEl, html, fallbackText) => {
			let rendered = doc.createElement("div");
			rendered.className = "llm-markdown llm-message-content";
			try {
				rendered.innerHTML = html;
			}
			catch (e) {
				Zotero.debug(`LLM Chat Pane [Chat]: renderMarkdownMessage innerHTML assignment failed: ${e.message}`);
				rendered.textContent = fallbackText;
			}
			// Same LLMCitation click-dispatch as a live streamed reply (see
			// request.js) -- annotationKey (notes only) beats position beats
			// a page number beats a caption text-search.
			rendered.addEventListener("click", (e) => {
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
						LLMCitation.navigateToPosition(JSON.parse(anchor.dataset.position));
					}
					catch (err) {
						Zotero.debug(`LLM Chat Pane [Chat]: Failed to parse position for link: ${err.message}`);
					}
					return;
				}
				LLMCitation.navigateToText(anchor.dataset.query);
			});
			contentEl.replaceWith(rendered);
			return rendered;
		};

		return { label, list, appendMessage, appendRichMessage, appendImages, setMessageText, exportTranscript, clear, renderMarkdownMessage };
	},
};
