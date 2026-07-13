// The collapsible "Advanced" settings panel, split into three labeled
// subsections (see _makeSection): Context (the two PDF-context-retrieval
// tunables), Message history (the "Use message history" toggle and its
// accompanying "Max history messages" cap -- all on LLMPrompt), and Cache
// (the Clear Cache checkbox list + button). Split out of
// llm-chat-pane.js's onRender for the same reason as the other ui/ modules.
LLMUIAdvanced = {
	// A second <tr> placed right after a setting's own row, its description
	// in a single colspan="3" cell -- same visible-caption styling
	// (.llm-advanced-field-hint) as the Embeddings section's existing
	// "Batch size" hint, just per-ROW instead of one hint below a whole
	// table, since Context has several described rows mixed with
	// undescribed ones. Spans all 3 columns (the label/input columns PLUS
	// the dummy third column every row gets -- see _makeIntegerSettingRow's
	// own comment) rather than just 2, so the description can wrap across
	// the section's FULL width instead of being squeezed into just the
	// label+input columns' own (shrink-to-fit) content width.
	_makeHintRow(doc, text) {
		let tr = doc.createElement("tr");
		let hintTd = doc.createElement("td");
		hintTd.className = "llm-advanced-field-hint";
		hintTd.colSpan = 3;
		hintTd.textContent = text;
		tr.appendChild(hintTd);
		return tr;
	},

	// Returns { rows, refresh } for one setting -- shared table layout with
	// ui/providers.js/ui/keyboard-shortcuts.js, so the input column lines up
	// at the same position for every row regardless of label length. `rows`
	// is an array (length 1, or 2 if `description` is given -- see
	// _makeHintRow above) so a caller can just spread it straight into a
	// <tbody>.append(...) call.
	// Every row gets a third, empty, unconstrained <td> after the label/input
	// columns (both of which use `width: 1px` -- shrink-to-fit, see
	// style.css) -- with .llm-advanced-table now stretched to the section's
	// full width, this dummy column is what actually ABSORBS the leftover
	// horizontal space, which is what lets _makeHintRow's colspan="3"
	// description cell stretch across the whole page instead of stopping at
	// the label+input columns' own narrow content width.
	// `refresh()` re-reads `get()` and updates the input's displayed value --
	// needed because a setting backed by LLMPrompt's per-(provider,model)
	// advanced settings (see create() below) can change out from under an
	// already-rendered row when the user switches provider/model, which a
	// plain one-time `input.value = get()` at row-creation time can't
	// reflect on its own.
	_makeIntegerSettingRow(doc, labelText, get, set, { min = 1, description } = {}) {
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
		tr.append(labelTd, inputTd, doc.createElement("td"));
		let rows = description ? [tr, this._makeHintRow(doc, description)] : [tr];
		return { rows, refresh: () => { input.value = get(); } };
	},

	// Same row layout/refresh contract as _makeIntegerSettingRow above, but a
	// checkbox instead of a number <input> -- for a plain on/off setting like
	// "Use message history".
	_makeCheckboxSettingRow(doc, labelText, get, set, { description } = {}) {
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
		tr.append(labelTd, inputTd, doc.createElement("td"));
		let rows = description ? [tr, this._makeHintRow(doc, description)] : [tr];
		return { rows, refresh: () => { input.checked = get(); } };
	},

	// Same row layout as _makeIntegerSettingRow/_makeCheckboxSettingRow
	// above, but for an arbitrary pre-built element (e.g.
	// LLMUIProviderModelSelect.create's row) instead of building an input
	// itself -- for a setting whose control isn't a plain number/checkbox.
	_makeElementRow(doc, labelText, contentEl) {
		let tr = doc.createElement("tr");
		let labelTd = doc.createElement("td");
		labelTd.className = "llm-advanced-field-label";
		labelTd.textContent = labelText;
		let contentTd = doc.createElement("td");
		contentTd.className = "llm-advanced-field-input";
		contentTd.appendChild(contentEl);
		tr.append(labelTd, contentTd);
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
	// panel) is the caller's concern, not this module's. `clearCacheIconURL`/
	// `refreshIconURL` are plain file:/jar: URLs (see llm-chat-pane.js's
	// onRender, rootURI + "icons/...svg"), rendered via LLMUIIcon.create.
	create(doc, { getActiveItem, onMessage, clearCacheIconURL, refreshIconURL } = {}) {
		let details = doc.createElement("details");
		details.className = "llm-advanced-details";
		let summary = doc.createElement("summary");
		summary.textContent = "Advanced";
		let body = doc.createElement("div");
		body.className = "llm-collapsible-body llm-advanced-body";

		// Rows built from LLMPrompt's per-(provider,model) advanced settings
		// (see its own comment) -- collected here so create()'s returned
		// refreshPairSettings() can re-sync every one of these inputs after
		// LLMPrompt.applyAdvancedSettingsFor runs on a provider/model change,
		// rather than needing each section to track its own list.
		let pairSettingRows = [];
		let makePairIntegerRow = (labelText, key, opts) => {
			let { rows, refresh } = this._makeIntegerSettingRow(
				doc, labelText,
				() => LLMPrompt[key],
				(value) => { LLMPrompt.saveAdvancedSetting(key, value); },
				opts
			);
			pairSettingRows.push(refresh);
			return rows;
		};
		let makePairCheckboxRow = (labelText, key, opts) => {
			let { rows, refresh } = this._makeCheckboxSettingRow(
				doc, labelText,
				() => LLMPrompt[key],
				(value) => { LLMPrompt.saveAdvancedSetting(key, value); },
				opts
			);
			pairSettingRows.push(refresh);
			return rows;
		};

		// --- Context ---
		let { label: contextLabel, sectionBody: contextBody } = this._makeSection(doc, "Context");
		let contextTable = doc.createElement("table");
		contextTable.className = "llm-advanced-table";
		let contextTbody = doc.createElement("tbody");
		contextTbody.append(...[
			makePairIntegerRow("Max PDF context (characters)", "maxPDFContextChars",
				{ description: "Maximum number of characters to include in the PDF context. Increase for models with larger context windows."}),
			makePairIntegerRow("Chunk context top-K", "chunkContextTopK",
				{ description: "How many text chunks to select when the context size is exceeded."}),
			makePairIntegerRow("Max selected figures", "maxSelectedFigures",
				{ description: "The maximum number of (rendered) figures to include in a request. More figures mean more context, but at the expense of more expensive larger prompts." }),
			makePairIntegerRow("Max selected tables", "maxSelectedTables",
				{ description: "The maximum number of tables to include in a request. More tables mean more context, but at the expense of more expensive larger prompts." }),
			makePairIntegerRow("Max selected equations", "maxSelectedEquations",
				{ description: "The maximum number of equations to include in a request. More equations mean more context, but at the expense of more expensive larger prompts." }),
		].flat());
		contextTable.appendChild(contextTbody);
		contextBody.appendChild(contextTable);

		// --- Message history ---
		let { label: historyLabel, sectionBody: historyBody } = this._makeSection(doc, "Message history");
		let historyTable = doc.createElement("table");
		historyTable.className = "llm-advanced-table";
		let historyTbody = doc.createElement("tbody");
		historyTbody.append(...[
			makePairCheckboxRow("Use message history", "useMessageHistory",
				{description: "Determines if the LLM remembers past messages."}),
			makePairIntegerRow("Max history messages", "maxHistoryMessages",
				{description: "The number of past messages visible to the LLM."}
			),
		].flat());
		historyTable.appendChild(historyTbody);
		historyBody.appendChild(historyTable);

		// --- Embeddings ---
		// Same row (provider select, model select, refresh button) as the
		// chat Settings row above, but pointed at LLMInterfaces' SEPARATE
		// embedding-provider state -- a user may well want e.g. Anthropic
		// for chat but Ollama for embeddings, so these are never tied
		// together. Anthropic is excluded from providerOptions here since
		// it has no embeddings API of its own (see LLMInterfaces.getEmbedding).
		let { label: embeddingsLabel, sectionBody: embeddingsBody } = this._makeSection(doc, "Embeddings");
		// batchSizeRow assigned further down (Batch size is built AFTER this
		// select, since it needs `embeddingProviderModelSelect` to exist for
		// its own row-building helper's sake -- see below) -- referenced here
		// only inside onChange, which never fires before the whole render
		// function (and therefore batchSizeRow's own assignment) has
		// finished, same reasoning as the chat Settings row's own onChange
		// in llm-chat-pane.js.
		let batchSizeRow;
		let embeddingProviderModelSelect = LLMUIProviderModelSelect.create(doc, {
			refreshIconURL,
			providerOptions: [
				{ value: "ollama", label: "Ollama" },
				{ value: "lmstudio", label: "LM Studio" },
				{ value: "litellm", label: "API (LiteLLM)" },
				{ value: "openai", label: "OpenAI" },
			],
			providerTitle: "Embedding provider",
			modelTitle: "Embedding model",
			getProvider: () => LLMInterfaces._embeddingProvider,
			saveProvider: provider => LLMInterfaces.saveEmbeddingProvider(provider),
			getSelectedModel: provider => LLMInterfaces._selectedEmbeddingModel[provider],
			saveSelectedModel: (provider, model) => LLMInterfaces.saveSelectedEmbeddingModel(provider, model),
			listModels: () => LLMInterfaces.listEmbeddingModels(),
			// Keeps LLMCitation's per-(embedding provider,embedding model)
			// "Batch size" in sync with whichever pair is actually selected --
			// same rationale/pattern as the chat Settings row's own onChange
			// in llm-chat-pane.js, just for the embedding pair instead.
			onChange: (provider, model) => {
				LLMCitation.applyAdvancedSettingsFor(provider, model);
				batchSizeRow?.refresh();
			},
		});
		let embeddingModelTable = doc.createElement("table");
		embeddingModelTable.className = "llm-advanced-table";
		let embeddingModelTbody = doc.createElement("tbody");
		embeddingModelTbody.append(this._makeElementRow(doc, "Model", embeddingProviderModelSelect.element));
		embeddingModelTable.appendChild(embeddingModelTbody);
		embeddingsBody.appendChild(embeddingModelTable);
		let embeddingModelHint = doc.createElement("div");
		embeddingModelHint.className = "llm-advanced-field-hint";
		embeddingModelHint.append(
			doc.createTextNode("The model to use for generating textual embeddings. The embeddings are used for semantic search of your documents and for building the context provided to the LLM."),
			doc.createElement("br"),
			doc.createTextNode("NOTE: Changing the model will force recomputation of embeddings for the document on the next user prompt.")
		);
		embeddingsBody.appendChild(embeddingModelHint);

		let embeddingsTable = doc.createElement("table");
		embeddingsTable.className = "llm-advanced-table";
		let embeddingsTbody = doc.createElement("tbody");
		batchSizeRow = this._makeIntegerSettingRow(
			doc,
			"Batch size",
			() => LLMCitation.embedBatchSize,
			(value) => { LLMCitation.saveAdvancedSetting("embedBatchSize", value); }
		);
		embeddingsTbody.append(...batchSizeRow.rows);
		embeddingsTable.appendChild(embeddingsTbody);
		embeddingsBody.appendChild(embeddingsTable);
		let embeddingsHint = doc.createElement("div");
		embeddingsHint.className = "llm-advanced-field-hint";
		embeddingsHint.textContent = "The number of embeddings to send to the embedding endpoint in one batch.";
		embeddingsBody.appendChild(embeddingsHint);

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
				"LLMz",
				`This will irrecovably delete all the selected cache files:\n\n${selected.map(c => c.label).join("\n")}`
			);
			if (!confirmed) {
				return;
			}
			await Promise.all(selected.map(({ clear }) => clear(item)));
			onMessage?.(`Cleared ${selected.map(c => c.label).join(", ")} cache for the active PDF. The next prompt will re-run extraction from scratch.`);
		});
		cacheBody.appendChild(clearCacheButton);

		body.append(contextLabel, contextBody, historyLabel, historyBody, embeddingsLabel, embeddingsBody, cacheLabel, cacheBody);

		details.append(summary, body);
		// Re-syncs every Context/Message history input to LLMPrompt's
		// current values -- call after LLMPrompt.applyAdvancedSettingsFor
		// runs (i.e. whenever the CHAT provider/model selection changes;
		// see ui/provider-model-select.js's onChange, wired up in
		// llm-chat-pane.js's onRender), so an already-rendered Advanced
		// panel reflects the newly-selected pair's own saved settings
		// instead of silently keeping the previous pair's values on screen.
		let refreshPairSettings = () => pairSettingRows.forEach(refresh => refresh());
		return { element: details, clearCacheButton, refreshPairSettings };
	},
};
