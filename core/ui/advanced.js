// Four standalone collapsible settings panels -- Context (the two
// PDF-context-retrieval tunables), Message History (the "Use message
// history" none/last-k/semantic mode select, and its two accompanying caps
// -- Max history messages, Max semantic history messages -- all on
// LLMPrompt), Embeddings (its own provider/model select, pointed at
// LLMInterfaces' separate embedding-provider state, plus the Batch size
// tunable), and Cache (the Clear Cache checkbox list + button). Used to be
// one single "Advanced" dropdown with these as nested subsections; split
// into four independent top-level dropdowns (same disclosure pattern as
// Providers/Keyboard Shortcuts/Logs, see style.css's .llm-advanced-details)
// so each can be opened/collapsed on its own instead of all-or-nothing.
// Split out of chat-pane.js's onRender for the same reason as the other
// ui/ modules.
LLMUIAdvanced = {
	// How many completed papers between each "memory-pressure" nudge during
	// runIndexAll's own worker loop -- see that comment for why this exists
	// (native PDF-parsing memory, observed as macOS's CGPDFService process,
	// growing substantially over a long run). Frequent enough to keep peak
	// memory down across hundreds of papers, infrequent enough not to
	// thrash Gecko's own caches for no benefit on a short run.
	MEMORY_PRESSURE_INTERVAL: 10,

	// Shared (module-level, NOT per-create() call) state for an in-progress
	// Index All run -- { cancelled, subscribers: Set<{ setIndexAllButtonState,
	// setSecondaryButtonsDisabled, setCurrentItem, applyStats }> } while a
	// run is active, else null. Needed because switching the active item/
	// tab tears down and rebuilds this entire Cache section from scratch
	// (see chat-pane.js's onRender calling create() fresh) -- without this,
	// a run started from one pane would become invisible to whichever pane
	// renders next: its buttons would show a fresh, clickable "Index All"
	// with no way to tell a run is already active (inviting a second
	// overlapping run) or to Abort the one actually still executing in the
	// background. create() checks this at build time (see below) and, if
	// set, immediately reflects the running state and registers itself as
	// a subscriber so it keeps receiving progress/completion updates for
	// the rest of that run.
	_activeIndexAllRun: null,

	// A second <tr> placed right after a setting's own row, its description
	// in a single colspan="3" cell -- same visible-caption styling
	// (.llm-advanced-field-hint) as the Embeddings panel's existing "Batch
	// size" hint, just per-ROW instead of one hint below a whole table,
	// since Context has several described rows mixed with undescribed
	// ones. Spans all 3 columns (the label/input columns PLUS the dummy
	// third column every row gets -- see _makeIntegerSettingRow's own
	// comment) rather than just 2, so the description can wrap across the
	// panel's FULL width instead of being squeezed into just the
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

	// Returns { rows, refresh, input } for one setting -- shared table
	// layout with ui/providers.js/ui/keyboard-shortcuts.js, so the input
	// column lines up at the same position for every row regardless of
	// label length. `rows` is an array (length 1, or 2 if `description` is
	// given -- see _makeHintRow above) so a caller can just spread it
	// straight into a <tbody>.append(...) call. `input` is the raw
	// <input>/<select> element itself, for a caller that needs to do more
	// than get/set/refresh it -- e.g. toggling `.disabled` based on some
	// OTHER row's own value (see create()'s own Message History panel,
	// where the "Use message history" mode controls whether the other two
	// rows are editable at all).
	// Every row gets a third, empty, unconstrained <td> after the label/input
	// columns (both of which use `width: 1px` -- shrink-to-fit, see
	// style.css) -- with .llm-advanced-table now stretched to the panel's
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
		return { rows, refresh: () => { input.value = get(); }, input };
	},

	// Same row layout/refresh/input contract as _makeIntegerSettingRow
	// above, but a <select> instead of a number <input> -- for a setting
	// with a small fixed set of named options, like "Use message history"'s
	// none/last-k/semantic modes. `options` is [{ value, label }, ...].
	_makeSelectSettingRow(doc, labelText, get, set, options, { description } = {}) {
		let tr = doc.createElement("tr");
		let labelTd = doc.createElement("td");
		labelTd.className = "llm-advanced-field-label";
		labelTd.textContent = labelText;
		let inputTd = doc.createElement("td");
		inputTd.className = "llm-advanced-field-input";
		let input = doc.createElement("select");
		input.className = "llm-advanced-select";
		for (let { value, label } of options) {
			let option = doc.createElement("option");
			option.value = value;
			option.textContent = label;
			input.appendChild(option);
		}
		input.value = get();
		input.addEventListener("change", () => {
			set(input.value);
		});
		inputTd.appendChild(input);
		tr.append(labelTd, inputTd, doc.createElement("td"));
		let rows = description ? [tr, this._makeHintRow(doc, description)] : [tr];
		return { rows, refresh: () => { input.value = get(); }, input };
	},

	// Same row layout as _makeIntegerSettingRow/_makeSelectSettingRow
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

	// One standalone collapsible panel -- same disclosure pattern as
	// ui/providers.js/ui/keyboard-shortcuts.js (see style.css's
	// .llm-advanced-details, shared across all of them). Returns the
	// <details> element (for the caller to place in the pane's controls)
	// and the body <div> the caller appends that panel's own settings to.
	_makeDetails(doc, title) {
		let details = doc.createElement("details");
		details.className = "llm-advanced-details";
		let summary = doc.createElement("summary");
		summary.textContent = title;
		let body = doc.createElement("div");
		body.className = "llm-collapsible-body llm-advanced-body";
		details.append(summary, body);
		return { details, body };
	},

	// `getActiveItem()` resolves the PDF attachment to clear cache for (the
	// caller's LLMChatPane.getActiveReaderAttachment()). `onMessage(text)` is
	// called for user-facing status text -- routing this (e.g. to the Logs
	// panel) is the caller's concern, not this module's. `clearCacheIconURL`/
	// `refreshIconURL`/`indexAllIconURL`/`indexIconURL`/`clearAllIconURL`/
	// `cancelIconURL` are plain file:/jar: URLs (see chat-pane.js's onRender,
	// rootURI + "res/icons/...svg"), rendered via LLMUIIcon.create.
	// `cancelIconURL` is what Index All swaps to (becoming an Abort button)
	// once running -- see runIndexAll's own comment. `getTranscript()`
	// (chat.exportTranscript, same as ui/button-row.js's own Export button
	// uses) backfills LLMSemanticHistory when the "Use message history" mode
	// switches TO "semantic" -- see the mode row below.
	// Returns { contextElement, messageHistoryElement, embeddingsElement,
	// cacheElement, clearCacheButton, refreshPairSettings } -- four
	// independent <details> panels for the caller to place wherever it
	// wants in the pane's controls (see chat-pane.js's onRender).
	create(doc, { getActiveItem, onMessage, clearCacheIconURL, refreshIconURL, indexAllIconURL, indexIconURL, clearAllIconURL, cancelIconURL, getTranscript } = {}) {
		// Rows built from LLMPrompt's per-(provider,model) advanced settings
		// (see its own comment) -- collected here so create()'s returned
		// refreshPairSettings() can re-sync every one of these inputs after
		// LLMPrompt.applyAdvancedSettingsFor runs on a provider/model change,
		// rather than needing each panel to track its own list.
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

		// --- Context ---
		let { details: contextDetails, body: contextBody } = this._makeDetails(doc, "Context");
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

		// --- Message History ---
		let { details: messageHistoryDetails, body: historyBody } = this._makeDetails(doc, "Message History");
		let historyTable = doc.createElement("table");
		historyTable.className = "llm-advanced-table";
		let historyTbody = doc.createElement("tbody");

		// Built directly via _makeSelectSettingRow/_makeIntegerSettingRow
		// (not the makePairSelectRow/makePairIntegerRow convenience
		// wrappers those other panels use) since these three rows need to
		// reach each other's own `input` elements directly -- toggling
		// maxHistoryRow's/maxSemanticHistoryRow's own `disabled` based on
		// modeRow's current value, something the wrappers (which only
		// return a bare `rows` array for the common case) don't expose.
		let modeRow = this._makeSelectSettingRow(
			doc, "Use message history",
			() => LLMPrompt.useMessageHistory,
			(value) => {
				let wasSemantic = LLMPrompt.useMessageHistory === "semantic";
				LLMPrompt.saveAdvancedSetting("useMessageHistory", value);
				updateHistoryRowsEnabled();
				// Backfills the CURRENT conversation's embeddings in one
				// batched call right when switching TO "semantic" --
				// LLMSemanticHistory.embedNewMessage only runs going
				// forward while mode is "semantic" (see llm/request.js),
				// so without this, every message already in the transcript
				// from before the switch would have no embedding and be
				// silently invisible to selectRelevant's similarity
				// ranking for the rest of this session (it only skips
				// entries with no cached embedding, it doesn't recompute
				// them on a cache miss -- see semantic-history.js's own
				// comment). Skipped if it was ALREADY "semantic" (a no-op
				// reselect, though a plain <select> wouldn't even fire
				// onChange for that) to avoid re-embedding on every
				// unrelated settings tweak.
				if (value === "semantic" && !wasSemantic) {
					LLMSemanticHistory.embedAll(getTranscript?.() ?? []);
				}
			},
			[
				{ value: "none", label: "None" },
				{ value: "last-k", label: "Last K messages" },
				{ value: "semantic", label: "Semantic" },
			],
			{ description: "Determines if (and how) the LLM remembers past messages. \"Last K messages\" resends the most recent turns; \"Semantic\" additionally includes earlier turns that are most relevant to the current question, on top of the last K." }
		);
		let maxHistoryRow = this._makeIntegerSettingRow(
			doc, "Max history messages",
			() => LLMPrompt.maxHistoryMessages,
			(value) => { LLMPrompt.saveAdvancedSetting("maxHistoryMessages", value); },
			{ description: "The number of past messages visible to the LLM." }
		);
		let maxSemanticHistoryRow = this._makeIntegerSettingRow(
			doc, "Max semantic history messages",
			() => LLMPrompt.maxSemanticHistoryMessages,
			(value) => { LLMPrompt.saveAdvancedSetting("maxSemanticHistoryMessages", value); },
			{ description: "The maximum number of additional past messages to include based on relevance to the current question, on top of the last K messages above. Only used in \"Semantic\" mode." }
		);
		pairSettingRows.push(modeRow.refresh, maxHistoryRow.refresh, maxSemanticHistoryRow.refresh);

		// Max history messages is meaningless with history off entirely; Max
		// semantic history messages is meaningless unless "Semantic" mode is
		// actually selected -- called once immediately below (initial
		// render) and again both on the mode select's own change (above) and
		// whenever refreshPairSettings() runs (a provider/model switch can
		// bring in a totally different saved mode for that pair -- see
		// LLMPrompt.applyAdvancedSettingsFor, always called BEFORE
		// refreshPairSettings by whichever caller triggers a pair switch, so
		// LLMPrompt.useMessageHistory is already correct by the time this
		// reads it here regardless of this function's own position in
		// pairSettingRows).
		let updateHistoryRowsEnabled = () => {
			let mode = LLMPrompt.useMessageHistory;
			maxHistoryRow.input.disabled = mode === "none";
			maxSemanticHistoryRow.input.disabled = mode === "none" || mode === "last-k";
		};
		updateHistoryRowsEnabled();
		pairSettingRows.push(updateHistoryRowsEnabled);

		historyTbody.append(...[modeRow.rows, maxHistoryRow.rows, maxSemanticHistoryRow.rows].flat());
		historyTable.appendChild(historyTbody);
		historyBody.appendChild(historyTable);

		// --- Embeddings ---
		// Same row (provider select, model select, refresh button) as the
		// chat Settings row above, but pointed at LLMInterfaces' SEPARATE
		// embedding-provider state -- a user may well want e.g. Anthropic
		// for chat but Ollama for embeddings, so these are never tied
		// together. Anthropic is excluded from providerOptions here since
		// it has no embeddings API of its own (see LLMInterfaces.getEmbedding).
		let { details: embeddingsDetails, body: embeddingsBody } = this._makeDetails(doc, "Embeddings");
		// batchSizeRow assigned further down (Batch size is built AFTER this
		// select, since it needs `embeddingProviderModelSelect` to exist for
		// its own row-building helper's sake -- see below) -- referenced here
		// only inside onChange, which never fires before the whole render
		// function (and therefore batchSizeRow's own assignment) has
		// finished, same reasoning as the chat Settings row's own onChange
		// in chat-pane.js.
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
			listModels: force => LLMInterfaces.listEmbeddingModels(force),
			// Keeps LLMEmbeddings' per-(embedding provider,embedding model)
			// "Batch size" in sync with whichever pair is actually selected --
			// same rationale/pattern as the chat Settings row's own onChange
			// in chat-pane.js, just for the embedding pair instead.
			onChange: (provider, model) => {
				LLMEmbeddings.applyAdvancedSettingsFor(provider, model);
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
			() => LLMEmbeddings.embedBatchSize,
			(value) => { LLMEmbeddings.saveAdvancedSetting("embedBatchSize", value); }
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
		let { details: cacheDetails, body: cacheBody } = this._makeDetails(doc, "Cache");

		// Library index status -- what fraction of "My Library" PDFs have a
		// citation embedding index (LLMCitation's sentence-level cache, the
		// thing that actually makes a PDF searchable/answerable in chat),
		// plus how many library items have a PDF attached at all. Computed
		// async (scanning the whole library -- Zotero.Items.getAll plus a
		// getBestAttachment() lookup per regular item -- can take a couple
		// seconds for a large library), so the bar starts in a "Scanning…"
		// state and fills in once the scan finishes. The action row below
		// it (Refresh/Index All/Clear All) re-runs or acts on this same
		// scan on demand.
		let statusWrapper = doc.createElement("div");
		statusWrapper.className = "llm-cache-status";
		let statusHeader = doc.createElement("div");
		statusHeader.className = "llm-cache-status-header";
		let statusLabel = doc.createElement("span");
		statusLabel.className = "llm-cache-status-label";
		statusLabel.textContent = "Library Index Status";
		statusHeader.append(statusLabel);
		// Four independently-anchored fill bars over one track (see
		// style.css's .llm-cache-status-track/-fill-*) -- the whole track
		// represents every paper in "My Library". Two grow inward from the
		// LEFT: green (fully indexed, indexed/total, anchored at 0%) then
		// cyan immediately to ITS right (partially indexed -- some, but not
		// all, of the seven caches -- text/structure/equations/figures/
		// references/tables/preformatted, see getIndexStatus below -- are
		// present; left = the green bar's own width, not a fixed anchor). Two grow inward
		// from the RIGHT: gray (no PDF attachment at all, anchored at 100%)
		// then red immediately to ITS left (a PDF attachment IS recorded,
		// but the file itself is missing on disk -- a broken link, see
		// getLibraryPapers below -- right = the gray bar's own width).
		// Whatever's left unfilled in the true middle is "has a real PDF
		// file, ZERO caches built yet" -- the actual untouched, actionable
		// remainder, with no dedicated color of its own (it's just the
		// track's own background showing through).
		let statusTrack = doc.createElement("div");
		statusTrack.className = "llm-cache-status-track";
		let statusFillIndexed = doc.createElement("div");
		statusFillIndexed.className = "llm-cache-status-fill-indexed";
		statusFillIndexed.style.width = "0%";
		let statusFillPartial = doc.createElement("div");
		statusFillPartial.className = "llm-cache-status-fill-partial";
		statusFillPartial.style.left = "0%";
		statusFillPartial.style.width = "0%";
		let statusFillNoPDF = doc.createElement("div");
		statusFillNoPDF.className = "llm-cache-status-fill-no-pdf";
		statusFillNoPDF.style.width = "0%";
		let statusFillBroken = doc.createElement("div");
		statusFillBroken.className = "llm-cache-status-fill-broken";
		statusFillBroken.style.right = "0%";
		statusFillBroken.style.width = "0%";
		statusTrack.append(statusFillIndexed, statusFillPartial, statusFillNoPDF, statusFillBroken);
		let statusText = doc.createElement("div");
		statusText.className = "llm-cache-status-text";
		statusText.textContent = "Scanning My Library…";
		let statusHint = doc.createElement("div");
		statusHint.className = "llm-advanced-field-hint";
		// Shows which paper Index All most recently finished (there's no
		// single well-defined "current" item once several run concurrently
		// -- see runIndexAll's own comment) -- empty/untouched outside of an
		// Index All run. The paper title itself is wrapped in its own
		// fixed-width, ellipsis-truncated span (see style.css's
		// .llm-cache-status-current-label) rather than letting the whole
		// line wrap or truncate -- a long title would otherwise push the
		// "(n / m)" counter off to a wildly varying position line to line,
		// or wrap onto a second line and shift the layout below it. The
		// full title is still available on hover via the span's own
		// `title` attribute (a native tooltip).
		let statusCurrentItem = doc.createElement("div");
		statusCurrentItem.className = "llm-advanced-field-hint";
		let statusCurrentItemLabel = doc.createElement("span");
		statusCurrentItemLabel.className = "llm-cache-status-current-label";
		let setCurrentItem = (label, completed, total) => {
			statusCurrentItemLabel.textContent = label;
			statusCurrentItemLabel.title = label;
			statusCurrentItem.replaceChildren(
				doc.createTextNode("Indexing: "),
				statusCurrentItemLabel,
				doc.createTextNode(` (${completed} / ${total})`)
			);
		};
		let clearCurrentItem = () => { statusCurrentItem.textContent = ""; };

		// Refresh re-runs the scan below on demand (e.g. after indexing/
		// clearing elsewhere). Index All indexes every paper that isn't
		// FULLY indexed yet -- partial or none, see getIndexStatus below
		// (runIndexAll below; note that since citation-position is never
		// populated by indexing itself, this means every paper gets
		// re-processed on every run, though cheaply for ones already fully
		// built elsewhere -- see getIndexStatus's own comment). Clear All
		// drops all eight cache directories (including embeddings) for
		// EVERY paper in the library, not just the active one
		// (runClearAll below) -- the destructive counterpart to Index All,
		// hence the red text (same convention as the existing per-PDF Clear
		// Cache button).
		let statusActions = doc.createElement("div");
		statusActions.className = "llm-cache-status-actions";
		let statusRefresh = doc.createElement("button");
		statusRefresh.className = "llm-cache-status-refresh";
		statusRefresh.append(LLMUIIcon.create(doc, refreshIconURL), doc.createTextNode("Refresh"));
		// Swaps between "Index All" (library_books icon) and "Abort" (cancel
		// icon, same one ui/button-row.js's Stop button uses) -- see
		// runIndexAll's own comment for when each state applies. Kept as one
		// button (rather than two, toggling which is shown) so its position
		// in the row doesn't shift.
		let indexAllButton = doc.createElement("button");
		let setIndexAllButtonState = (running) => {
			// Reset here (not just after an Abort click) so a single
			// notify("setIndexAllButtonState", false) -- see the shared
			// LLMUIAdvanced._activeIndexAllRun mechanism further down --
			// uniformly re-enables every pane's own button, including ones
			// that never had Abort clicked on them directly.
			indexAllButton.disabled = false;
			indexAllButton.replaceChildren();
			if (running) {
				indexAllButton.className = "llm-index-all llm-index-all-running";
				indexAllButton.title = "Stop after whatever's currently in flight finishes";
				indexAllButton.append(LLMUIIcon.create(doc, cancelIconURL), doc.createTextNode("Abort"));
			}
			else {
				indexAllButton.className = "llm-index-all";
				indexAllButton.title = "Index every paper with a PDF in My Library that isn't fully indexed yet";
				indexAllButton.append(LLMUIIcon.create(doc, indexAllIconURL), doc.createTextNode("Index All"));
			}
		};
		setIndexAllButtonState(false);
		let clearAllButton = doc.createElement("button");
		clearAllButton.className = "llm-clear-all";
		clearAllButton.title = "Clear the index for every paper in My Library";
		clearAllButton.append(LLMUIIcon.create(doc, clearAllIconURL), doc.createTextNode("Clear All"));
		statusActions.append(statusRefresh, indexAllButton, clearAllButton);

		statusWrapper.append(statusHeader, statusTrack, statusText, statusHint, statusCurrentItem, statusActions);
		cacheBody.appendChild(statusWrapper);

		// "Papers" = regular items only (Zotero.Item.isRegularItem(),
		// journalArticle/book/etc.) -- excludes standalone notes and
		// standalone/loose PDF attachments with no parent regular item,
		// neither of which is "a paper". A paper's own PDF is resolved via
		// getBestAttachment()/isPDFAttachment(), same combination used
		// elsewhere in this plugin (see tools/reference-retrieval.js,
		// chat-pane.js's getActiveReaderAttachment). Scoped to "My Library" only
		// (Zotero.Libraries.userLibraryID), not group libraries.
		// A paper with a recorded PDF attachment whose file is actually
		// MISSING on disk (observed via ENOENT failures from
		// compute-document-structure.js -- moved/renamed outside Zotero, or
		// never actually downloaded under a "files as needed" sync setup)
		// is deliberately NOT counted as a plain "has a PDF" paper --
		// there's nothing for Index All to do with it (every SDT-based
		// extraction step needs the real file and will just fail the same
		// way every time), so it gets its own "broken link" bucket instead
		// (see the red bar above), distinct from "no PDF attachment at
		// all". getFilePath() returns whatever path Zotero's DB *thinks*
		// the file is at -- it does NOT itself verify the file exists,
		// hence the explicit IOUtils.exists check.
		let getLibraryPapers = async () => {
			let topLevelItems = await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, true, false, false);
			let papers = topLevelItems.filter(item => item.isRegularItem());
			let pdfItems = [];
			let noPDFCount = 0;
			let brokenCount = 0;
			for (let paper of papers) {
				let attachment = await paper.getBestAttachment();
				if (!attachment?.isPDFAttachment()) {
					noPDFCount++;
					continue;
				}
				let path = attachment.getFilePath();
				if (!path || !await IOUtils.exists(path)) {
					brokenCount++;
					continue;
				}
				pdfItems.push(attachment);
			}
			return { total: papers.length, pdfItems, noPDFCount, brokenCount };
		};

		// "Fully indexed" = every one of the seven caches this paper's PDF
		// can have is present (text, structure, equations, figures,
		// references, tables, preformatted -- seven of the nine checkboxes
		// listed further down under Active Title Cache, everything except
		// Citations and Embeddings). "Partial" = some but not all -- a very
		// real state in practice (e.g. an embedding-provider quota error
		// leaves text missing while tables/figures/etc. still built fine, or
		// vice versa; see the ENOENT/429 cases already observed). "None" =
		// zero. Each module's own hasCache(item) is a cheap disk existence
		// check, no content read. Citation-position is deliberately
		// excluded here -- unlike the other seven, it's NEVER populated by
		// Index/Index All itself (LLMUIIndexAll's own _indexItem never
		// touches LLMCitationPosition at all), only by actually clicking/
		// resolving a citation link during chat, so requiring it would mean
		// no paper could ever reach "full" from indexing alone. Single-item
		// -- used by runIndexAll's own worker loop to re-check just the ONE
		// paper it just finished extracting (see its own comment on why
		// result.ok alone isn't trusted there); a per-item check is the
		// right amount of work for that case, unlike scanning the WHOLE
		// library (see getIndexStatusBulk below, used for that instead).
		let getIndexStatus = async (item) => {
			let present = await Promise.all([
				LLMCitation.hasCache(item),
				LLMCitationPosition.hasCache(item),
				LLMEquations.hasCache(item),
				LLMFigures.hasCache(item),
				LLMReferences.hasCache(item),
				LLMTables.hasCache(item),
				LLMPreformatted.hasCache(item),
			]);
			let count = present.filter(Boolean).length;
			if (count === present.length) return "full";
			if (count === 0) return "none";
			return "partial";
		};

		// Reads one cache dir's own file list and returns the set of item
		// ids (as numbers) it holds -- "${item.id}.json" is the naming
		// convention every _cacheDir()-based module uses (see hasCache's
		// own PathUtils.join(dir, `${item.id}.json`) above). A missing/
		// unreadable dir resolves to an empty set, same tolerance a single
		// IOUtils.exists() check already had for "nothing cached yet".
		let listCachedIds = async (cacheDir) => {
			let ids = new Set();
			let entries;
			try {
				entries = await IOUtils.getChildren(cacheDir);
			}
			catch (e) {
				return ids;
			}
			for (let path of entries) {
				let filename = PathUtils.filename(path);
				if (!filename.endsWith(".json")) continue;
				let id = parseInt(filename.slice(0, -".json".length), 10);
				if (!Number.isNaN(id)) ids.add(id);
			}
			return ids;
		};
		let intersectSets = (sets) => {
			let [first, ...rest] = sets;
			let result = new Set();
			for (let id of first) {
				if (rest.every(s => s.has(id))) result.add(id);
			}
			return result;
		};
		let unionSets = (sets) => {
			let result = new Set();
			for (let s of sets) for (let id of s) result.add(id);
			return result;
		};
		let differenceSets = (a, b) => {
			let result = new Set();
			for (let id of a) if (!b.has(id)) result.add(id);
			return result;
		};

		// Library-wide replacement for calling getIndexStatus(item) once
		// per pdfItem, i.e. 7*N individual IOUtils.exists() disk checks for
		// an N-paper library -- lists each of the seven cache dirs exactly
		// ONCE (7 IOUtils.getChildren() calls total, regardless of library
		// size) instead, then classifies every paper via in-memory Set
		// membership: fully indexed = intersection of all seven id sets,
		// partially indexed = (union of all seven) minus that intersection,
		// unindexed = pdfItems minus the union. Both fully/partially are
		// additionally intersected with pdfItems' own id set -- a cache dir
		// can hold stale .json files for items getLibraryPapers has already
		// excluded (deleted from the library since, or whose PDF went
		// missing/broken since it was indexed); counting those would
		// inflate the counts past `total` and send applyStats' own
		// percentage math negative. Returns a Map (item.id -> "full"/
		// "partial"/"none"), the same per-item classification getIndexStatus
		// returns (including its own deliberate omission of citation-
		// position, see that function's own comment), so scanLibrary/
		// runIndexAll's own downstream consumers don't need to change.
		let getIndexStatusBulk = async (pdfItems) => {
			let cacheDirs = await Promise.all([
				LLMCitation._cacheDir(),
				LLMCitationPosition._structureCacheDir(),
				LLMEquations._cacheDir(), LLMFigures._cacheDir(),
				LLMReferences._cacheDir(), LLMTables._cacheDir(),
				LLMPreformatted._cacheDir(),
			]);
			let cacheSets = await Promise.all(cacheDirs.map(listCachedIds));
			let pdfIdSet = new Set(pdfItems.map(item => item.id));
			let fullSet = intersectSets(cacheSets);
			let anySet = unionSets(cacheSets);
			let fullyIndexedSet = intersectSets([fullSet, pdfIdSet]);
			let partiallyIndexedSet = intersectSets([differenceSets(anySet, fullSet), pdfIdSet]);
			let unindexedSet = differenceSets(pdfIdSet, anySet);
			let statuses = new Map();
			for (let id of fullyIndexedSet) statuses.set(id, "full");
			for (let id of partiallyIndexedSet) statuses.set(id, "partial");
			for (let id of unindexedSet) statuses.set(id, "none");
			return statuses;
		};

		// Updates the bar/text from already-known counts -- split out of
		// refreshLibraryIndexStatus below so runIndexAll's own progress
		// loop can update the SAME bar live, per completed item, without
		// re-scanning the whole library on every tick. noPDFCount/
		// brokenCount don't change during an Index All run (only
		// fullyIndexed/partiallyIndexed do, as papers with a real file get
		// processed), so callers just pass through whatever scanLibrary
		// last returned for those two.
		let applyStats = (total, noPDFCount, brokenCount, fullyIndexed, partiallyIndexed) => {
			let pdfCount = total - noPDFCount - brokenCount;
			let notIndexed = pdfCount - fullyIndexed - partiallyIndexed;
			let fullyPct = total > 0 ? (fullyIndexed / total) * 100 : 0;
			let partialPct = total > 0 ? (partiallyIndexed / total) * 100 : 0;
			let noPDFPct = total > 0 ? (noPDFCount / total) * 100 : 0;
			let brokenPct = total > 0 ? (brokenCount / total) * 100 : 0;
			statusFillIndexed.style.width = `${fullyPct}%`;
			statusFillPartial.style.left = `${fullyPct}%`;
			statusFillPartial.style.width = `${partialPct}%`;
			statusFillNoPDF.style.width = `${noPDFPct}%`;
			statusFillBroken.style.right = `${noPDFPct}%`;
			statusFillBroken.style.width = `${brokenPct}%`;
			statusText.textContent = `${fullyIndexed} / ${total} papers fully indexed (${Math.round(fullyPct)}%)`;
			// Each clause colored to match its own bar segment
			// (.llm-cache-status-fill-partial/-broken/-no-pdf) -- "not
			// indexed" deliberately stays uncolored, same as its bar
			// segment (the plain track background). Broken-link is listed
			// before no-PDF (matches the bar's own right-to-left order:
			// no-PDF is the outermost/rightmost segment, broken sits just
			// inside it).
			let partialSpan = doc.createElement("span");
			partialSpan.className = "llm-cache-status-text-partial";
			partialSpan.textContent = `${partiallyIndexed} paper${partiallyIndexed === 1 ? "" : "s"} partially indexed`;
			let brokenSpan = doc.createElement("span");
			brokenSpan.className = "llm-cache-status-text-broken";
			brokenSpan.textContent = `${brokenCount} paper${brokenCount === 1 ? "" : "s"} have a broken PDF link`;
			let noPDFSpan = doc.createElement("span");
			noPDFSpan.className = "llm-cache-status-text-no-pdf";
			noPDFSpan.textContent = `${noPDFCount} paper${noPDFCount === 1 ? "" : "s"} have no PDF`;
			statusHint.replaceChildren(
				partialSpan,
				doc.createTextNode(` · ${notIndexed} paper${notIndexed === 1 ? "" : "s"} not indexed · `),
				brokenSpan,
				doc.createTextNode(" · "),
				noPDFSpan,
				doc.createTextNode(".")
			);
		};

		let setActionsDisabled = (disabled) => {
			statusRefresh.disabled = disabled;
			indexAllButton.disabled = disabled;
			clearAllButton.disabled = disabled;
		};

		// The actual scan (no button-disabling of its own) -- returns
		// { total, pdfItems, statuses } (statuses[i] is pdfItems[i]'s own
		// "full"/"partial"/"none", see getIndexStatus above) and updates
		// the bar as a side effect. Split out from refreshLibraryIndexStatus
		// below so runIndexAll/runClearAll, which each manage their OWN
		// disabled state across a longer operation that ends with a
		// re-scan, don't have this flicker the buttons re-enabled partway
		// through.
		let scanLibrary = async () => {
			statusText.textContent = "Scanning My Library…";
			let { total, pdfItems, noPDFCount, brokenCount } = await getLibraryPapers();
			let statusMap = await getIndexStatusBulk(pdfItems);
			let statuses = pdfItems.map(item => statusMap.get(item.id));
			let fullyIndexed = statuses.filter(s => s === "full").length;
			let partiallyIndexed = statuses.filter(s => s === "partial").length;
			applyStats(total, noPDFCount, brokenCount, fullyIndexed, partiallyIndexed);
			return { total, pdfItems, statuses, noPDFCount, brokenCount };
		};

		// Refresh button handler -- owns its own disabled state around one
		// bare scan, unlike runIndexAll/runClearAll below.
		let refreshLibraryIndexStatus = async () => {
			setActionsDisabled(true);
			try {
				await scanLibrary();
			}
			catch (e) {
				statusText.textContent = `Failed to scan library: ${e.message}`;
			}
			finally {
				setActionsDisabled(false);
			}
		};
		statusRefresh.addEventListener("click", () => refreshLibraryIndexStatus());

		// Indexes every paper that ISN'T fully indexed yet (status
		// "partial" or "none", per getIndexStatus -- a partial paper is
		// included since _indexItem's six extraction steps already only
		// (re)compute whatever's actually missing, each stage reading its
		// own cache first, so re-running it on an already-partial paper
		// just fills the gaps rather than redoing completed work). Runs via
		// LLMUIIndexAll._indexItem -- the same per-paper extraction logic
		// (tables/figures/references/equations/preformatted/citation
		// embeddings), reporting progress through this panel's own bar. Worker-pool
		// concurrency, level from LLMUIIndexAll.CONCURRENCY_LEVEL --
		// several papers' extraction pipelines running at once lets their
		// network-bound embedding calls overlap instead of sitting fully
		// idle between one paper's own sequential steps. Progress reflects
		// the most recently COMPLETED paper, not "about to start" -- with
		// several in flight at once, there's no single well-defined
		// "current" paper to show before the fact.
		//
		// indexAllButton doubles as Abort while this runs (see
		// setIndexAllButtonState) -- clicking it sets the shared run's
		// `cancelled` flag, which stops each worker from picking up a NEW
		// item, but doesn't force-abort whichever items are already
		// mid-extraction; there's no cheap way to do that (would need
		// AbortController plumbing through every network call/subprocess
		// spawn _indexItem makes). Those still finish and populate their
		// own caches normally -- the button only flips back to "Index All"
		// once the whole worker pool has actually settled, not the instant
		// Abort is clicked.
		//
		// This render's own UI-update functions, bundled as one subscriber
		// -- registered on this._activeIndexAllRun below, either
		// immediately (if a run started from a DIFFERENT pane is already
		// active when this panel is built) or when runIndexAll itself
		// starts one from THIS pane. Either way, every subscribed pane's
		// buttons/bar/current-item line track the SAME run.
		let indexAllSubscriber = {
			// Used by notifyIndexAllRun below to prune this subscriber once
			// its pane is no longer part of the live document (e.g. this
			// same tab re-rendered again, or was closed) -- Node.isConnected
			// is a cheap, native "is this still attached" check. Any element
			// created in this create() call works as the anchor; statusWrapper
			// (the root of this whole status block) is as good as any.
			element: statusWrapper,
			setIndexAllButtonState,
			setSecondaryButtonsDisabled: (disabled) => {
				statusRefresh.disabled = disabled;
				clearAllButton.disabled = disabled;
			},
			setCurrentItem,
			clearCurrentItem,
			applyStats,
		};
		// Also stashes the latest args for "setCurrentItem"/"applyStats" on
		// the run itself (runState.lastArgs), so a pane that starts
		// subscribing mid-run (see below) can be initialized immediately
		// with the current progress instead of showing a blank bar until
		// the next item happens to complete. Prunes any subscriber whose
		// own pane is no longer attached to the document (closed, or
		// re-rendered again under a NEW subscriber object -- see
		// indexAllSubscriber's own comment) on every call, rather than
		// letting the set grow unboundedly over a run spanning hundreds of
		// papers if a pane re-renders more than once mid-run.
		let notifyIndexAllRun = (runState, fn, ...args) => {
			if (fn === "setCurrentItem" || fn === "applyStats") {
				runState.lastArgs[fn] = args;
			}
			for (let subscriber of [...runState.subscribers]) {
				if (!subscriber.element.isConnected) {
					runState.subscribers.delete(subscriber);
					continue;
				}
				try { subscriber[fn]?.(...args); }
				catch (e) { this.log(`notifyIndexAllRun(${fn}): subscriber failed: ${e.message}`); }
			}
		};

		// A run may already be active from a different pane -- reflect
		// that immediately rather than rendering a fresh, clickable
		// "Index All" that would invite a second overlapping run.
		if (this._activeIndexAllRun) {
			let runState = this._activeIndexAllRun;
			runState.subscribers.add(indexAllSubscriber);
			setIndexAllButtonState(true);
			indexAllSubscriber.setSecondaryButtonsDisabled(true);
			if (runState.lastArgs.applyStats) indexAllSubscriber.applyStats(...runState.lastArgs.applyStats);
			if (runState.lastArgs.setCurrentItem) indexAllSubscriber.setCurrentItem(...runState.lastArgs.setCurrentItem);
		}

		let runIndexAll = async () => {
			if (this._activeIndexAllRun) return; // safety net -- the click handler below routes to Abort instead once a run exists
			let runState = { cancelled: false, subscribers: new Set([indexAllSubscriber]), lastArgs: {} };
			this._activeIndexAllRun = runState;
			let notify = (fn, ...args) => notifyIndexAllRun(runState, fn, ...args);
			notify("setIndexAllButtonState", true);
			notify("setSecondaryButtonsDisabled", true);
			try {
				let { total, pdfItems, statuses, noPDFCount, brokenCount } = await scanLibrary();
				let needsIndexing = pdfItems
					.map((item, i) => ({ item, oldStatus: statuses[i] }))
					.filter(({ oldStatus }) => oldStatus !== "full");
				if (!needsIndexing.length) {
					onMessage?.("Index All: every paper with a PDF is already fully indexed.");
					return;
				}
				// Live running counts, adjusted per-item below as each one's
				// status transitions (none/partial -> partial/full) --
				// starts from the already-fully-indexed papers (excluded
				// above) plus however many of the not-yet-touched papers
				// already happen to be "partial".
				let liveFullyIndexed = pdfItems.length - needsIndexing.length;
				let livePartiallyIndexed = statuses.filter(s => s === "partial").length;
				let baseText = `Index All: indexing ${needsIndexing.length} paper${needsIndexing.length === 1 ? "" : "s"} (up to ${LLMUIIndexAll.CONCURRENCY_LEVEL} at once)…`;
				let logEl = onMessage?.(baseText);
				let completed = 0, succeeded = 0, failed = 0;
				let nextIndex = 0;
				let worker = async () => {
					while (nextIndex < needsIndexing.length) {
						if (runState.cancelled) return;
						let { item, oldStatus } = needsIndexing[nextIndex++];
						let result = await LLMUIIndexAll._indexItem(item, onMessage);
						if (!result.ok) failed++;
						completed++;
						// Every _indexItem call that hits LLMPrompt.getAttachmentFullText's
						// PDFWorker fallback (any paper without Zotero's own
						// .zotero-ft-cache file yet) opens a native PDF
						// context outside this plugin's own pdf.js/Skia
						// pipeline -- observed to grow macOS's CGPDFService
						// process's memory substantially over a long run,
						// apparently not released between documents on its
						// own. "memory-pressure" is Gecko's own documented
						// observer topic for prompting caches across the
						// engine (including native PDF workers) to release
						// what they can -- nudging it periodically here,
						// rather than once at the very end, keeps peak
						// memory down across a run of hundreds of papers
						// instead of letting it climb unchecked throughout.
						if (completed % this.MEMORY_PRESSURE_INTERVAL === 0) {
							Services.obs.notifyObservers(null, "memory-pressure", "heap-minimize");
						}
						let label = LLMUIIndexAll._labelFor(item);
						notify("setCurrentItem", label, completed, needsIndexing.length);
						// Ground-truth re-check, NOT result.ok -- _indexItem
						// wraps each extraction step in its own .catch() (an
						// embedding-provider error, a PDF file missing on
						// disk, or a PDF with no extractable text at all all
						// leave the corresponding cache unbuilt but still
						// return {ok: true} overall), so trusting result.ok
						// here would let the live bar count a paper as (more)
						// indexed than the final re-scan (which DOES check
						// the real cache files) then agrees with -- exactly
						// the "bar jumps back down at the end" bug this
						// replaced.
						let newStatus = await getIndexStatus(item);
						if (oldStatus === "partial") livePartiallyIndexed--;
						if (newStatus === "full") { liveFullyIndexed++; succeeded++; }
						else if (newStatus === "partial") livePartiallyIndexed++;
						notify("applyStats", total, noPDFCount, brokenCount, liveFullyIndexed, livePartiallyIndexed);
						if (logEl) logEl.textContent = `${baseText} ${LLMCitation._formatProgressBar(completed, needsIndexing.length)} — ${label}`;
					}
				};
				await Promise.all(Array.from({ length: Math.min(LLMUIIndexAll.CONCURRENCY_LEVEL, needsIndexing.length) }, () => worker()));
				let summary = runState.cancelled
					? `Aborted after ${completed} / ${needsIndexing.length} paper${needsIndexing.length === 1 ? "" : "s"} (${succeeded} newly fully indexed).`
					: `${succeeded} / ${needsIndexing.length} paper${needsIndexing.length === 1 ? "" : "s"} newly fully indexed${failed ? ` (${failed} failed -- see Logs/console for details)` : ""}.`;
				notify("clearCurrentItem");
				if (logEl) logEl.textContent = `Index All: ${summary}`;
				else onMessage?.(`Index All: ${summary}`);
			}
			catch (e) {
				onMessage?.(`Index All: failed (${e.message}).`);
			}
			finally {
				this._activeIndexAllRun = null;
				notify("setIndexAllButtonState", false);
				notify("setSecondaryButtonsDisabled", false);
				await scanLibrary().catch(() => {});
			}
		};
		indexAllButton.addEventListener("click", () => {
			if (this._activeIndexAllRun) {
				this._activeIndexAllRun.cancelled = true;
				indexAllButton.disabled = true;
				indexAllButton.title = "Stopping…";
			}
			else {
				runIndexAll();
			}
		});

		// Drops all nine cache directories (text, structure,
		// citation-position, equations, figures, references, tables,
		// preformatted, embeddings -- the seven getIndexStatus checks, plus
		// citation-position and embeddings, neither of which count toward
		// "fully indexed" but should still be wiped by a full reset) for
		// EVERY paper in the library at once, via whole-directory wipes
		// rather than per-paper/per-kind clearing (see its own comment) --
		// the exact counterpart to Index All/the bar's own definition of
		// "fully indexed", so this always resets the bar to 0%.
		// Irreversible, hence the confirm prompt.
		let runClearAll = async () => {
			let confirmed = Services.prompt.confirm(
				doc.defaultView,
				"LLMz",
				"Are you sure you want to clear the index for all files? This action is irreversible."
			);
			if (!confirmed) return;
			setActionsDisabled(true);
			try {
				let { pdfItems } = await getLibraryPapers();
				// Wipes every on-disk cache directory wholesale (recursive
				// unlink + recreate empty) instead of iterating per paper
				// per cache type -- "clear everything" doesn't need
				// per-item granularity, so this replaces what used to be
				// thousands of individual IOUtils.remove calls (and, for
				// embeddings specifically, TWO Python subprocess spawns per
				// paper -- see this session's own bottleneck diagnosis,
				// each one paying full interpreter startup + venv
				// resolution + sqlite-vec extension load, then serializing
				// against every other paper's own spawn on the SAME
				// per-model .sqlite file's write lock) with 9
				// directory-level operations total, regardless of library
				// size. The embeddings dir (LLMEmbeddingsDB._dbDir(),
				// holding every per-model .sqlite file) is wiped the exact
				// same way -- db.py's own _get_or_create_table already
				// creates a fresh table lazily on the next real write, so
				// there's nothing to eagerly recreate, let alone a
				// subprocess call needed to do it here.
				let dirs = await Promise.all([
					LLMCitation._cacheDir(),
					LLMCitationPosition._structureCacheDir(),
					LLMCitationPosition._positionCacheDir(),
					LLMEquations._cacheDir(),
					LLMFigures._cacheDir(),
					LLMReferences._cacheDir(),
					LLMTables._cacheDir(),
					LLMPreformatted._cacheDir(),
					LLMEmbeddingsDB._dbDir(),
				]);
				await Promise.all(dirs.map(async (dir) => {
					await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
					await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
				}));
				// Every module's own in-memory Map also needs clearing --
				// deleting the disk files alone would leave an
				// already-loaded item's data silently served from memory
				// (stale, no longer backed by anything on disk) for the
				// rest of this Zotero session.
				LLMCitation._indexCache.clear();
				LLMCitationPosition._positionCache.clear();
				LLMCitationPosition._structureCache.clear();
				LLMCitationPosition._textIndexCache.clear();
				LLMEquations._indexCache.clear();
				LLMFigures._indexCache.clear();
				LLMReferences._indexCache.clear();
				LLMTables._indexCache.clear();
				LLMPreformatted._indexCache.clear();
				onMessage?.(`Clear All: cleared the index for ${pdfItems.length} paper${pdfItems.length === 1 ? "" : "s"}.`);
			}
			catch (e) {
				onMessage?.(`Clear All: failed (${e.message}).`);
			}
			finally {
				await scanLibrary().catch(() => {});
				setActionsDisabled(false);
			}
		};
		clearAllButton.addEventListener("click", () => runClearAll());

		// Skipped if a run is already active (see the this._activeIndexAllRun
		// check above) -- refreshLibraryIndexStatus's own setActionsDisabled(false)
		// in its finally would otherwise re-enable Refresh/Clear All right
		// after they were just disabled for the active run, and the
		// subscription already registered above keeps this render's bar in
		// sync for the rest of that run without needing an extra scan here.
		if (!this._activeIndexAllRun) {
			refreshLibraryIndexStatus();
		}

		let cacheTypes = [
			{
				// LLMz/cache/text/ -- the sentence/paragraph text itself
				// (see citation.js's getTextIndex/clearTextCache). Separate
				// from "Embeddings" below -- clearing just the disk JSON
				// forces a re-derive from the SDT structure, but since
				// that's byte-for-byte deterministic, the existing
				// embeddings usually still match and don't need
				// recomputing.
				label: "Text",
				hasCache: item => LLMCitation.hasCache(item),
				clear: item => LLMCitation.clearTextCache(item),
			},
			{
				// This item's sentence/paragraph embeddings in the
				// embeddings DB, under the currently selected model (see
				// citation.js's hasEmbeddingsCache/clearEmbeddingsCache).
				// Separate from "Text" above so re-embedding (e.g. after
				// switching providers, or suspecting a corrupted vector)
				// doesn't require redoing SDT-derived sentence splitting.
				label: "Embeddings",
				hasCache: item => LLMCitation.hasEmbeddingsCache(item),
				clear: item => LLMCitation.clearEmbeddingsCache(item),
			},
			{
				// LLMz/cache/structure/ -- the SDT structure blob,
				// structure.json (see document/citations.js's
				// hasCache/clearStructureCache). Shared with references/
				// equations/tables/figures extraction, not citation-
				// specific -- clearing it can trigger a real SDT
				// recomputation the NEXT time any of those four also need
				// to rebuild their own cache, not immediately.
				label: "Structure",
				hasCache: item => LLMCitationPosition.hasCache(item),
				clear: item => LLMCitationPosition.clearStructureCache(item),
			},
			{
				// LLMz/cache/citation-position/ -- the resolved query ->
				// {pageIndex, rects} cache for every citation link already
				// clicked/matched (see document/citations.js's
				// hasPositionCache/clearPositionCache). Forces every
				// citation link to be freshly re-matched against the
				// (untouched) structure/text index next time it's clicked.
				label: "Citations",
				hasCache: item => LLMCitationPosition.hasPositionCache(item),
				clear: item => LLMCitationPosition.clearPositionCache(item),
			},
			{ label: "Equations", hasCache: item => LLMEquations.hasCache(item), clear: item => LLMEquations.clearCache(item) },
			{ label: "Figures", hasCache: item => LLMFigures.hasCache(item), clear: item => LLMFigures.clearCache(item) },
			{ label: "References", hasCache: item => LLMReferences.hasCache(item), clear: item => LLMReferences.clearCache(item) },
			{ label: "Tables", hasCache: item => LLMTables.hasCache(item), clear: item => LLMTables.clearCache(item) },
			{ label: "Preformatted", hasCache: item => LLMPreformatted.hasCache(item), clear: item => LLMPreformatted.clearCache(item) },
		];

		// Header for the per-active-paper checkbox list + Clear Cache
		// button below -- distinguishes this (acts on whichever PDF is
		// currently open) from the "Library Index Status" section above
		// (acts on every paper in My Library).
		let cacheOptionsLabel = doc.createElement("div");
		cacheOptionsLabel.className = "llm-cache-status-label";
		cacheOptionsLabel.textContent = "Active Title Cache";
		cacheBody.appendChild(cacheOptionsLabel);

		let cacheOptionsList = doc.createElement("div");
		cacheOptionsList.className = "llm-clear-cache-options";
		// Checked by default, so clicking Clear Cache without touching any
		// checkbox still clears everything, same as before this became
		// selectable -- then immediately uncheck whichever types have
		// nothing cached for the CURRENTLY ACTIVE paper (see below), so
		// Clear Cache doesn't visually offer to clear a cache that was
		// never actually populated in the first place.
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

		// Unchecks whichever checkboxes have nothing cached for the
		// CURRENTLY ACTIVE paper -- called once below at panel build time,
		// and again after Clear Cache actually clears something, so the
		// checkboxes reflect ground truth (a fresh disk check) rather than
		// just assuming the clear worked. Best-effort/async (hasCache is a
		// disk check) -- if there's no active paper, or a check fails, just
		// leaves whatever state that checkbox already had.
		let refreshCacheCheckboxes = async () => {
			let item = getActiveItem?.();
			if (!item) return;
			let present = await Promise.all(cacheTypes.map(({ hasCache }) => hasCache(item).catch(() => true)));
			present.forEach((has, i) => {
				if (!has) cacheCheckboxes[i].checked = false;
			});
		};
		refreshCacheCheckboxes();

		// Row for the two per-active-paper actions -- Index (build) and Clear
		// Cache (destroy) -- same side-by-side flex-row treatment as the
		// Library Index Status bar's own Refresh/Index All/Clear All row
		// above (.llm-cache-status-actions).
		let activeTitleActions = doc.createElement("div");
		activeTitleActions.className = "llm-cache-status-actions";

		// Runs the exact same per-paper extraction pipeline as "Index All"
		// (LLMUIIndexAll._indexItem -- text (sentences/paragraphs), tables,
		// figures, references, equations, preformatted), just for the single currently-active PDF,
		// so a specific paper (e.g. one a cross-library question needs, see
		// LLMCitation.getCrossLibraryChunks) can be pre-warmed on demand
		// without waiting for/running a full-library Index All pass. Doesn't
		// check getIndexStatus first (unlike Index All, which skips already-
		// FULLY-indexed papers) -- this button is also the way to force a
		// clean re-index of a paper whose cache is only PARTIAL, so it always
		// runs regardless of current status; refreshCacheCheckboxes() below
		// then reflects whatever's actually on disk afterward either way.
		let indexButton = doc.createElement("button");
		indexButton.className = "llm-index-active";
		indexButton.title = "Fully index (cache) the active PDF -- text (sentences/paragraphs), tables, figures, references, and equations";
		indexButton.append(LLMUIIcon.create(doc, indexIconURL), doc.createTextNode("Index"));
		indexButton.addEventListener("click", async () => {
			let item = getActiveItem?.();
			if (!item) {
				onMessage?.("Index: no active PDF.");
				return;
			}
			let label = LLMUIIndexAll._labelFor(item);
			indexButton.disabled = true;
			let logEl = onMessage?.(`Indexing "${label}"…`);
			try {
				let result = await LLMUIIndexAll._indexItem(item, onMessage);
				let text = result.ok
					? `Indexed "${label}".`
					: `Indexing "${label}" failed: ${result.error}`;
				if (logEl) logEl.textContent = text;
				else onMessage?.(text);
			}
			finally {
				indexButton.disabled = false;
				await refreshCacheCheckboxes();
				// Keeps the Library Index Status bar in sync with this one
				// paper's own newly-built caches, without waiting for the
				// user to click that bar's own Refresh -- skipped while an
				// Index All run is active (same guard as this pane's own
				// initial scan below) since that run already keeps the bar
				// live via its own per-item applyStats updates, and a second
				// concurrent scanLibrary() here would just be redundant work
				// racing it.
				if (!this._activeIndexAllRun) {
					await refreshLibraryIndexStatus();
				}
			}
		});
		activeTitleActions.appendChild(indexButton);

		let clearCacheButton = doc.createElement("button");
		clearCacheButton.className = "llm-clear-cache";
		clearCacheButton.title = "Clear the checked caches, for this PDF only";
		clearCacheButton.append(LLMUIIcon.create(doc, clearCacheIconURL), doc.createTextNode("Clear"));
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
			LLMPrompt.noteCacheCleared(item, selected.map(c => c.label));
			onMessage?.(`Cleared ${selected.map(c => c.label).join(", ")} cache for the active PDF. The next prompt will re-run extraction from scratch.`);
			await refreshCacheCheckboxes();
			// See indexButton's own comment on this same guard/call.
			if (!this._activeIndexAllRun) {
				await refreshLibraryIndexStatus();
			}
		});
		activeTitleActions.appendChild(clearCacheButton);
		cacheBody.appendChild(activeTitleActions);

		// Re-syncs every Context/Message History input to LLMPrompt's
		// current values -- call after LLMPrompt.applyAdvancedSettingsFor
		// runs (i.e. whenever the CHAT provider/model selection changes;
		// see ui/provider-model-select.js's onChange, wired up in
		// chat-pane.js's onRender), so an already-rendered panel reflects
		// the newly-selected pair's own saved settings instead of silently
		// keeping the previous pair's values on screen.
		let refreshPairSettings = () => pairSettingRows.forEach(refresh => refresh());
		return {
			contextElement: contextDetails,
			messageHistoryElement: messageHistoryDetails,
			embeddingsElement: embeddingsDetails,
			cacheElement: cacheDetails,
			clearCacheButton,
			refreshPairSettings,
		};
	},
};
