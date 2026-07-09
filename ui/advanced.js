// The collapsible "Advanced" settings panel -- currently the two
// PDF-context-retrieval tunables, the "Use message history" toggle, and its
// accompanying "Max history messages" cap, all on LLMPrompt. Split out of
// llm-chat-pane.js's onRender for the same reason as the other ui/ modules.
LLMUIAdvanced = {
	// Returns a <tr> for one setting -- shared table layout with
	// ui/providers.js/ui/keyboard_shortcuts.js, so the input column lines up
	// at the same position for every row regardless of label length.
	_makeIntegerSettingRow(doc, labelText, get, set, { min = 1 } = {}) {
		let tr = doc.createElement("tr");
		let labelTd = doc.createElement("td");
		labelTd.className = "llm-advanced-field-label";
		labelTd.textContent = labelText;
		let inputTd = doc.createElement("td");
		inputTd.className = "llm-advanced-field-input";
		let input = doc.createElement("input");
		input.type = "number";
		input.className = "llm-advanced-input";
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
		inputTd.appendChild(input);
		tr.append(labelTd, inputTd);
		return tr;
	},

	// Same row layout as _makeIntegerSettingRow above, but a checkbox
	// instead of a number <input> -- for a plain on/off setting like "Use
	// message history".
	_makeCheckboxSettingRow(doc, labelText, get, set) {
		let tr = doc.createElement("tr");
		let labelTd = doc.createElement("td");
		labelTd.className = "llm-advanced-field-label";
		labelTd.textContent = labelText;
		let inputTd = doc.createElement("td");
		inputTd.className = "llm-advanced-field-input";
		let input = doc.createElement("input");
		input.type = "checkbox";
		input.className = "llm-advanced-checkbox";
		input.checked = get();
		input.addEventListener("change", () => {
			set(input.checked);
		});
		inputTd.appendChild(input);
		tr.append(labelTd, inputTd);
		return tr;
	},

	create(doc) {
		let details = doc.createElement("details");
		details.className = "llm-advanced-details";
		let summary = doc.createElement("summary");
		summary.textContent = "Advanced";
		let body = doc.createElement("div");
		body.className = "llm-advanced-body";

		let table = doc.createElement("table");
		table.className = "llm-advanced-table";
		let tbody = doc.createElement("tbody");
		tbody.append(
			this._makeIntegerSettingRow(
				doc,
				"Max PDF context (characters)",
				() => LLMPrompt.maxPDFContextChars,
				(value) => { LLMPrompt.maxPDFContextChars = value; }
			),
			this._makeIntegerSettingRow(
				doc,
				"Chunk context top-K",
				() => LLMPrompt.chunkContextTopK,
				(value) => { LLMPrompt.chunkContextTopK = value; }
			),
			this._makeCheckboxSettingRow(
				doc,
				"Use message history",
				() => LLMPrompt.useMessageHistory,
				(value) => { LLMPrompt.useMessageHistory = value; }
			),
			this._makeIntegerSettingRow(
				doc,
				"Max history messages",
				() => LLMPrompt.maxHistoryMessages,
				(value) => { LLMPrompt.maxHistoryMessages = value; }
			)
		);
		table.appendChild(tbody);
		body.appendChild(table);

		details.append(summary, body);
		return { element: details };
	},
};
