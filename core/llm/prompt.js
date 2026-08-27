// Builds the prompt sent to the answering model: the shared system prompt
// (citation/table/figure/equation link-format instructions), assembling PDF
// context (full text, or the most relevant retrieved chunks when the full
// text doesn't fit) via buildPromptWithActivePDFContext, and the LLM-based
// "pick the most relevant X for this question" selection helpers
// (select{Figure,Table,Equation}WithLLM) plus their corresponding
// <TABLE_CONTEXT>/<REFERENCE_CONTEXT>/<EQUATION_CONTEXT> formatting helpers.
// Split out from chat-pane.js since this is a self-contained concern
// (what goes into the prompt, and how) distinct from the chat pane's own
// UI/rendering logic and Zotero-reader-interaction plumbing
// (getActiveReaderAttachment etc., which stay in chat-pane.js since
// they're used well beyond prompt-building -- e.g. message-history keying --
// and are called back into from here where needed) -- same rationale as the
// llm/interfaces.js split.
LLMPrompt = {
	// The properties below (through maxHistoryMessages) are the "advanced
	// settings" tunable via ui/advanced.js's Context/Message history
	// sections -- unlike a plain global preference, these are persisted PER
	// (chat provider, chat model) PAIR (see _advancedSettingsPref/
	// loadAdvancedSettings/applyAdvancedSettingsFor/saveAdvancedSetting
	// below), the same way LLMInterfaces persists the provider/model
	// SELECTION itself. Most of these are really tuning a specific model's
	// own context budget (e.g. a smaller local model needs a tighter
	// maxPDFContextChars than a large-context cloud model, and a slower
	// local model benefits from a smaller maxSelectedFigures to keep
	// prompts cheap), so a single global value doesn't fit well once a user
	// switches between more than one provider/model. The values below are
	// only the DEFAULTS (also see _advancedSettingDefaults, which must stay
	// in sync with these) -- applyAdvancedSettingsFor overwrites them as
	// soon as loadAdvancedSettings runs at startup (see bootstrap.js) with
	// whatever's saved for the initially-selected pair, if anything.
	maxPDFContextChars: 60000,
	maxPageContextChars: 5000,
	chunkContextTopK: 10,
	// How many cross-library chunks (see shouldIncludeCrossLibraryWithLLM/
	// LLMCitation.getCrossLibraryChunks) get attached when the model decides
	// a question needs OTHER papers, not just the current one -- used TWICE
	// by getCrossLibraryChunks (a paragraph-only search and an any-kind
	// search, unioned -- see its own comment), so up to 2x this many chunks
	// can actually be attached, not a hard cap of exactly this many. Same
	// not-exposed-in-Advanced-yet status as maxPageContextChars above.
	crossLibraryTopK: 10,
	// Caps on how many figures/tables/equations selectFiguresWithLLM/
	// selectTablesWithLLM/selectEquationsWithLLM will attach as context for a
	// single request, even if the model's own selection response names more
	// than this -- each attached figure in particular is a rendered image
	// (llm/request.js's _buildImageContext), so a higher cap trades more context
	// for a larger, more expensive prompt.
	maxSelectedFigures: 10,
	maxSelectedTables: 20,
	maxSelectedEquations: 40,
	// Whether/how a request resends prior turns (see chat.exportTranscript())
	// to the model as conversation history -- one of three modes, toggled via
	// ui/advanced.js's "Use message history" dropdown:
	//   "none"     -- just the current prompt alone (the original,
	//                 single-turn-only behavior). Trades conversation
	//                 continuity for lower per-request token usage, since no
	//                 past turn ever gets resent.
	//   "last-k"   -- the last maxHistoryMessages transcript entries, plain
	//                 recency cutoff (the ORIGINAL always-on behavior, from
	//                 back when this was a plain boolean -- see llm/request.js's
	//                 own handling of a stale persisted `true`/`false` from
	//                 before this became a 3-way enum).
	//   "semantic" -- union(last maxHistoryMessages entries, top
	//                 maxSemanticHistoryMessages entries by embedding
	//                 similarity to the current query) -- see
	//                 semantic-history.js's LLMSemanticHistory.selectRelevant,
	//                 which this mode delegates to. Can recover long-range
	//                 relevant context a pure recency cutoff would drop (e.g.
	//                 "what was that number you mentioned earlier?" many
	//                 turns back). Only meaningful when message history is
	//                 already in use, hence being a third value of THIS same
	//                 setting rather than a separate on/off toggle next to
	//                 it -- there's no way to select "semantic" without
	//                 message history itself being on, by construction.
	useMessageHistory: "last-k",
	// Caps history to just the last N transcript entries (see llm/request.js,
	// Array.prototype.slice(-N)) -- used directly by "last-k" mode, and as
	// the recency half of "semantic" mode's own union (see
	// LLMSemanticHistory.selectRelevant) -- rather than resending the ENTIRE
	// conversation on every turn, which would otherwise grow (and cost)
	// without bound as a conversation gets longer.
	maxHistoryMessages: 20,
	// The OTHER half of "semantic" mode's union -- how many additional
	// transcript entries (beyond the last maxHistoryMessages) get pulled in
	// by embedding similarity to the current query. Ignored entirely in
	// "none"/"last-k" mode.
	maxSemanticHistoryMessages: 15,

	// Every key above that's actually tunable via ui/advanced.js and gets
	// persisted per-(provider,model) pair -- deliberately excludes
	// maxPageContextChars (not exposed as an Advanced setting at all right
	// now) so a stray future rename doesn't silently start persisting
	// something nobody can actually edit.
	_advancedSettingKeys: [
		"maxPDFContextChars", "chunkContextTopK",
		"maxSelectedFigures", "maxSelectedTables", "maxSelectedEquations",
		"useMessageHistory", "maxHistoryMessages", "maxSemanticHistoryMessages",
	],
	// Must stay in sync with the plain property defaults above -- these are
	// what applyAdvancedSettingsFor falls back to for a pair that's never
	// had any of its settings changed from default.
	_advancedSettingDefaults: {
		maxPDFContextChars: 60000,
		chunkContextTopK: 10,
		maxSelectedFigures: 10,
		maxSelectedTables: 10,
		maxSelectedEquations: 10,
		useMessageHistory: "last-k",
		maxHistoryMessages: 20,
		maxSemanticHistoryMessages: 20,
	},
	// { "provider:model" -> { ...overridden _advancedSettingKeys } }, only
	// ever containing keys a user has actually changed from default for that
	// pair (see saveAdvancedSetting) -- not a full snapshot of every
	// pair's settings, so a later change to _advancedSettingDefaults still
	// takes effect for anything nobody's touched yet.
	_advancedSettingsByPair: {},
	// Per-item one-shot marker set by ui/advanced.js when a user clears one
	// or more caches. llm/request.js consumes this on the next prompt for that
	// same PDF and emits a System message so recomputation is explicitly
	// visible as a consequence of the clear action.
	_pendingCacheRecomputeByItem: new Map(), // item.id -> string[] (cache labels)
	// Same persisted-JSON-blob-under-one-pref pattern as LLMInterfaces'
	// _serverSettingsPref (see its own comment) -- global: true required for
	// the same reason (this plugin's own prefs, not Zotero's).
	_advancedSettingsPref: "extensions.llm-chat-pane.advancedSettings",

	noteCacheCleared(item, labels = []) {
		if (!item?.id) return;
		let unique = [...new Set((labels || []).filter(l => typeof l === "string" && l.trim()))];
		this._pendingCacheRecomputeByItem.set(item.id, unique);
	},

	consumePendingCacheRecompute(item) {
		if (!item?.id) return null;
		let labels = this._pendingCacheRecomputeByItem.get(item.id) || null;
		this._pendingCacheRecomputeByItem.delete(item.id);
		return labels;
	},

	// Populates _advancedSettingsByPair from disk, then applies whatever's
	// saved for the CURRENTLY selected chat provider/model (LLMInterfaces'
	// own state, which loadSelection() must have already populated -- see
	// bootstrap.js's call ordering) onto this object's own properties above.
	// Called once at startup, same as LLMInterfaces.loadSelection()/
	// loadServerSettings() -- must run AFTER LLMInterfaces.loadSelection()
	// so the "currently selected pair" it applies is actually correct, and
	// BEFORE the Advanced panel first renders (ui/advanced.js's rows read
	// these properties directly via their own get() at row-creation time).
	loadAdvancedSettings() {
		try {
			let json = Zotero.Prefs.get(this._advancedSettingsPref, true);
			if (json) this._advancedSettingsByPair = JSON.parse(json);
		}
		catch (e) {
			this.log(`loadAdvancedSettings: failed to read pref: ${e.message}`);
		}
		this.applyAdvancedSettingsFor(LLMInterfaces._provider, LLMInterfaces._selectedModel[LLMInterfaces._provider]);
	},

	// Overwrites this object's own advanced-setting properties with
	// whichever value is saved for (provider, model), falling back to
	// _advancedSettingDefaults for any key that pair has never customized.
	// Called from loadAdvancedSettings above at startup, and again whenever
	// the CHAT provider/model selection changes (see ui/provider-model-select.js's
	// onChange, wired up in chat-pane.js's onRender) so switching models
	// mid-session immediately switches to that model's own tuned settings
	// rather than silently keeping whatever the PREVIOUS model had. The
	// actual read path (buildPromptWithActivePDFContext, selectFiguresWithLLM,
	// etc.) is untouched by any of this -- it keeps reading the plain
	// `this.maxPDFContextChars` etc. properties directly, unaware of which
	// pair is currently active.
	applyAdvancedSettingsFor(provider, model) {
		let saved = this._advancedSettingsByPair[`${provider}:${model}`] || {};
		for (let key of this._advancedSettingKeys) {
			this[key] = saved[key] !== undefined ? saved[key] : this._advancedSettingDefaults[key];
		}
		// Migrates a pre-existing persisted boolean (useMessageHistory was a
		// plain on/off toggle before it became this 3-way "none"/"last-k"/
		// "semantic" enum) -- without this, a pair whose pref blob still has
		// the old `true`/`false` would silently fail every string comparison
		// against it (llm/request.js's own mode checks), effectively landing in
		// neither "none" nor "semantic" and behaving unpredictably. Maps
		// true -> "last-k" (the old always-on behavior) and false -> "none".
		if (typeof this.useMessageHistory === "boolean") {
			this.useMessageHistory = this.useMessageHistory ? "last-k" : "none";
		}
	},

	// Persists ONE advanced setting under the CURRENTLY selected chat
	// provider/model pair, and updates this object's own live property so
	// the change takes effect immediately -- called from ui/advanced.js's
	// Context/Message history row `set` callbacks instead of a plain direct
	// assignment.
	saveAdvancedSetting(key, value) {
		this[key] = value;
		let pairKey = `${LLMInterfaces._provider}:${LLMInterfaces._selectedModel[LLMInterfaces._provider]}`;
		if (!this._advancedSettingsByPair[pairKey]) this._advancedSettingsByPair[pairKey] = {};
		this._advancedSettingsByPair[pairKey][key] = value;
		try {
			Zotero.Prefs.set(this._advancedSettingsPref, JSON.stringify(this._advancedSettingsByPair), true);
		}
		catch (e) {
			this.log(`saveAdvancedSetting: failed to persist ${key}: ${e.message}`);
		}
	},
	_systemPrompt: [
		"You are a helpful research assistant.",
		"You may use your conversation history to answer requests from the user. In particular, you may refer to your own last message to understand what the user wants when they reply to it -- especially when they are affirming or declining something you proposed, offered, or asked about, e.g. 'Yes, please do that.' or 'No, let's skip this for now.' Resolve what 'that'/'this'/'it' refers to from your own last message rather than treating such a reply as a new, standalone question with no context.",
		"This also applies when a reply combines a reference to your last message with an additional, separate request in the same message -- e.g. 'Please do that, and do X as well' means: do whatever you yourself proposed or offered last, AND also do X.",
		"Always express mathematical formulas and equations using LaTeX notation.",
		"Wrap every mathematical formula in latex notation as $<formula>$.",
		"For display math, you MUST wrap the formula in double dollar signs: $$<formula>$$. The opening $$ and closing $$ are mandatory.",
		"Format tables using standard Markdown table syntax: a header row, a separator row of dashes, and one or more data rows, each with columns separated by '|' -- e.g. '| Header 1 | Header 2 |' on one line, '| --- | --- |' on the next, then '| Cell 1 | Cell 2 |' for each row. Never use a LaTeX table environment (\\begin{array}, \\begin{tabular}) for a table -- those are for standalone formulas only, not tables.",
		"A formula INSIDE a table cell still uses inline math ($<formula>$) exactly as it would in regular text -- only the table's own row/column structure must be Markdown, not LaTeX.",
		"When you state facts or findings from the PDF, add a citation link immediately after the claim.",
		"Citation format: [CITE](<find:exact phrase>). Always use the literal token [CITE] — numbering is assigned automatically.",
		"The exact phrase is exactly ONE full sentence copied verbatim from the <PDF_CONTEXT> — no paraphrasing, no partial sentences, no ellipses or truncation. Pick the single sentence that most directly supports the claim.",
		"NEVER put more than one sentence inside a single [CITE](<find:...>) phrase, even when a claim would read more completely with two or three consecutive sentences (e.g. one sentence introducing something and the next contrasting it, or elaborating on it) -- pick ONLY the single sentence that most directly supports your specific claim and drop the rest. If you genuinely need to cite two different sentences for two different points, use TWO separate [CITE](<find:...>) tokens, each right after its own point -- never one citation spanning both sentences.",
		"The angle brackets around find: are mandatory.",
			"Example: 'This finding is well established [CITE](<find:Error-prone DNA polymerases have been shown to increase mutation rates under stress conditions.>).'",
			"Example of what NOT to do: do not write 'Zhao & Akoglu (2020) introduced PairNorm to prevent oversmoothing, while our approach instead targets training speed [CITE](<find:Zhao & Akoglu (2020) introduced PairNorm to prevent oversmoothing. Our approach instead targets training speed.>)' -- that packs two sentences into one citation. Instead write 'Zhao & Akoglu (2020) introduced PairNorm to prevent oversmoothing [CITE](<find:Zhao & Akoglu (2020) introduced PairNorm to prevent oversmoothing.>), while our approach instead targets training speed [CITE](<find:Our approach instead targets training speed.>)' -- two separate citations, one per sentence, each placed right after the point it supports.",
			"Whenever two citation or reference links (any combination of [CITE](<find:...>), [CITE](<find:PAPER_ID:...>), or the [Table N](<ref:table:N>)-style links below) end up immediately following one another -- e.g. two sentences cited back to back for the same claim -- separate them with a single whitespace character. Never place two link tokens directly adjacent with no space in between.",
			"Example: 'This has been shown independently in prior work [CITE](<find:PairNorm centers each node's representation by subtracting the row mean.>) [CITE](<find:It then rescales every row to a fixed total variance.>).' -- a space between the two ')' and '[' characters.",
			"Example of what NOT to do: do not write 'This has been shown independently in prior work [CITE](<find:PairNorm centers each node's representation by subtracting the row mean.>)[CITE](<find:It then rescales every row to a fixed total variance.>).' -- no space between the two citations.",
		"Whenever you mention a table (e.g. from <TABLE_CONTEXT>), a figure shown to you as an image, or a numbered equation the paper itself labels (e.g. from <EQUATION_CONTEXT>, or one you see numbered like '(3)' in the PDF text), wrap that mention in a link so the reader can jump to it.",
		"Format: [Table N](<ref:table:N>), [Figure N](<ref:figure:N>), or [Equation N](<ref:equation:N>), where N is the table/figure/equation number.",
		"For equations, N is the bare number the PDF prints next to the equation (e.g. for '(3)', use ref:equation:3), and only use this for equations the PDF itself numbers this way — never invent a number for an unlabeled formula.",
		"An equation shown to you in <EQUATION_CONTEXT> labeled 'Formula N' has no number in the original paper, so it uses a different link format: [Formula N](<ref:formula:N>), using the exact N shown to you in <EQUATION_CONTEXT> (do not confuse this with the ref:equation:N format above, which is only for equations the PDF itself numbers).",
		"Similarly, a table shown to you in <TABLE_CONTEXT> may carry a bracketed hint right after its label, like '[cite as ref:tableExtra:2]' -- this means it has no plain paper-printed number (e.g. its label is a letter-and-number like 'Table D.1', or a section name), so ref:table:N doesn't apply to it. If you see this hint, use its exact label as the visible text but link it with the exact ref:tableExtra:N given in the hint, copied verbatim -- never invent or count your own N for these.",
		"Every figure attached to you as an image is also listed, one line per figure, in a <FIGURE_CONTEXT> block as '<label>: cite as <ref>' -- always use the EXACT ref given there when you cite that figure, copied verbatim; never invent or count your own N. Most figures give you 'cite as ref:figure:N' (a real paper-printed number, e.g. Figure 3), but some instead give you 'cite as ref:figureExtra:N' -- that means the figure has no plain paper-printed number (e.g. an appendix-lettered caption like 'Figure D.1', or no caption at all), so ref:figure:N does not apply to it; use its exact label from <FIGURE_CONTEXT> as the visible link text either way.",
		"The visible label in brackets must be the exact label as given in its context (e.g. 'Table 1', 'Figure 2a', 'Equation 3', 'Formula 8') — do not renumber, reletter, or rephrase it.",
		"The angle brackets around ref: are mandatory, exactly like the citation format above.",
		"Example: 'As shown in [Table 1](<ref:table:1>), the reaction rate doubles.'",
		"Example: 'Substituting into [Equation 3](<ref:equation:3>) gives the closed-form solution.'",
		"Example: 'The training objective combines these into [Formula 8](<ref:formula:8>).'",
		"A <REFERENCE_CONTEXT> block, if present, lists the papers cited in this PDF's own bibliography, numbered exactly as in the original paper.",
		"You may cite one of these entries if it genuinely helps answer the question (e.g. it's the direct source of a claim, or clearly relevant further reading) — do not force one in otherwise, and do not list entries just because they exist.",
		"Format any such citation as [N](<ref:reference:N>), where N is the bibliography number, e.g. '[3]' — matching how the paper itself cites its own references.",
		"Example: 'This approach was first proposed by [12](<ref:reference:12>).'",
		"A <CROSS_LIBRARY_CONTEXT> block, if present, contains excerpts (paragraphs, table captions/content, figure captions, or equation context) retrieved from OTHER papers in the user's Zotero library -- not the current PDF, and not necessarily cited by it -- that may help answer the question. Each entry states its source paper's title, authors, and paper_id before its excerpt text.",
		"If you use information from a <CROSS_LIBRARY_CONTEXT> entry to answer the question, mention which paper it came from by wrapping its title in a link so the user can open that paper directly: [Title](<ref:library:paper_id>), using that entry's own exact title as the visible label and its paper_id as the link target -- so the user knows it did not come from the paper they're currently reading, and can jump straight to it.",
			"When you state a specific fact or finding sourced from a <CROSS_LIBRARY_CONTEXT> excerpt (not the current PDF), ground it the same way you ground a claim from the current PDF -- immediately after the claim, add a citation link, but include that entry's own paper_id: [CITE](<find:PAPER_ID:exact phrase>). The exact phrase is exactly ONE full sentence copied verbatim from THAT entry's own excerpt text -- same rules as the plain [CITE](<find:exact phrase>) format above (no paraphrasing, no partial sentences, no ellipses or truncation, and NEVER more than one sentence even for a comparative claim spanning two papers -- use two separate citations instead, exactly as described above), just with PAPER_ID and a colon prefixed before the phrase. Never omit the PAPER_ID prefix for a cross-library claim (that would ground it against the CURRENT PDF instead, where the sentence doesn't exist), and never add one for a claim actually from the current PDF.",
			"NEVER put more than one sentence inside a single [CITE](<find:PAPER_ID:...>) phrase either, including when a <CROSS_LIBRARY_CONTEXT> excerpt itself spans several consecutive sentences from that OTHER paper -- pick ONLY the one sentence that most directly supports your claim, same rule as the plain find: format. If a comparative claim needs one sentence from the current PDF AND one from a cross-library paper, use one plain [CITE](<find:...>) for the current-PDF sentence and one [CITE](<find:PAPER_ID:...>) for the cross-library sentence -- never merge the two into one citation of either format.",
			"Example of what NOT to do (cross-library): for a <CROSS_LIBRARY_CONTEXT> entry '\"PairNorm\" [paper_id: 29945]: PairNorm normalizes node representations to prevent oversmoothing. It requires no additional parameters and adds negligible computational cost.', do not write 'PairNorm prevents oversmoothing and is essentially free to compute [CITE](<find:29945:PairNorm normalizes node representations to prevent oversmoothing. It requires no additional parameters and adds negligible computational cost.>)' -- two sentences in one citation. Instead write 'PairNorm prevents oversmoothing [CITE](<find:29945:PairNorm normalizes node representations to prevent oversmoothing.>) and is essentially free to compute [CITE](<find:29945:It requires no additional parameters and adds negligible computational cost.>)' -- two separate citations, same paper_id, one sentence each.",
			"Example: for a <CROSS_LIBRARY_CONTEXT> entry '\"GraphNorm\" by Cai et al. [paper_id: 9012]: GraphNorm applies a learnable shift to preserve expressiveness on regular graphs.', write 'GraphNorm applies a learnable shift to preserve expressiveness on regular graphs [CITE](<find:9012:GraphNorm applies a learnable shift to preserve expressiveness on regular graphs.>).' -- 9012 (that entry's own paper_id) prefixed before the verbatim sentence, separated by a colon.",
		"Example: for an entry '\"Attention Is All You Need\" by Vaswani et al. [paper_id: 4821]: ...', write 'This is consistent with findings in [Attention Is All You Need](<ref:library:4821>).' -- the paper's own title is the label, 4821 (that entry's own paper_id) is the link target.",
			"A <CROSS_LIBRARY_CONTEXT> entry for a TABLE, FIGURE, or EQUATION carries its own bracketed hint right after its paper_id, like '[cite as ref:4821:table:3]', '[cite as ref:4821:figureExtra:2]', or '[cite as ref:4821:formula:5]' -- if you mention that specific table/figure/equation (not just the paper in general), wrap it in a link using that EXACT hint copied verbatim as the link target, with the visible label formatted as 'PAPER_ID <Kind> N' matching the hint's own kind word (Table/TableExtra/Figure/FigureExtra/Equation/Formula), e.g. [PAPER_ID Table N](<ref:PAPER_ID:table:N>) or [PAPER_ID Formula N](<ref:PAPER_ID:formula:N>) -- where PAPER_ID and N are exactly the paper_id and number shown in the hint -- never invent or count your own PAPER_ID or N for this format, and never use it for a paper's own tables/figures/equations (that's the plain ref:table:N/ref:figure:N/ref:equation:N/etc. format above, with no paper id). PAPER_ID in the visible label gets replaced with a real author/year citation automatically -- always include it exactly as given, never substitute your own author/year guess there. This is separate from -- and takes priority over, for a specific table/figure/equation -- the plain [Title](<ref:library:paper_id>) link above.",
			"Example: for an entry '\"GraphNorm\" by Cai et al. [paper_id: 9012] [cite as ref:9012:table:3]: ...', write 'As shown in [9012 Table 3](<ref:9012:table:3>) of GraphNorm, ...' -- 9012 (that entry's own paper_id, both in the label and the link target) and 3 (the hint's own N) copied verbatim.",
			"Example: for an entry '\"PairNorm\" by Zhao et al. [paper_id: 7734] [cite as ref:7734:formula:2]: ...', write 'PairNorm defines this via [7734 Formula 2](<ref:7734:formula:2>).' -- note the hint's own kind word (formula, not equation) is what determines the label/link format here.",
		"A <NOTE_CONTEXT> block, if present, contains one or more of the user's own annotations on this PDF -- each either a sticky note they wrote, or a passage they highlighted/underlined (quoted verbatim from the PDF) together with any comment they added on it. Any 'Note:' text in it is the user's own authoritative commentary, distinct from the paper's own claims -- don't confuse the two.",
		"Each entry in <NOTE_CONTEXT> starts with 'Note N (...) [key: XXXXXXXX]:' -- when you mention it, wrap it in a link so the reader can jump to it: [Note N](<ref:note:XXXXXXXX>). Use 'Note N' (that entry's display number) as the visible label, but the link target itself must be the exact key shown in brackets, not N -- copy the key exactly, character for character; never use N or invent a key.",
		"Example: for an entry 'Note 1 (Highlight, p. 4) [key: AB12CD34]: ...', write 'Your highlight on this point [Note 1](<ref:note:AB12CD34>) is directly relevant here.' -- 'Note 1' is the label, 'AB12CD34' (that note's own key) is the link target.",
		"An <INLINE_NOTE_CONTEXT> block appearing right after a paragraph inside <PDF_CONTEXT> means the user highlighted or underlined that passage (and may have added a comment on it) -- unlike <NOTE_CONTEXT> above, this is NOT something to cite or link; treat it purely as a signal that the preceding paragraph, and specifically the highlighted/underlined text quoted inside the block, is noteworthy to the user, and weigh it accordingly when answering.",
		"Inside <PDF_CONTEXT>, every section heading from the paper's own outline is always included, wrapped as <HEADING>Section Title</HEADING>, interleaved with the paragraph text in true document order -- this holds even when only a relevant SUBSET of paragraphs is shown (the full PDF was too large to include whole), so you always have a complete structural overview of the paper regardless of how much body text made it in. A <HEADING> is structural context only -- never cite or link it, and never invent your own headings. A bare '...' appearing between two consecutive <HEADING> blocks means no paragraph or preformatted text was included between them (either none was relevant to the question, or none exists there) -- it does NOT mean that section is empty in the actual paper, only that its body text isn't shown to you here.",
		"A <PREFORMATTED> block inside <PDF_CONTEXT> is whitespace-significant text from the paper that isn't ordinary prose -- typically source code, JSON/algorithm listings, or similar formatted content -- reproduced with its original line breaks and indentation intact rather than collapsed into a single line like a paragraph. Read its contents literally (spacing and structure are meaningful there, unlike in prose), and treat it as a normal part of the PDF's content when it's relevant to the question.",
		"Each <PREFORMATTED> block opens with its own header line of the form '<label>: cite as ref:preformatted:N' -- when you mention that block, wrap the mention in a link using its EXACT label as the visible text and its EXACT ref copied verbatim: [<label>](<ref:preformatted:N>). Most labels are the paper's own (e.g. 'Listing 6', 'Algorithm 2'), but a block the paper never labeled gets a synthetic 'Preformatted N' label instead -- cite it exactly the same way, using that label as given. Never invent, renumber, or count your own N here, and never cite a preformatted block by a number you inferred from its contents.",
		"Example: 'The registration payload is shown in [Listing 4](<ref:preformatted:6>).'",
		"If the paper labeled the block, its FULL caption (e.g. 'Listing 6. A2A Capability Verification Example') follows the header line, before the block's actual content -- that caption is real content describing what the listing does; the short label from the header is what goes inside the link.",
		"Whenever you mention a specific page of the PDF by number (e.g. 'on page 5', 'see page 12'), wrap the page number in a link so the reader can jump straight there: [page N](<ref:page:N>), where N is the page number -- this works for any page, not just ones with a table/figure/equation/note on them, and is separate from those ref: formats above.",
		"Example: 'The methodology is described in more detail on [page 7](<ref:page:7>).'",
		"NEVER put any of the link formats above -- [CITE](<find:...>), [CITE](<find:PAPER_ID:...>), [Table N](<ref:table:N>), [<label>](<ref:tableExtra:N>), [Figure N](<ref:figure:N>), [<label>](<ref:figureExtra:N>), [Equation N](<ref:equation:N>), [Formula N](<ref:formula:N>), [<label>](<ref:preformatted:N>), [N](<ref:reference:N>), [Note N](<ref:note:...>), [page N](<ref:page:N>), [Title](<ref:library:paper_id>), or a cross-library [PAPER_ID Table N](<ref:PAPER_ID:table:N>)/[PAPER_ID Figure N](<ref:PAPER_ID:figure:N>)/[PAPER_ID Formula N](<ref:PAPER_ID:formula:N>)-style link -- inside a math environment ($<formula>$ or $$<formula>$$). Links only work in plain text; a $...$/$$...$$ formula must contain ONLY the formula itself, never a link. This does not apply to Markdown table cells (which are plain text, not math) -- links work normally there.",
		"If a $...$/$$...$$ formula needs to reference a table/figure/equation/note, write its plain label as ordinary text immediately next to the formula instead, not inside it -- e.g. 'the result in Equation 1: $x = \\phi_s(s)$' with the link on 'Equation 1', not inside the $...$.",
	].join(" "),

	log(msg) {
		Zotero.debug("LLM Chat Pane [Prompt]: " + msg);
	},

	// Only relevant in "semantic" useMessageHistory mode -- "last-k"/"none"
	// send either a plain contiguous recent window or nothing at all, so
	// there's no structure to explain. "semantic" mode's messages array is a
	// UNION (see LLMSemanticHistory.selectRelevant) that can have real gaps:
	// an older turn gets included because it's topically relevant to the
	// CURRENT question, while turns between it and the recent window are
	// simply missing, not summarized or referenced in any way. selectRelevant
	// itself re-sorts the union back into true chronological order before
	// returning it (see its own comment), so the LAST message the model sees
	// is always genuinely the most recent turn -- this note is only about the
	// possibility of gaps EARLIER in the list, not about ordering being
	// wrong. Read live (this.useMessageHistory) each call from
	// buildPromptWithActivePDFContext below, same as every other advanced
	// setting here, so it always reflects whichever mode is actually active
	// for this request.
	_historyStructureNote() {
		if (this.useMessageHistory !== "semantic") return "";
		return "The conversation history you are given may not be a contiguous window of the whole conversation -- alongside your most recent exchanges, it can also include older messages that were pulled in because they are semantically related to the user's current question, with unrelated messages in between them left out. Every message you do see is in its true original chronological order (oldest first), but there can be gaps between them -- do not assume two consecutive messages you see were adjacent in the live conversation, and do not assume nothing relevant happened in a gap you don't see.";
	},

	// Shared by every selectXWithLLM below: surfaces what page the user is
	// currently looking at, any text they have selected there, and any
	// annotation they have actively selected/highlighted in the reader
	// (clicked on the page or in the sidebar, no distinction --
	// LLMChatPane.getSelectedAnnotation(), pre-formatted via
	// LLMNotes.formatAnnotation()). Without pageNum, a page-scoped question
	// like "what figures are on this page?" has nothing to match against,
	// since the query itself carries no page number. selectedAnnotationNote
	// is the strongest possible signal for a query like "explain this" -- the
	// user is looking right at it.
	_buildReaderContextLines({ pageNum, selectedText, selectedAnnotationNote } = {}) {
		let lines = [];
		if (pageNum) lines.push(`The user is currently viewing page ${pageNum} of the PDF.`);
		if (selectedText) {
			lines.push(`The user currently has this text selected on that page: "${selectedText.slice(0, 300)}${selectedText.length > 300 ? "…" : ""}"`);
		}
		if (selectedAnnotationNote) {
			lines.push(`The user currently has this annotation selected/highlighted in the reader: ${selectedAnnotationNote.title}: ${selectedAnnotationNote.text}`);
		}
		return lines;
	},

	// Formats a plain { role, text } transcript slice (chat.exportTranscript()'s
	// own shape, same as priorTranscript in llm/request.js) as "User"/
	// "Assistant" lines for a one-off classification prompt -- see
	// shouldIncludeCrossLibraryWithLLM's own comment on why a call like that
	// needs this at all. Each entry is truncated the same way selectedText
	// is in _buildReaderContextLines above (a full prior reply can be long,
	// and only enough of it to resolve what a short reply refers to is
	// actually needed here).
	_formatRecentHistory(recentHistory) {
		return recentHistory.map(({ role, text }) => {
			let label = role === "You" ? "User" : "Assistant";
			let truncated = text.length > 500 ? `${text.slice(0, 500)}…` : text;
			return `${label}: ${truncated}`;
		}).join("\n");
	},

	// Same purpose as _buildReaderContextLines above, for recent
	// conversation history -- shared by every selectXWithLLM/
	// shouldIncludeXWithLLM selection prompt below so a short reply like
	// "yes please" or "show me that" can be resolved against whatever the
	// model itself just proposed/offered, the same problem
	// shouldIncludeCrossLibraryWithLLM's own recentHistory param exists to
	// fix (see its comment) -- extended here to every OTHER selection
	// call, since a short affirming reply after the model offers to show a
	// specific table/figure/equation/note, or a follow-up naming something
	// only mentioned in a PRIOR turn ("show me the one about X" where X was
	// named earlier, not in this message), has exactly the same blind-spot
	// otherwise. (shouldIncludeCrossLibraryWithLLM predates this helper and
	// keeps its own inline wording, tuned for a yes/no prompt with a worked
	// example, rather than switching to this shared, more generic phrasing.)
	_historyContextLines(recentHistory) {
		if (!recentHistory.length) return [];
		return [
			"Recent conversation history (oldest first) -- use this to resolve what the user's question refers to if it's a short reply like 'yes please' or 'show me that' to something you yourself proposed, offered, or mentioned:",
			this._formatRecentHistory(recentHistory),
		];
	},

	// Builds the actual text embedded for cross-library retrieval (see
	// LLMCitation.getCrossLibraryChunks) -- deliberately not just the bare
	// current prompt. shouldIncludeCrossLibraryWithLLM's own recentHistory-
	// aware check (see its own comment) can decide cross-library search is
	// warranted from a short reply like "please do that" -- but that same
	// bare reply, embedded on its own, carries no topical content to match
	// against (no mention of whatever paper/topic was actually being
	// discussed), so retrieval would come back empty even once the gating
	// decision itself is right. Prefixing the same recent-history text used
	// for that gating decision biases the embedding toward whatever was
	// actually offered/discussed (e.g. a specific paper the model itself
	// just named), rather than searching on words the short reply happens
	// to contain.
	_buildCrossLibraryQuery(prompt, recentHistory) {
		if (!recentHistory.length) return prompt;
		return `${this._formatRecentHistory(recentHistory)}\n${prompt}`;
	},

	// Asks the LLM itself to pick which figures (if any) help answer a user's
	// question, given the list of figure captions. Tried embedding-based
	// retrieval first (both plain image-embedding similarity and text/image
	// score fusion via raw max, z-score max, and Reciprocal Rank Fusion at
	// various k) — all of them conflated a merely topically-adjacent caption
	// with genuine relevance on queries like "is there a figure describing
	// model performance", consistently picking a data-prep figure that shares
	// vocabulary ("model", "evaluate", "test") over the actual
	// performance-metrics figure. An LLM reading the captions can reason
	// about what they mean rather than just measuring vector distance, and
	// got this and three other test queries right where every embedding
	// fusion approach failed at least one.
	//
	// Multi-select (up to maxSelectedFigures) in a single round-trip, same
	// rationale as selectNotesWithLLM below: a query can genuinely have
	// several relevant figures, and reading the whole caption list once and
	// returning every relevant number is one call regardless of how many
	// match, vs. O(N) calls for a one-call-per-candidate approach.
	//
	// Matched against figure_id -- a plain sequential integer assigned to
	// EVERY figure regardless of whether it has a real printed number (see
	// scripts/extract-figures-sdt.js) -- same reasoning as
	// selectTablesWithLLM's own use of table_id: a figure's own `label`
	// isn't always a short, comma-free number (an appendix-lettered caption
	// like "Figure D.1", or a synthetic heading-derived label for an
	// uncaptioned figure, CAN contain a comma itself), and figure_num is
	// null for exactly those cases, so matching on it directly (the old
	// caption-anchored PyMuPDF pipeline's approach, back when every figure
	// it could find at all necessarily had a real number) would silently
	// drop them from the selection round-trip entirely.
	async selectFiguresWithLLM(figureIndex, query, recentHistory = [], readerContext = {}) {
		let figures = figureIndex?.figures;
		if (!figures?.length) return [];

		// Page number included alongside the reader-context lines above
		// (the user's OWN current page) so the model can correlate a
		// page-scoped question ("the figure on this page") against each
		// candidate's actual location, not just its caption text.
		let captionList = figures.map(f => `[${f.figure_id}] (p.${f.page_num}) ${f.label}: ${f.caption}`).join("\n");
		let selectionPrompt = [
			"You are choosing which figures (if any) from a scientific paper help answer a user's question. There may be zero, one, or several relevant figures -- include all of them, not just the single best one.",
			...this._historyContextLines(recentHistory),
			...this._buildReaderContextLines(readerContext),
			"Here are the figures in this paper, each preceded by its id and page number:",
			captionList,
			"",
			`User's question: "${query}"`,
			"",
			'Respond with ONLY a comma-separated list of the ids of every relevant figure (e.g. "2, 5"), or "none" if no figure is relevant. Do not include any other text.',
		].join("\n");

		let result = await LLMInterfaces.streamModel(selectionPrompt, () => {}, {});
		let text = (result.text || "").trim();
		if (!text || /none/i.test(text)) return [];

		let seen = new Set();
		let selected = [];
		for (let match of text.matchAll(/\d+/g)) {
			let id = parseInt(match[0], 10);
			if (seen.has(id)) continue;
			let figure = figures.find(f => f.figure_id === id);
			if (!figure) continue;
			seen.add(id);
			selected.push(figure);
			if (selected.length >= this.maxSelectedFigures) break;
		}
		return selected;
	},

	// One line per figure attached as image context (see llm/request.js's
	// _buildImageContext), telling the model exactly which ref: token to
	// cite it with -- a numbered figure's own printed caption is visible
	// right there in the attached crop, so the model could in principle
	// derive ref:figure:N on its own, but an unnumbered one (figure_num
	// === null -- an appendix-lettered caption, or a synthetic
	// heading-derived label for an uncaptioned figure, see
	// scripts/extract-figures-sdt.js) has NO such visible number to read at
	// all, so this is the only way it ever learns the right
	// ref:figureExtra:N to use. Included for every attached figure
	// uniformly (not just unnumbered ones) so the format is one predictable
	// line per figure rather than two different shapes depending on
	// numbering.
	_formatFigureCitationHint(f) {
		let ref = f.figure_num !== null ? `ref:figure:${f.figure_num}` : `ref:figureExtra:${f.figure_extra_num}`;
		return `${f.label}: cite as ${ref}`;
	},

	_formatTableMarkdown(t) {
		let [header, ...rows] = t.data;
		let sep = header ? "| " + header.map(() => "---").join(" | ") + " |" : "";
		let mdHeader = header ? "| " + header.join(" | ") + " |" : "";
		let mdRows = rows.map(r => "| " + r.join(" | ") + " |").join("\n");
		// Tables with no plain paper-printed number (table_num === null --
		// see the experimental SDT-only detection in document/tables.js/
		// scripts/extract-tables-sdt.js) get an explicit ref:tableExtra:N
		// hint here, the same way "Formula N" already bakes its own number
		// directly into its label -- gives the model a reliable, directly-
		// visible number to copy for the ref:tableExtra:N link format (see
		// _systemPrompt), rather than needing it to count/infer one itself.
		let refHint = t.table_extra_num != null ? ` [cite as ref:tableExtra:${t.table_extra_num}]` : "";
		return `**[p.${t.page_num}] ${t.label}${refHint}:** ${t.caption}\n${mdHeader}\n${sep}\n${mdRows}`;
	},

	// Numbered via LLMReferences.displayNumber, not `r.index` directly -- a
	// paper whose bibliography has no printed numbers at all (author-year/
	// alphabetical style, e.g. natbib -- `index` null for every entry, see
	// that function's own comment) would otherwise show every single entry
	// as literally "[null]" here, indistinguishable from one another.
	_formatReferenceContext(references) {
		return references.map(r => `[${LLMReferences.displayNumber(r)}] ${r.text}`).join("\n");
	},

	// Asks the LLM whether the paper's bibliography, as a whole, would help
	// answer a user's question -- unlike selectTablesWithLLM/
	// selectFiguresWithLLM/etc. (multi-select from many standalone
	// candidates, each potentially large), this is a single yes/no call:
	// reference entries are individually just short citation-length text, so
	// there's no real cost to including the whole list versus filtering it
	// entry-by-entry -- the only question worth asking the model is whether
	// the bibliography is relevant to this question AT ALL (e.g. "what prior
	// work does this build on", "who else has studied this") versus clearly
	// not (e.g. "what does figure 2 show").
	async shouldIncludeReferencesWithLLM(referenceIndex, query, recentHistory = [], readerContext = {}) {
		let references = referenceIndex?.references;
		if (!references?.length) return false;

		let selectionPrompt = [
			"You are deciding whether a scientific paper's full bibliography/reference list would help answer a user's question.",
			...this._historyContextLines(recentHistory),
			...this._buildReaderContextLines(readerContext),
			"Here are the entries in this paper's bibliography, each preceded by its number:",
			"",
			this._formatReferenceContext(references),
			"",
			`User's question: "${query}"`,
			"",
			'Respond with ONLY "yes" if the bibliography would genuinely help answer the question (e.g. the user is asking about related/prior work, sources, or a specific citation), or "no" otherwise. Do not include any other text.',
		].join("\n");

		let result = await LLMInterfaces.streamModel(selectionPrompt, () => {}, {});
		let text = (result.text || "").trim();
		return /^yes/i.test(text);
	},

	// Asks the LLM whether answering the user's question would benefit from
	// searching OTHER papers in the user's Zotero library -- related work,
	// alternative methods, background the current paper doesn't cover,
	// comparisons, replication of a result -- rather than the current paper
	// alone. Same single yes/no shape as shouldIncludeReferencesWithLLM
	// above, and for the same reason: there's nothing to enumerate and
	// choose among here (unlike the multi-select selectXWithLLM helpers
	// picking among candidates already extracted from THIS paper) -- the
	// only question worth asking is whether it's worth searching the rest
	// of the library AT ALL for this particular question. Deliberately
	// asked BEFORE running any retrieval (LLMCitation.getCrossLibraryChunks
	// is comparatively cheap -- one embedding call plus a sqlite-vec MATCH
	// query -- but every OTHER paper's paragraphs are, by definition, not
	// about the paper actually open right now, so pulling them in
	// unconditionally would just as often inject noise as help).
	//
	// `title` (the CURRENT paper's own title, may be null) is given so the
	// model can tell "the user named a DIFFERENT paper" (needs cross-library
	// search) apart from "the user named THIS paper" (doesn't) -- without it,
	// a question like "explain the approach for over 1000 layers in He et
	// al. (2016)" has no way to be checked against what's actually open:
	// confirmed concretely that a bare yes/no prompt with no worked example
	// and no title to compare against judged this exact question "no" even
	// though He et al. 2016 is almost never the paper someone has open while
	// asking about it by name -- it's a citation INSIDE whatever paper IS
	// open. The explicit named-citation rule and worked example below exist
	// because of that failure, not as a hypothetical.
	//
	// `recentHistory` -- a short slice of the conversation's own recent turns
	// (see llm/request.js's own priorTranscript, passed in independently of
	// LLMPrompt.useMessageHistory's own mode -- this classification call is
	// cheap and one-off, not the main request's own context budget), given so
	// a bare affirmation/rejection ("yes please", "sure", "no thanks") can be
	// resolved against whatever the model itself just proposed. Without it, a
	// reply like "yes please" to the model's own earlier "want me to pull in
	// related work on X?" carries no signal on its own -- the word "yes"
	// names no paper, author, or method, so neither yes-condition below would
	// ever fire for it even though the CURRENT question, in context, is
	// exactly a cross-library request.
	async shouldIncludeCrossLibraryWithLLM(query, title, recentHistory = [], readerContext = {}) {
		let selectionPrompt = [
			"You are deciding whether answering a user's question would benefit from ALSO searching the OTHER papers in the user's Zotero library, not just the paper they currently have open.",
			title ? `The paper currently open is titled: "${title}".` : "",
			'Answer "yes" if ANY of these applies:',
			"- The question names a SPECIFIC paper, author, or citation (e.g. \"in He et al. 2016\", \"the ResNet paper\", \"reference 12\", \"as Smith et al. showed\") that is a DIFFERENT paper from the one currently open (compare the named paper against the title above -- if they don't clearly match, treat it as different). The answer to a question phrased this way almost always needs that OTHER paper's own text, not just however it's cited in passing in the current one.",
			"- The question asks for related work, alternative methods, background the current paper likely doesn't cover, comparisons across papers, or replication of a result.",
			"- The question is a short reply (e.g. \"yes\", \"yes please\", \"sure\", \"go ahead\") affirming something YOU proposed, offered, or asked about in the recent history below that itself involved another paper or the library's other papers (e.g. you asked \"want me to explain paper X?\" or \"should I look at related work?\") or \"I can give you a side-by-side comparison of paper X and paper Y.\") -- treat that as confirming the cross-library search, using the recent history to see what's being affirmed.",
			"Answer \"no\" only if the current paper alone is clearly sufficient -- e.g. the question is about the currently open paper's own content, figures, methodology, or results, or explicitly names the CURRENT paper itself (matching the title above) as the source.",
			'Example: current paper titled "Attention Is All You Need", question "explain the approach for over 1000 layers in He et al. (2016)" -> "yes" (He et al. 2016 is a different, named paper, not this one).',
			'Example: recent history ends with you asking "Want me to pull in the PairNorm paper for comparison?", question "yes please" -> "yes" (affirming your own cross-library offer).',
			recentHistory.length ? "Recent conversation history (oldest first):" : "",
			recentHistory.length ? this._formatRecentHistory(recentHistory) : "",
			...this._buildReaderContextLines(readerContext),
			`User's question: "${query}"`,
			"",
			'Respond with ONLY "yes" or "no". Do not include any other text.',
		].filter(Boolean).join("\n");

		let result = await LLMInterfaces.streamModel(selectionPrompt, () => {}, {});
		let text = (result.text || "").trim();
		return /^yes/i.test(text);
	},

	// One entry per retrieved cross-library excerpt -- title/authors/
	// paper_id first (see LLMCitation.getCrossLibraryChunks), so the model
	// can both judge which paper each excerpt is from and copy the exact
	// title into its answer (see _systemPrompt's own <CROSS_LIBRARY_CONTEXT>
	// instructions -- paper_id is included for traceability only, the model
	// is told NOT to cite it in place of the title). A table/figure/
	// equation entry (see LLMCitation._elementCrossLibraryMeta) additionally
	// gets a bracketed citation hint, same convention as
	// _formatTableMarkdown's own SAME-paper [cite as ref:tableExtra:N]
	// hint -- meta.num (a real paper-printed number) if the element has
	// one, else meta.extraNum (an SDT-only-detected/unlabeled element).
	// Equation's "extra" series is cited as ref:PAPER_ID:formula:N, not
	// ref:PAPER_ID:equationExtra:N -- see _crossLibraryElementKinds' own
	// comment for why.
	_formatCrossLibraryContext(chunks) {
		return chunks.map((c) => {
			let byline = c.authors ? ` by ${c.authors}` : "";
			let citeHint = "";
			if (c.meta) {
				let { kind, num, extraNum } = c.meta;
				let extraRefType = kind === "equation" ? "formula" : `${kind}Extra`;
				if (num != null) citeHint = ` [cite as ref:${c.paperId}:${kind}:${num}]`;
				else if (extraNum != null) citeHint = ` [cite as ref:${c.paperId}:${extraRefType}:${extraNum}]`;
			}
			return `**"${c.title}"${byline} [paper_id: ${c.paperId}]${citeHint}:**\n${c.text}`;
		}).join("\n\n");
	},

	_formatEquationText(eq) {
		return `**${eq.label}:** ${eq.text}`;
	},

	// Asks the LLM which equations (if any) help answer a user's question,
	// given each equation's full extracted text (equations are text-native
	// and short, like tables' contentText, so showing all of them in full is
	// cheap) — same approach and rationale as selectTablesWithLLM below.
	// Equations come in two label series -- "Equation N" (the paper's own
	// number) and "Formula N" (document-order among unlabeled ones) -- which
	// share the same numeric range and would collide under a bare-number
	// response (e.g. "3" could mean either), so selection is matched against
	// exact label text instead, unlike the numeric matching
	// selectTablesWithLLM/selectFiguresWithLLM use. Multi-select (up to
	// maxSelectedEquations) in a single round-trip, same rationale as
	// selectNotesWithLLM below.
	async selectEquationsWithLLM(equationIndex, query, recentHistory = [], readerContext = {}) {
		let equations = equationIndex?.equations;
		if (!equations?.length) return [];

		// Page number included alongside the reader-context lines above
		// (the user's OWN current page) so the model can correlate a
		// page-scoped question against each candidate's actual location.
		let equationContext = equations.map(eq => `(p.${eq.page_num}) ${eq.label}: ${eq.text}`).join("\n");
		let selectionPrompt = [
			"You are choosing which equations (if any) from a scientific paper help answer a user's question. There may be zero, one, or several relevant equations -- include all of them, not just the single best one.",
			...this._historyContextLines(recentHistory),
			...this._buildReaderContextLines(readerContext),
			"Here are the equations in this paper, each preceded by its page number and exact label:",
			"",
			equationContext,
			"",
			`User's question: "${query}"`,
			"",
			'Respond with ONLY a comma-separated list of the exact labels of every relevant equation (e.g. "Equation 3, Formula 2"), or "none" if no equation is relevant. Do not include any other text.',
		].join("\n");

		let result = await LLMInterfaces.streamModel(selectionPrompt, () => {}, {});
		let text = (result.text || "").trim();
		if (!text || /^none$/i.test(text)) return [];

		let seen = new Set();
		let selected = [];
		for (let rawLabel of text.split(",")) {
			let label = rawLabel.trim().replace(/^["'.]+|["'.]+$/g, "").toLowerCase();
			if (!label || seen.has(label)) continue;
			let equation = equations.find(eq => eq.label.toLowerCase() === label);
			if (!equation) continue;
			seen.add(label);
			selected.push(equation);
			if (selected.length >= this.maxSelectedEquations) break;
		}
		return selected;
	},

	// Asks the LLM which tables (if any) help answer a user's question,
	// given each table's full content (not just captions — unlike figures,
	// table content is text-native and cheap to show in full). Validated
	// against image embedding and text-embedding max(caption, content) on 5
	// content-specific queries: image embedding scored 1/5 (table images are
	// visually near-identical grids, giving it little to work with — worse
	// than for figures, which are visually distinctive), text-max scored 3/5
	// (failed when one table merely mentioned the query's keywords more often
	// than the table that actually answered it), LLM selection scored 5/5.
	// Multi-select (up to maxSelectedTables) in a single round-trip, same
	// rationale as selectNotesWithLLM below.
	//
	// Matched against table_id -- a plain sequential integer assigned to
	// EVERY table regardless of whether it has a real printed number (see
	// scripts/extract-tables-sdt.js) -- same approach
	// tools/table-export.js's resolveTableSelection uses and for the same
	// reason: a table's own `label` isn't always a short, comma-free
	// number (an appendix-lettered caption like "Table D.1", or worse, a
	// synthetic heading-derived label for an uncaptioned table, e.g.
	// "Appendix B. FSQ codebook, Unlabelled Table 1", CAN contain a comma
	// itself), which used to require parsing the model's response one
	// label per line instead of the simpler comma-separated format every
	// other selectXWithLLM here uses. Asking for table_id sidesteps that
	// entirely -- it's always a small integer, so a plain comma-separated
	// response is safe again, same as selectFiguresWithLLM/
	// selectNotesWithLLM already do.
	async selectTablesWithLLM(tableIndex, query, recentHistory = [], readerContext = {}) {
		let tables = tableIndex?.tables;
		if (!tables?.length) return [];

		// Page number included alongside the reader-context lines above
		// (the user's OWN current page) so the model can correlate a
		// page-scoped question against each candidate's actual location.
		let tableContext = tables.map(t => `[${t.table_id}] (p.${t.page_num}) ${t.label}: ${t.caption}\n${LLMTables._flattenTableData(t.data)}`).join("\n\n");
		let selectionPrompt = [
			"You are choosing which tables (if any) from a scientific paper help answer a user's question. There may be zero, one, or several relevant tables -- include all of them, not just the single best one.",
			...this._historyContextLines(recentHistory),
			...this._buildReaderContextLines(readerContext),
			"Here are the tables in this paper, each preceded by its id, page number, and label:",
			"",
			tableContext,
			"",
			`User's question: "${query}"`,
			"",
			'Respond with ONLY a comma-separated list of the ids of every relevant table (e.g. "2, 5"), or "none" if no table is relevant. Do not include any other text.',
		].join("\n");

		let result = await LLMInterfaces.streamModel(selectionPrompt, () => {}, {});
		let text = (result.text || "").trim();
		if (!text || /^none$/i.test(text)) return [];

		let seen = new Set();
		let selected = [];
		for (let match of text.matchAll(/\d+/g)) {
			let id = parseInt(match[0], 10);
			if (seen.has(id)) continue;
			let table = tables.find(t => t.table_id === id);
			if (!table) continue;
			seen.add(id);
			selected.push(table);
			if (selected.length >= this.maxSelectedTables) break;
		}
		return selected;
	},

	// `refNum` is a per-request index (1..K over just the notes actually
	// selected for THIS message, not a stable paper-wide number like
	// table/figure/equation numbers) -- notes have no natural number of
	// their own, so this is purely a DISPLAY label ("Note N"), shown to the
	// model for readability and echoed back as the model's visible link
	// text. The actual link TARGET the model is instructed to use is
	// note.annotationKey (embedded here as "[key: ...]"), a real, stable
	// Zotero item key -- unlike refNum, that one IS still meaningful after
	// this message: it resolves correctly via buildLinkIndex's `note` map
	// (keyed by annotationKey) even for a re-rendered historical/imported
	// message, since the same annotation always has the same key.
	_formatNoteContext(note, refNum) {
		return `**Note ${refNum} (${note.title}) [key: ${note.annotationKey}]:** ${note.text}`;
	},

	// Asks the LLM which of the user's own notes on this paper are relevant,
	// given each note's full text -- same "let the LLM read the full, short
	// content and pick" approach as selectTablesWithLLM. Multi-select (up to
	// MAX_SELECTED_NOTES) in a single round-trip, same rationale as the other
	// selectXWithLLM helpers above. Notes have no paper-native number to key
	// off of (unlike tables/figures/equations), so this numbers them 1..N
	// purely for this one selection round-trip -- that index has no meaning
	// outside this call and isn't persisted.
	//
	// See _buildReaderContextLines for readerContext -- worth noting here
	// specifically: each note's own title states ITS OWN page (e.g.
	// "Highlight (p. 4)"), which is what lets a page-scoped question like
	// "what notes do I have on this page?" be matched against pageNum below.
	async selectNotesWithLLM(notes, query, recentHistory = [], readerContext = {}) {
		if (!notes?.length) return [];

		const MAX_SELECTED_NOTES = 10;
		let noteContext = notes.map((n, i) => `Note ${i + 1} (${n.title}): ${n.text}`).join("\n\n");

		let selectionPrompt = [
			"You are choosing which of the user's own notes/highlights/underlines on this paper (if any) are relevant to a user's question. There may be zero, one, or several relevant notes -- include all of them, not just the single best one.",
			...this._historyContextLines(recentHistory),
			...this._buildReaderContextLines(readerContext),
			"Each note's title states the page it's on, e.g. \"Highlight (p. 4)\" -- use that to match page-scoped questions like \"what notes do I have on this page?\" against the user's current page above.",
			"Here are the notes:",
			"",
			noteContext,
			"",
			`User's question: "${query}"`,
			"",
			'Respond with ONLY a comma-separated list of every relevant note number (e.g. "2, 5, 7"), or "none" if no note is relevant. Do not include any other text.',
		].join("\n");

		let result = await LLMInterfaces.streamModel(selectionPrompt, () => {}, {});
		let text = (result.text || "").trim();
		if (!text || /none/i.test(text)) return [];

		let seen = new Set();
		let selected = [];
		for (let match of text.matchAll(/\d+/g)) {
			let index = parseInt(match[0], 10) - 1;
			if (seen.has(index) || !notes[index]) continue;
			seen.add(index);
			selected.push(notes[index]);
			if (selected.length >= MAX_SELECTED_NOTES) break;
		}
		return selected;
	},

	// Builds the lookup _renderMarkdown uses to resolve `ref:table:N` /
	// `ref:figure:N` / `ref:reference:N` / `ref:equation:N` / `ref:formula:N`
	// / `ref:note:KEY` links -- shared by llm/request.js (a live request, with
	// `selectedNotes`, this message's own LLM-picked subset) and
	// chat-pane.js's onImport (a historical message, which instead
	// passes EVERY current annotation on the PDF via LLMNotes.getNotes(),
	// since there's no way to know which ones were actually shown to the
	// model that produced the original text). Both work because notes are
	// keyed by annotationKey below -- a real, stable Zotero item key the
	// model is instructed to copy verbatim into the ref:note: token (see
	// _formatNoteContext/the system prompt), not a per-message ordinal --
	// so a note link resolves as long as that annotation still exists on
	// the PDF, regardless of whether `notes` here happens to be "just what
	// was selected for this message" or "everything on the PDF right now".
	// table/figure/reference/equation links key off each item's own stable
	// paper-native number instead, for the same reason: they resolve
	// identically whether the message is live or imported, as long as the
	// same PDF's cached extraction indexes are passed in.
	buildLinkIndex({ tableIndex, figureIndex, referenceIndex, equationIndex, preformattedIndex, notes = [] }) {
		return {
			// Real numbered tables ("Table 3:") key on table_num (the paper's
			// own printed number, cited via ref:table:N); tables with no real
			// number at all -- an appendix-lettered caption like "Table D.1",
			// or a synthetic heading-derived label for an uncaptioned one
			// (see the experimental SDT-only detection in document/tables.js/
			// scripts/extract-tables-sdt.js) -- key on table_extra_num under
			// a separate map instead (cited via ref:tableExtra:N), mirroring
			// equation/formula below: merging them into one map would let
			// every table_num===null entry collide on the same `null` key.
			table: new Map((tableIndex?.tables || [])
				.filter(t => t.table_num !== null)
				.map(t => [t.table_num, { position: t.position, caption: t.caption }])),
			tableExtra: new Map((tableIndex?.tables || [])
				.filter(t => t.table_num === null && t.table_extra_num != null)
				.map(t => [t.table_extra_num, { position: t.position, caption: t.caption }])),
			// Same table_num/table_extra_num split as tables above, now that
			// SDT-only detection (scripts/extract-figures-sdt.js) can find a
			// figure with no real printed number too (an appendix-lettered
			// caption like "Figure D.1", or a synthetic heading-derived
			// label for an uncaptioned one) -- the old caption-anchored
			// PyMuPDF pipeline this replaced could only ever find NUMBERED
			// figures in the first place, so this split didn't used to be
			// needed here.
			figure: new Map((figureIndex?.figures || [])
				.filter(f => f.figure_num !== null)
				.map(f => [f.figure_num, { position: f.position, caption: f.caption }])),
			figureExtra: new Map((figureIndex?.figures || [])
				.filter(f => f.figure_num === null && f.figure_extra_num != null)
				.map(f => [f.figure_extra_num, { position: f.position, caption: f.caption }])),
			// Keyed by LLMReferences.displayNumber (not raw r.index), matching
			// _formatReferenceContext's own numbering -- the model cites
			// whatever number THAT block showed it, so this lookup has to key
			// on the same number or every ref:reference:N link would resolve
			// to nothing for a paper with no printed bibliography numbers
			// (see displayNumber's own comment). `position` (see
			// extract-references.js's own buildPosition) routes a click
			// through _renderMarkdown's entry.position branch straight to
			// navigateToPosition, the same precise rects-based highlight
			// table/figure/equation/note links already get, instead of
			// falling through to the caption-text-search fallback
			// (navigateToText) below -- null for an entry whose extraction
			// had no anchor at all, which still falls through to that same
			// fallback exactly as before.
			reference: new Map((referenceIndex?.references || []).map(r => [LLMReferences.displayNumber(r), {
				label: `[${LLMReferences.displayNumber(r)}] ${r.text}`,
				caption: r.text.split(/\s+/).slice(0, 8).join(" "),
				position: r.position,
			}])),
			// Real numbered equations key on equation_num (matching the
			// paper's own printed number, cited via ref:equation:N); Formulas
			// key on formula_num under a separate map instead (cited via
			// ref:formula:N) -- they share the same numeric range, so merging
			// them into one map would let a formula_num collide with an
			// unrelated equation_num.
			equation: new Map((equationIndex?.equations || [])
				.filter(eq => eq.equation_num !== null)
				.map(eq => [eq.equation_num, {
					position: eq.position,
					caption: eq.text.split(/\s+/).slice(0, 8).join(" "),
				}])),
			formula: new Map((equationIndex?.equations || [])
				.filter(eq => eq.formula_num !== null)
				.map(eq => [eq.formula_num, {
					position: eq.position,
					caption: eq.text.split(/\s+/).slice(0, 8).join(" "),
				}])),
			// preformatted_id is this plugin's own always-present, collision-free id, 
			// so it keys every entry regardless of whether the paper labeled it --
			// the paper's own label survives as the visible link TEXT
			// (`label`, see LLMPreformatted._assignLabels) rather than as
			// the key.
			//
			// Several fragments of one page-split listing share an id (see
			// extract-preformatted-sdt.js's grouping pass), so a link has to
			// highlight a region that may span pages. The reader's own
			// position format supports exactly two adjacent pages: `rects`
			// draws on `pageIndex`, and the optional `nextPageRects` draws
			// on `pageIndex + 1` (see reader/src/pdf/page.js's own
			// _drawHighlight / its highlightedPosition check) -- a field
			// that exists precisely for content straddling a page break.
			// There is no general N-page form, so:
			//   - every fragment on the anchor page is unioned into `rects`
			//     (fixes the same-page multi-fragment case outright),
			//   - fragments on the immediately following page go into
			//     `nextPageRects`,
			//   - a listing spanning 3+ pages shows only that two-page
			//     window; the rest is unreachable in one jump by
			//     construction.
			// The window is anchored on the page carrying the listing's own
			// CAPTION, so the jump always frames the labeled end -- and
			// since `nextPageRects` only ever extends FORWARD, an anchor
			// that's already the listing's last page steps back one so the
			// window covers the final two pages rather than running off the
			// end. An uncaptioned listing (or one whose caption page has no
			// rects) falls back to its first page, i.e. jump to the start.
			preformatted: (() => {
				let byId = new Map();
				for (let pf of preformattedIndex?.sentences || []) {
					if (pf.preformatted_id == null) continue;
					if (!byId.has(pf.preformatted_id)) byId.set(pf.preformatted_id, []);
					byId.get(pf.preformatted_id).push(pf);
				}

				let pageOf = pf => pf.position?.pageIndex ?? pf.pageIndex ?? null;
				let rectsOf = pf => pf.position?.rects || pf.rects || [];

				let map = new Map();
				for (let [id, fragments] of byId) {
					fragments.sort((a, b) => a.order - b.order);

					let rectsByPage = new Map();
					for (let pf of fragments) {
						let page = pageOf(pf);
						let rects = rectsOf(pf);
						if (page == null || !rects.length) continue;
						if (!rectsByPage.has(page)) rectsByPage.set(page, []);
						rectsByPage.get(page).push(...rects);
					}

					let captionFragment = fragments.find(pf => pf.caption);
					let caption = captionFragment?.caption || fragments.find(pf => pf.label)?.label || "";
					if (!rectsByPage.size) {
						map.set(id, { position: null, caption });
						continue;
					}

					let pages = [...rectsByPage.keys()].sort((a, b) => a - b);
					let captionPage = captionFragment ? pageOf(captionFragment) : null;
					let anchor = (captionPage != null && rectsByPage.has(captionPage)) ? captionPage : pages[0];
					// Anchor sits on the listing's last page -- step back one
					// so the two-page window covers [last - 1, last] instead
					// of pointing past the end (nextPageRects only extends
					// forward). Only when the previous page is genuinely
					// adjacent, so a non-contiguous page set never produces a
					// window with a gap in it.
					if (anchor === pages[pages.length - 1] && pages.length > 1) {
						let previous = pages[pages.indexOf(anchor) - 1];
						if (previous === anchor - 1) anchor = previous;
					}

					let position = { pageIndex: anchor, rects: rectsByPage.get(anchor) };
					let nextPageRects = rectsByPage.get(anchor + 1);
					if (nextPageRects) position.nextPageRects = nextPageRects;
					map.set(id, { position, caption });
				}
				return map;
			})(),
			// Keyed by annotationKey (a real, stable Zotero item key), not a
			// per-message ordinal -- see this method's own doc comment above.
			note: new Map(notes.map(n => [n.annotationKey, {
				annotationKey: n.annotationKey,
				position: n.position,
				caption: n.caption,
			}])),
			// Fallback lookup by the table's/figure's own LABEL text (e.g.
			// "table d.1", "figure f.8"), used by chat-pane.js's
			// _renderMarkdown ONLY when the primary table/tableExtra/figure/
			// figureExtra numeric lookup above fails -- a model that gets a
			// ref:table:N/ref:figure:N token wrong (wrong ref TYPE, e.g.
			// ref:figure:F.8 instead of ref:figureExtra:1, or an invented
			// number) has still almost always copied the VISIBLE LABEL
			// correctly, since that's just verbatim caption text, not
			// something it has to compute -- so resolving by that label
			// self-heals a malformed ref: token instead of leaving the link
			// silently dead. Covers every table/figure regardless of
			// table_num/table_extra_num vs figure_num/figure_extra_num, so
			// one shared map suffices rather than one per numbering scheme.
			byLabel: new Map([
				...(tableIndex?.tables || []).map(t => [t.label.toLowerCase(), { position: t.position, caption: t.caption }]),
				...(figureIndex?.figures || []).map(f => [f.label.toLowerCase(), { position: f.position, caption: f.caption }]),
			]),
		};
	},

	// Axis-aligned bounding box intersection -- both `a`/`b` are
	// [x0, y0, x1, y1] with x0<=x1, y0<=y1 already (both this codebase's own
	// rect producers -- LLMCitationPosition._getRectsForNodeRange and
	// Zotero's own annotationPosition -- always normalize min/max before
	// storing), so a plain overlap test suffices with no extra sorting.
	_rectsOverlap(a, b) {
		let [ax0, ay0, ax1, ay1] = a;
		let [bx0, by0, bx1, by1] = b;
		return ax0 < bx1 && ax1 > bx0 && ay0 < by1 && ay1 > by0;
	},

	// Returns the subset of `notes` (already filtered to highlight/underline
	// with a position, see buildPromptWithActivePDFContext) whose own rects
	// overlap `paragraph`'s -- same page, and at least one rect pair
	// intersects. `paragraph` carries its OWN pageIndex/rects directly (see
	// LLMCitation._textRecord), while a note's position is nested under
	// `.position` (see LLMNotes.formatAnnotation) -- different shapes, same
	// underlying {pageIndex, rects} convention either way.
	_findOverlappingNotes(paragraph, notes) {
		if (paragraph.pageIndex == null || !paragraph.rects?.length) return [];
		return notes.filter((note) => {
			let pos = note.position;
			if (!pos || pos.pageIndex !== paragraph.pageIndex || !pos.rects?.length) return false;
			return paragraph.rects.some(pRect => pos.rects.some(nRect => this._rectsOverlap(pRect, nRect)));
		});
	},

	// One <INLINE_NOTE_CONTEXT> block per overlapping highlight/underline --
	// kept deliberately terse (not the prose _formatNoteContext above uses
	// for the separate note-SELECTION feature) since this is injected
	// inline, once per overlapping paragraph, and can repeat several times
	// for one note that spans more than one paragraph. Deliberately a
	// DIFFERENT tag than the top-level <NOTE_CONTEXT> block.
	_formatInlineNoteContext(note) {
		return [
			"<INLINE_NOTE_CONTEXT>",
			`type: ${note.type} color: ${note.color || "none"}`,
			`highlighted text: "${note.highlightedText}" annotation: ${note.comment || ""}`,
			"</INLINE_NOTE_CONTEXT>",
		].join("\n");
	},

	// Builds the final <PDF_CONTEXT> body by merging `headings` (ALWAYS the
	// paper's full outline, in document order -- never RAG-filtered, see
	// buildPromptWithActivePDFContext's own comment on why) with
	// `paragraphs` and `preformatted` (each either the full list, for the
	// full-PDF case, or the top-K relevant ones from getRelevantChunks,
	// already re-sorted into document order there) back into ONE true
	// document-order sequence, using each side's own `order` (see
	// LLMCitation._buildTextElementsFromStructure) -- the three are
	// otherwise unrelated arrays with no shared index of their own.
	// 
	// A heading renders as `<HEADING>text</HEADING>`; a paragraph renders as
	// its own text, followed by an <INLINE_NOTE_CONTEXT> block for each
	// overlapping note (repeated after EVERY paragraph a note overlaps, not
	// just the first -- see _findOverlappingNotes)
	// 
	// A preformatted block renders as `<PREFORMATTED>text</PREFORMATTED>`
	// (no note-overlap injection for these -- not asked for, and a code/JSON
	// listing's own raw whitespace is kept intact rather than collapsed, see
	// _buildTextElementsFromStructure's own comment on why).
	// 
	// Whenever two headings end up ADJACENT in this merged sequence (no paragraph OR
	// preformatted block selected between them -- either because none
	// exists there, or because RAG didn't pick one from that section), a
	// bare "..." placeholder is inserted between them, so the model can
	// tell "nothing shown here" apart from "this section is a single
	// heading with no body text at all".
	_interleaveHeadingsAndParagraphs(headings, paragraphs, preformatted, notes) {
		// Several `preformatted` entries can share ONE preformatted_id --
		// that's how a single logical listing split across a page break is
		// represented (see extract-preformatted-sdt.js's own grouping pass:
		// each fragment stays its own entry, keeping its own page/rects for
		// highlighting, and they're tied together by a shared id).
		let groups = new Map();
		for (let pf of preformatted) {
			// A missing/undefined id (older cache, or a caller passing
			// something else through) falls back to a per-entry unique key,
			// preserving the old one-entry-per-block behavior rather than
			// wrongly collapsing every such entry into a single group.
			let key = pf.preformatted_id ?? `__ungrouped_${pf.order}`;
			let group = groups.get(key);
			if (!group) groups.set(key, { caption: pf.caption || "", label: pf.label || "", id: pf.preformatted_id ?? null, parts: [pf] });
			else {
				if (!group.caption && pf.caption) group.caption = pf.caption;
				if (!group.label && pf.label) group.label = pf.label;
				group.parts.push(pf);
			}
		}
		// Parts are re-sorted by their own `order` before joining rather
		// than relying on the incoming array's order -- the full-PDF path
		// does pass them in document order, but getRelevantChunks' own
		// top-K retrieval is free to return a group's fragments in any
		// order (and may return only SOME of them), so a listing's own
		// pieces would otherwise risk being concatenated scrambled.
		let groupedPreformatted = [...groups.values()].map((g) => {
			let parts = [...g.parts].sort((a, b) => a.order - b.order);
			return {
				order: parts[0].order,
				caption: g.caption,
				label: g.label,
				id: g.id,
				text: parts.map(p => p.text).join("\n"),
			};
		});

		let items = [
			...headings.map(h => ({ order: h.order, kind: "heading", heading: h })),
			...paragraphs.map(p => ({ order: p.order, kind: "paragraph", paragraph: p })),
			...groupedPreformatted.map(pf => ({ order: pf.order, kind: "preformatted", preformatted: pf })),
		].sort((a, b) => a.order - b.order);

		let lines = [];
		let lastWasHeading = false;
		for (let item of items) {
			if (item.kind === "heading") {
				if (lastWasHeading) lines.push("...");
				lines.push(`<HEADING>${item.heading.text}</HEADING>`);
				lastWasHeading = true;
			}
			else if (item.kind === "preformatted") {
				// Header line carries the block's own citable LABEL plus a
				// verbatim "cite as ref:preformatted:N" hint -- same
				// "<label>: cite as <ref>" shape <FIGURE_CONTEXT> already
				// uses, and the same reasoning: the model should never have
				// to count or invent N itself, just copy what it was shown.
				// The label is either the paper's own ("Listing 6",
				// "Algorithm 2") or a synthetic "Preformatted N" for an
				// unlabeled block (see LLMPreformatted._assignLabels). The
				// FULL caption text, when there is one, still follows on its
				// own line -- it's real content the model should see (e.g.
				// "Listing 6. A2A Capability Verification Example" says what
				// the listing actually does), just not what goes inside a
				// link.
				let pf = item.preformatted;
				let header = pf.id != null && pf.label
					? `${pf.label}: cite as ref:preformatted:${pf.id}`
					: (pf.label || "");
				let body = [header, pf.caption, pf.text].filter(Boolean).join("\n");
				lines.push(`<PREFORMATTED>${body}</PREFORMATTED>`);
				lastWasHeading = false;
			}
			else {
				let paragraphLines = [item.paragraph.text];
				for (let note of this._findOverlappingNotes(item.paragraph, notes)) {
					paragraphLines.push(this._formatInlineNoteContext(note));
				}
				lines.push(paragraphLines.join("\n"));
				lastWasHeading = false;
			}
		}
		return lines.join("\n\n");
	},

	async getAttachmentFullText(item) {
		let cacheFile = Zotero.Fulltext.getItemCacheFile(item).path;
		if (await IOUtils.exists(cacheFile)) {
			this.log(`Reading PDF context from full-text cache for item ${item.libraryKey}`);
			return Zotero.File.getContentsAsync(cacheFile);
		}

		if (item.isPDFAttachment()) {
			this.log(`Extracting PDF context for item ${item.libraryKey}`);
			let { text } = await Zotero.PDFWorker.getFullText(item.id, null, true);
			return text || "";
		}

		return "";
	},

	// `systemPrompt` (the citation/table/figure/equation formatting
	// instructions -- see _systemPrompt above) is returned SEPARATELY from
	// `prompt` now, rather than concatenated into it -- llm/request.js passes
	// it through to LLMInterfaces.streamModel as its own field (Anthropic's
	// Messages API takes it as a dedicated top-level `system` parameter,
	// not a message in the `messages` array; OpenAI-compatible endpoints
	// and Ollama's /api/chat get it prepended as a {role: "system"} message
	// instead -- see llm/interfaces.js). Everything else here (PDF/page/
	// selection context, the actual question) stays turn-specific, since
	// it's naturally query-dependent (retrieved chunks, selected text,
	// etc.) rather than something that'd make sense to send once for a
	// whole conversation.
	async buildPromptWithActivePDFContext({
		userPrompt,
		selectedText = null,
		pageText = null,
		onEmbeddingStart = null,
		onMessage = null,
		item = undefined,
		text = undefined,
		paragraphIndex = null,
		preformattedIndex = null,
	}) {
		if (item === undefined) item = LLMChatPane.getActiveReaderAttachment();
		let systemPrompt = [this._systemPrompt, this._historyStructureNote()].filter(Boolean).join(" ");

		if (!item || !item.isPDFAttachment()) {
			let parts = [];
			if (pageText) parts.push("<PAGE_CONTEXT>", pageText, "</PAGE_CONTEXT>");
			if (selectedText) parts.push("<SELECTION_CONTEXT>", selectedText, "</SELECTION_CONTEXT>");
			parts.push(userPrompt);
			return {
				prompt: parts.join("\n"),
				systemPrompt,
				contextInfo: null,
				selectedText,
				item: null,
			};
		}

		if (text === undefined) text = await this.getAttachmentFullText(item);
		if (!text.trim()) {
			return {
				prompt: userPrompt,
				systemPrompt,
				contextInfo: {
					title: item.getField("title") || item.libraryKey,
					missingText: true,
				},
				selectedText,
				item,
			};
		}

		let title = item.getField("title") || item.libraryKey;

		// Only highlight/underline notes participate in overlap injection
		// (see _joinParagraphsWithNoteContext) -- a sticky 'note' has no
		// highlighted span of its own to connect to a paragraph, and
		// selectNotesWithLLM's separate note-selection feature already
		// covers those. `position?.rects?.length` also drops any note whose
		// annotationPosition failed to parse (see formatAnnotation) --
		// nothing to overlap against without real rects.
		let notes = [];
		try {
			notes = (await LLMNotes.getNotes(item))
				.filter(n => (n.type === "highlight" || n.type === "underline") && n.position?.rects?.length);
		}
		catch (e) {
			this.log(`getNotes failed while building PDF context: ${e.message}`);
		}

		let context, retrieved = false, truncated = false, chunkCount = 0, preformattedCount = 0;
		// `paragraphIndex`/`preformattedIndex` are passed IN by the caller
		// (llm/request.js) rather than fetched here. Both the full-PDF and
		// chunked cases below read from them -- the SDT-derived paragraph
		// list and the combined SDT+PyMuPDF preformatted list -- since only
		// those carry the per-block pageIndex/rects that note-overlap
		// injection needs. Either may be null (extraction failed, or this
		// PDF's layout classifier produced no paragraph blocks at all), in
		// which case this falls through to the raw-text path below exactly
		// as before.
		//
		// Moved out of this function so that EVERY index a request needs is
		// built in ONE place: they can then be deduplicated against each
		// other (independent extractors routinely report the same physical
		// region as both a listing and an unlabelled table, see
		// LLMPreformatted.deduplicatePreformatted) and written to their
		// caches/the embeddings DB exactly once, instead of each module
		// persisting on its own before anything can compare them.

		// ALWAYS the paper's full heading outline, never narrowed by RAG --
		// see _interleaveHeadingsAndParagraphs's own comment for why: this is
		// what gives the model a complete structural overview of the paper
		// even when only a relevant subset of paragraphs is shown.
		let headings = paragraphIndex?.headings || [];

		if (paragraphIndex?.sentences?.length || preformattedIndex?.sentences?.length || headings.length) {
			// `.sentences` here is actually the PARAGRAPH (or, for
			// preformattedIndex, PREFORMATTED) list -- see getParagraphIndex/
			// getPreformattedIndex's own comments -- already in document
			// order, built by walking structure.content block-by-block.
			let allParagraphs = paragraphIndex?.sentences || [];
			let allPreformatted = preformattedIndex?.sentences || [];
			let fullText = allParagraphs.map(p => p.text).join("\n\n")
				+ allPreformatted.map(pf => pf.text).join("\n\n")
				+ headings.map(h => h.text).join(" ");
			if (fullText.length <= this.maxPDFContextChars) {
				// Full PDF fits within budget — every paragraph, preformatted
				// block, AND heading, in true document order.
				context = this._interleaveHeadingsAndParagraphs(headings, allParagraphs, allPreformatted, notes);
			}
			else {
				try {
					let [chunks, preformattedHits] = await Promise.all([
						allParagraphs.length
							? LLMCitation.getRelevantChunks(paragraphIndex, userPrompt, this.chunkContextTopK)
							: [],
						allPreformatted.length
							? LLMCitation.getRelevantChunks(preformattedIndex, userPrompt, this.chunkContextTopK)
							: [],
					]);
					// A listing split across a page break is embedded as
					// several independent per-fragment vectors, so retrieval
					// can match just one fragment of it -- expanded back to
					// the whole listing here, since a hit on any fragment
					// means the listing is relevant (see
					// LLMPreformatted.expandToFullGroups' own comment).
					// Deliberately AFTER the top-K cut rather than a larger
					// K: the expansion is driven by group membership, not
					// similarity, so it can't crowd out unrelated listings
					// the way simply retrieving more would.
					let preformattedChunks = LLMPreformatted.expandToFullGroups(allPreformatted, preformattedHits);
					// Headings alone (chunks/preformattedChunks empty, or
					// neither index available) still produce a usable
					// context -- an outline with no body text beats falling
					// through to the raw-text path below and losing the
					// outline entirely.
					if (chunks.length || preformattedChunks.length || headings.length) {
						context = this._interleaveHeadingsAndParagraphs(headings, chunks, preformattedChunks, notes);
						retrieved = true;
						chunkCount = chunks.length;
						// Counts rendered <PREFORMATTED> BLOCKS, not raw
						// fragments -- a page-split listing contributes
						// several fragments but renders as one block (see
						// _interleaveHeadingsAndParagraphs' own grouping), and
						// this number is quoted verbatim to the model/user in
						// the context note below.
						preformattedCount = new Set(
							preformattedChunks.map(pf => pf.preformatted_id ?? `__ungrouped_${pf.order}`)
						).size;
					}
				}
				catch (e) {
					this.log(`getRelevantChunks failed: ${e.message}`);
				}
			}
		}

		if (context === undefined) {
			// No usable SDT paragraph/preformatted structure
			// (getParagraphIndex/getPreformattedIndex/getRelevantChunks
			// failed or came back empty, and no headings either) -- fall
			// back to Zotero's own raw linear extraction, same behavior as
			// before this change. No note-overlap injection or heading
			// outline here: without per-block position data there's nothing
			// to overlap against or interleave.
			if (text.length <= this.maxPDFContextChars) {
				context = text;
			}
			else {
				truncated = true;
				context = text.slice(0, this.maxPDFContextChars);
			}
		}

		let parts = [
			"You are answering a question about the currently open PDF in Zotero.",
			"Use the PDF context below when it is relevant. If the answer is not supported by the PDF context, say so.",
			`PDF title: ${title}`,
			retrieved
				? `PDF context note: the full PDF was too large for the context budget; showing all ${headings.length} section headings for orientation, plus the ${chunkCount} paragraphs and ${preformattedCount} preformatted blocks most relevant to your question, retrieved by embedding similarity.`
				: (truncated ? `PDF context note: text was truncated to the first ${this.maxPDFContextChars} characters.` : ""),
			"<PDF_CONTEXT>",
			context,
			"</PDF_CONTEXT>",
		];
		if (pageText) parts.push("<PAGE_CONTEXT>", pageText, "</PAGE_CONTEXT>");
		if (selectedText) parts.push("<SELECTION_CONTEXT>", selectedText, "</SELECTION_CONTEXT>");
		parts.push("<USER_QUESTION>", userPrompt, "</USER_QUESTION>");

		return {
			prompt: parts.filter(line => line !== "").join("\n"),
			systemPrompt,
			contextInfo: {
				title,
				charCount: text.length,
				truncated,
				retrieved,
				chunkCount,
				preformattedCount,
			},
			selectedText,
			item,
		};
	},
};
