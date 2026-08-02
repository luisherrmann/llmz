// Retrieves the user's own annotations on the current PDF -- sticky notes,
// highlights, and underlines -- as a selectable context source alongside
// figures/tables/equations/references (selection itself lives in
// llm/prompt.js's selectNoteWithLLM, following the same "ask the LLM to pick
// the single best match" pattern as selectTableWithLLM/selectFigureWithLLM/
// selectEquationWithLLM).
//
// Sourced from Zotero.Item.getAnnotations() on the PDF attachment itself,
// not a standalone (page-less) Zotero note -- annotationPageLabel gives a
// real page number and annotationPosition gives the same {pageIndex, rects}
// shape LLMCitation.navigateToPosition() already consumes for figures/
// tables/equations, so these double as proper click-to-jump targets too.
// 'image'/'ink' annotations are skipped -- no text content to use as
// context. Unlike LLMReferences/LLMTables/LLMEquations, there's no
// subprocess extraction (and so no caching) -- annotations are just Zotero
// item data, cheap to re-read live, which also keeps a comment the user just
// edited up to date.
LLMNotes = {
	log(msg) {
		Zotero.debug("LLM Chat Pane [Notes]: " + msg);
	},

	_cleanText(html) {
		if (!html) return "";
		let parser = new DOMParser();
		let doc = parser.parseFromString(html, "text/html");
		return doc.body.textContent.replace(/\s+/g, " ").trim();
	},

	// Converts a single 'note'/'highlight'/'underline' annotation Item into
	// { item, annotationKey, type, title, text, highlightedText, comment,
	// caption, position, color }, or null for an annotation type/content we
	// don't use as context (e.g. 'image'/'ink', or a highlight with neither
	// underlying text nor a comment). Shared by
	// getNotes() (bulk, over every annotation on the PDF) and
	// LLMChatPane.getSelectedAnnotation() (the one currently selected/
	// highlighted in the reader, if any) so both produce identically-shaped
	// notes.
	//   - 'note' annotations: text = "Note: <comment>"
	//   - 'highlight'/'underline' annotations: text = "Highlighted/Underlined
	//     text: \"<annotationText>\"" plus "Note: <comment>" if a comment was
	//     also added
	// `highlightedText`/`comment` are the same two pieces BEFORE being
	// combined into `text` -- kept as their own fields for a caller that
	// needs to lay them out differently (e.g. llm/prompt.js's own
	// <NOTE_CONTEXT> block, injected inline next to the PDF paragraph a
	// highlight/underline overlaps rather than in a combined prose line).
	// `caption` is a short fallback for makeMessageClickable's text-search
	// navigation, in the rare case `position` fails to parse.
	formatAnnotation(annotation) {
		let type = annotation.annotationType;
		if (!["note", "highlight", "underline"].includes(type)) return null;

		let comment = this._cleanText(annotation.annotationComment);
		let highlighted = ["highlight", "underline"].includes(type)
			? this._cleanText(annotation.annotationText)
			: "";
		if (!comment && !highlighted) return null;

		let pageLabel = annotation.annotationPageLabel || "?";
		let position = null;
		try {
			if (annotation.annotationPosition) {
				position = JSON.parse(annotation.annotationPosition);
			}
		}
		catch (e) {
			this.log(`Failed to parse annotationPosition for annotation ${annotation.id}: ${e.message}`);
		}

		let textParts = [];
		if (highlighted) {
			let verb = type === "underline" ? "Underlined" : "Highlighted";
			textParts.push(`${verb} text: "${highlighted}"`);
		}
		if (comment) textParts.push(`Note: ${comment}`);

		let title = highlighted
			? `${type === "underline" ? "Underline" : "Highlight"} (p. ${pageLabel})`
			: `Note (p. ${pageLabel})`;

		return {
			item: annotation,
			annotationKey: annotation.key,
			type,
			title,
			text: textParts.join("\n"),
			highlightedText: highlighted,
			comment,
			caption: (highlighted || comment).split(/\s+/).slice(0, 8).join(" "),
			position,
			color: annotation.annotationColor || null,
		};
	},

	// Returns [{ item, annotationKey, type, title, text, highlightedText,
	// comment, caption, position, color }] for every note/highlight/
	// underline annotation on the PDF -- see formatAnnotation().
	async getNotes(item) {
		if (!item.isFileAttachment()) return [];

		// getAnnotations() requires 'childItems' data to already be loaded on
		// `item` and throws Zotero.Exception.UnloadedDataException otherwise --
		// `item` here typically comes from a synchronous Zotero.Items.get() (see
		// LLMChatPane.getActiveReaderAttachment()), which doesn't guarantee
		// childItems has been loaded, so this would silently produce "no notes
		// found" for a PDF that actually has annotations. Idempotent to call
		// even when already loaded (just re-queries), so no harm calling it
		// unconditionally on every request.
		await item.loadDataType('childItems');

		let annotations = item.getAnnotations();
		return annotations
			.map(annotation => this.formatAnnotation(annotation))
			.filter(Boolean);
	},
};
