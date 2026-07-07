// The collapsible "Advanced" settings panel -- currently just the two
// PDF-context-retrieval tunables on LLMPrompt. Split out of
// llm-chat-pane.js's onRender for the same reason as the other ui/ modules.
LLMUIAdvanced = {
	_makeIntegerSetting(doc, labelText, get, set, { min = 1 } = {}) {
		let row = doc.createElement("label");
		row.className = "llm-advanced-row";
		let span = doc.createElement("span");
		span.textContent = labelText;
		let input = doc.createElement("input");
		input.type = "number";
		input.min = String(min);
		input.step = "1";
		input.value = get();
		input.addEventListener("change", () => {
			let value = parseInt(input.value, 10);
			if (Number.isInteger(value) && value >= min) {
				set(value);
			}
			else {
				input.value = get();
			}
		});
		row.append(span, input);
		return row;
	},

	create(doc) {
		let details = doc.createElement("details");
		details.className = "llm-advanced-details";
		let summary = doc.createElement("summary");
		summary.textContent = "Advanced";
		let body = doc.createElement("div");
		body.className = "llm-advanced-body";
		body.append(
			this._makeIntegerSetting(
				doc,
				"Max PDF context (characters)",
				() => LLMPrompt.maxPDFContextChars,
				(value) => { LLMPrompt.maxPDFContextChars = value; }
			),
			this._makeIntegerSetting(
				doc,
				"Chunk context top-K",
				() => LLMPrompt.chunkContextTopK,
				(value) => { LLMPrompt.chunkContextTopK = value; }
			)
		);
		details.append(summary, body);
		return { element: details };
	},
};
