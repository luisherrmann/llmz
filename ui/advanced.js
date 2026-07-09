// The collapsible "Advanced" settings panel, split into three labeled
// subsections (see _makeSection): Context (the two PDF-context-retrieval
// tunables), Message history (the "Use message history" toggle and its
// accompanying "Max history messages" cap -- all on LLMPrompt), and Cache
// (the Clear Cache checkbox list + button). Split out of
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

	// One subsection within "Advanced" -- a header (flush left, same
	// baseline as "Advanced" itself) followed by a padded wrapper (see
	// style.css's .llm-advanced-section-body, the same 1em padding
	// .llm-advanced-body/.llm-providers-body/.llm-shortcuts-body all use)
	// so the subsection's own settings read as visually indented relative
	// to its header. Returns the wrapper -- the caller appends whatever
	// belongs in that subsection to it.
	_makeSection(doc, labelText) {
		let label = doc.createElement("div");
		label.className = "llm-advanced-section-label";
		label.textContent = labelText;
		let sectionBody = doc.createElement("div");
		sectionBody.className = "llm-advanced-section-body";
		return { label, sectionBody };
	},

	// `getActiveItem()` resolves the PDF attachment to clear cache for (the
	// caller's LLMChatPane.getActiveReaderAttachment()). `onMessage(text)` is
	// called for user-facing status text -- routing this (e.g. to the Logs
	// panel) is the caller's concern, not this module's. `clearCacheIconURL`
	// is a plain file:/jar: URL (see llm-chat-pane.js's onRender, rootURI +
	// "icons/...svg"), rendered via LLMUIIcon.create.
	create(doc, { getActiveItem, onMessage, clearCacheIconURL } = {}) {
		let details = doc.createElement("details");
		details.className = "llm-advanced-details";
		let summary = doc.createElement("summary");
		summary.textContent = "Advanced";
		let body = doc.createElement("div");
		body.className = "llm-collapsible-body llm-advanced-body";

		// --- Context ---
		let { label: contextLabel, sectionBody: contextBody } = this._makeSection(doc, "Context");
		let contextTable = doc.createElement("table");
		contextTable.className = "llm-advanced-table";
		let contextTbody = doc.createElement("tbody");
		contextTbody.append(
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
			)
		);
		contextTable.appendChild(contextTbody);
		contextBody.appendChild(contextTable);

		// --- Message history ---
		let { label: historyLabel, sectionBody: historyBody } = this._makeSection(doc, "Message history");
		let historyTable = doc.createElement("table");
		historyTable.className = "llm-advanced-table";
		let historyTbody = doc.createElement("tbody");
		historyTbody.append(
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
		historyTable.appendChild(historyTbody);
		historyBody.appendChild(historyTable);

		// --- Cache ---
		// Debug affordance: drops the memory+disk cache for whichever of
		// citations/equations/figures/references/tables are checked below,
		// for the active PDF ONLY (see each module's own clearCache(item),
		// which only ever touches that item's own <PDF_ID>[-kind].json --
		// never other PDFs' caches), so the next submitted prompt re-runs
		// extraction from scratch instead of reusing whatever was cached
		// from a prior run -- useful when a bundled extraction script has
		// changed in a way _scriptFingerprint() doesn't catch, or just to
		// force a clean re-extraction while debugging. Irreversible
		// (there's no way to get a cleared cache back short of re-running
		// extraction), hence the confirm prompt before actually clearing
		// anything.
		let { label: cacheLabel, sectionBody: cacheBody } = this._makeSection(doc, "Cache");
		let cacheTypes = [
			{ label: "Citations", clear: item => LLMCitation.clearCache(item) },
			{ label: "Equations", clear: item => LLMEquations.clearCache(item) },
			{ label: "Figures", clear: item => LLMFigures.clearCache(item) },
			{ label: "References", clear: item => LLMReferences.clearCache(item) },
			{ label: "Tables", clear: item => LLMTables.clearCache(item) },
		];

		let cacheOptionsList = doc.createElement("div");
		cacheOptionsList.className = "llm-clear-cache-options";
		// Checked by default, so clicking Clear Cache without touching any
		// checkbox still clears everything, same as before this became
		// selectable.
		let cacheCheckboxes = cacheTypes.map(({ label }) => {
			let optionLabel = doc.createElement("label");
			optionLabel.className = "llm-clear-cache-option";
			let checkbox = doc.createElement("input");
			checkbox.type = "checkbox";
			checkbox.className = "llm-advanced-checkbox";
			checkbox.checked = true;
			optionLabel.append(checkbox, doc.createTextNode(label));
			cacheOptionsList.appendChild(optionLabel);
			return checkbox;
		});
		cacheBody.appendChild(cacheOptionsList);

		let clearCacheButton = doc.createElement("button");
		clearCacheButton.className = "llm-clear-cache";
		clearCacheButton.title = "Clear the checked caches, for this PDF only";
		clearCacheButton.append(LLMUIIcon.create(doc, clearCacheIconURL), doc.createTextNode("Clear Cache"));
		clearCacheButton.addEventListener("click", async () => {
			let item = getActiveItem?.();
			if (!item) {
				onMessage?.("Clear Cache: no active PDF.");
				return;
			}
			let selected = cacheTypes.filter((_, i) => cacheCheckboxes[i].checked);
			if (!selected.length) {
				onMessage?.("Clear Cache: no cache types selected.");
				return;
			}
			let confirmed = Services.prompt.confirm(
				doc.defaultView,
				"ZLLM",
				`This will irrecovably delete all the selected cache files:\n\n${selected.map(c => c.label).join("\n")}`
			);
			if (!confirmed) {
				return;
			}
			await Promise.all(selected.map(({ clear }) => clear(item)));
			onMessage?.(`Cleared ${selected.map(c => c.label).join(", ")} cache for the active PDF. The next prompt will re-run extraction from scratch.`);
		});
		cacheBody.appendChild(clearCacheButton);

		body.append(contextLabel, contextBody, historyLabel, historyBody, cacheLabel, cacheBody);

		details.append(summary, body);
		return { element: details, clearCacheButton };
	},
};
