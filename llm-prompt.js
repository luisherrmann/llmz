// Builds the prompt sent to the answering model: the shared system prompt
// (citation/table/figure/equation link-format instructions), assembling PDF
// context (full text, or the most relevant retrieved chunks when the full
// text doesn't fit) via buildPromptWithActivePDFContext, and the LLM-based
// "pick the most relevant X for this question" selection helpers
// (select{Figure,Table,Equation}WithLLM) plus their corresponding
// <TABLE_CONTEXT>/<REFERENCE_CONTEXT>/<EQUATION_CONTEXT> formatting helpers.
// Split out from llm-chat-pane.js since this is a self-contained concern
// (what goes into the prompt, and how) distinct from the chat pane's own
// UI/rendering logic and Zotero-reader-interaction plumbing
// (getActiveReaderAttachment etc., which stay in llm-chat-pane.js since
// they're used well beyond prompt-building -- e.g. message-history keying --
// and are called back into from here where needed) -- same rationale as the
// llm-interfaces.js split.
LLMPrompt = {
	maxPDFContextChars: 60000,
	maxPageContextChars: 5000,
	chunkContextTopK: 10,
	_systemPrompt: [
		"You are a helpful research assistant.",
		"Always express mathematical formulas and equations using LaTeX notation.",
		"Wrap every mathematical formula in latex notation as $<formula>$.",
		"For display math, you MUST wrap the formula in double dollar signs: $$<formula>$$. The opening $$ and closing $$ are mandatory.",
		"Always format tables as display math: $$\\begin{array}{|c|c|}\\hline ... \\\\\\hline\\end{array}$$.",
		"The opening $$ and closing $$ around \\begin{array} are mandatory. Never use \\begin{tabular}.",
		"When you state facts or findings from the PDF, add a citation link immediately after the claim.",
		"Citation format: [CITE](<find:exact phrase>). Always use the literal token [CITE] — numbering is assigned automatically.",
		"The exact phrase is 4–8 consecutive words copied verbatim from the <PDF_CONTEXT> — no paraphrasing.",
		"The angle brackets around find: are mandatory.",
		"Example: 'The mutation rate increases [CITE](<find:error-prone DNA polymerases to increase>).'",
		"Whenever you mention a table (e.g. from <TABLE_CONTEXT>), a figure shown to you as an image, or a numbered equation the paper itself labels (e.g. from <EQUATION_CONTEXT>, or one you see numbered like '(3)' in the PDF text), wrap that mention in a link so the reader can jump to it.",
		"Format: [Table N](<ref:table:N>), [Figure N](<ref:figure:N>), or [Equation N](<ref:equation:N>), where N is the table/figure/equation number.",
		"For equations, N is the bare number the PDF prints next to the equation (e.g. for '(3)', use ref:equation:3), and only use this for equations the PDF itself numbers this way — never invent a number for an unlabeled formula.",
		"An equation shown to you in <EQUATION_CONTEXT> labeled 'Formula N' has no number in the original paper, so it uses a different link format: [Formula N](<ref:formula:N>), using the exact N shown to you in <EQUATION_CONTEXT> (do not confuse this with the ref:equation:N format above, which is only for equations the PDF itself numbers).",
		"The visible label in brackets must be the exact label as given in its context (e.g. 'Table 1', 'Figure 2a', 'Equation 3', 'Formula 8') — do not renumber, reletter, or rephrase it.",
		"The angle brackets around ref: are mandatory, exactly like the citation format above.",
		"Example: 'As shown in [Table 1](<ref:table:1>), the reaction rate doubles.'",
		"Example: 'Substituting into [Equation 3](<ref:equation:3>) gives the closed-form solution.'",
		"Example: 'The training objective combines these into [Formula 8](<ref:formula:8>).'",
		"A <REFERENCE_CONTEXT> block, if present, lists the papers cited in this PDF's own bibliography, numbered exactly as in the original paper.",
		"You may cite one of these entries if it genuinely helps answer the question (e.g. it's the direct source of a claim, or clearly relevant further reading) — do not force one in otherwise, and do not list entries just because they exist.",
		"Format any such citation as [N](<ref:reference:N>), where N is the bibliography number, e.g. '[3]' — matching how the paper itself cites its own references.",
		"Example: 'This approach was first proposed by [12](<ref:reference:12>).'",
		"A <NOTE_CONTEXT> block, if present, contains one or more of the user's own annotations on this PDF -- each either a sticky note they wrote, or a passage they highlighted/underlined (quoted verbatim from the PDF) together with any comment they added on it. Any 'Note:' text in it is the user's own authoritative commentary, distinct from the paper's own claims -- don't confuse the two.",
		"Each entry in <NOTE_CONTEXT> starts with 'Note N (...) [key: XXXXXXXX]:' -- when you mention it, wrap it in a link so the reader can jump to it: [Note N](<ref:note:XXXXXXXX>). Use 'Note N' (that entry's display number) as the visible label, but the link target itself must be the exact key shown in brackets, not N -- copy the key exactly, character for character; never use N or invent a key.",
		"Example: for an entry 'Note 1 (Highlight, p. 4) [key: AB12CD34]: ...', write 'Your highlight on this point [Note 1](<ref:note:AB12CD34>) is directly relevant here.' -- 'Note 1' is the label, 'AB12CD34' (that note's own key) is the link target.",
		"Whenever you mention a specific page of the PDF by number (e.g. 'on page 5', 'see page 12'), wrap the page number in a link so the reader can jump straight there: [page N](<ref:page:N>), where N is the page number -- this works for any page, not just ones with a table/figure/equation/note on them, and is separate from those ref: formats above.",
		"Example: 'The methodology is described in more detail on [page 7](<ref:page:7>).'",
	].join(" "),

	log(msg) {
		Zotero.debug("LLM Chat Pane [Prompt]: " + msg);
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
	// Multi-select (up to MAX_SELECTED_FIGURES) in a single round-trip, same
	// rationale as selectNotesWithLLM below: a query can genuinely have
	// several relevant figures, and reading the whole caption list once and
	// returning every relevant number is one call regardless of how many
	// match, vs. O(N) calls for a one-call-per-candidate approach.
	async selectFiguresWithLLM(figureIndex, query, readerContext = {}) {
		let figures = figureIndex?.figures;
		if (!figures?.length) return [];

		const MAX_SELECTED_FIGURES = 10;
		let captionList = figures.map(f => `${f.label}: ${f.caption}`).join("\n");
		let selectionPrompt = [
			"You are choosing which figures (if any) from a scientific paper help answer a user's question. There may be zero, one, or several relevant figures -- include all of them, not just the single best one.",
			...this._buildReaderContextLines(readerContext),
			"Here are the figures in this paper:",
			captionList,
			"",
			`User's question: "${query}"`,
			"",
			'Respond with ONLY a comma-separated list of every relevant figure number (e.g. "2, 5"), or "none" if no figure is relevant. Do not include any other text.',
		].join("\n");

		let result = await LLMInterfaces.streamModel(selectionPrompt, () => {}, {});
		let text = (result.text || "").trim();
		if (!text || /none/i.test(text)) return [];

		let seen = new Set();
		let selected = [];
		for (let match of text.matchAll(/\d+/g)) {
			let figureNum = parseInt(match[0], 10);
			if (seen.has(figureNum)) continue;
			let figure = figures.find(f => f.figure_num === figureNum);
			if (!figure) continue;
			seen.add(figureNum);
			selected.push(figure);
			if (selected.length >= MAX_SELECTED_FIGURES) break;
		}
		return selected;
	},

	_formatTableMarkdown(t) {
		let [header, ...rows] = t.data;
		let sep = header ? "| " + header.map(() => "---").join(" | ") + " |" : "";
		let mdHeader = header ? "| " + header.join(" | ") + " |" : "";
		let mdRows = rows.map(r => "| " + r.join(" | ") + " |").join("\n");
		return `**[p.${t.page_num}] ${t.label}:** ${t.caption}\n${mdHeader}\n${sep}\n${mdRows}`;
	},

	_formatReferenceContext(references) {
		return references.map(r => `[${r.index}] ${r.text}`).join("\n");
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
	async shouldIncludeReferencesWithLLM(referenceIndex, query, readerContext = {}) {
		let references = referenceIndex?.references;
		if (!references?.length) return false;

		let selectionPrompt = [
			"You are deciding whether a scientific paper's full bibliography/reference list would help answer a user's question.",
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
	// MAX_SELECTED_EQUATIONS) in a single round-trip, same rationale as
	// selectNotesWithLLM below.
	async selectEquationsWithLLM(equationIndex, query, readerContext = {}) {
		let equations = equationIndex?.equations;
		if (!equations?.length) return [];

		const MAX_SELECTED_EQUATIONS = 10;
		let equationContext = equations.map(eq => `${eq.label}: ${eq.text}`).join("\n");
		let selectionPrompt = [
			"You are choosing which equations (if any) from a scientific paper help answer a user's question. There may be zero, one, or several relevant equations -- include all of them, not just the single best one.",
			...this._buildReaderContextLines(readerContext),
			"Here are the equations in this paper, each preceded by its exact label:",
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
			if (selected.length >= MAX_SELECTED_EQUATIONS) break;
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
	// Multi-select (up to MAX_SELECTED_TABLES) in a single round-trip, same
	// rationale as selectNotesWithLLM below.
	async selectTablesWithLLM(tableIndex, query, readerContext = {}) {
		let tables = tableIndex?.tables;
		if (!tables?.length) return [];

		const MAX_SELECTED_TABLES = 10;
		let tableContext = tables.map(t => `${t.label}: ${t.caption}\n${t.contentText}`).join("\n\n");
		let selectionPrompt = [
			"You are choosing which tables (if any) from a scientific paper help answer a user's question. There may be zero, one, or several relevant tables -- include all of them, not just the single best one.",
			...this._buildReaderContextLines(readerContext),
			"Here are the tables in this paper:",
			"",
			tableContext,
			"",
			`User's question: "${query}"`,
			"",
			'Respond with ONLY a comma-separated list of every relevant table number (e.g. "1, 3"), or "none" if no table is relevant. Do not include any other text.',
		].join("\n");

		let result = await LLMInterfaces.streamModel(selectionPrompt, () => {}, {});
		let text = (result.text || "").trim();
		if (!text || /none/i.test(text)) return [];

		let seen = new Set();
		let selected = [];
		for (let match of text.matchAll(/\d+/g)) {
			let tableNum = parseInt(match[0], 10);
			if (seen.has(tableNum)) continue;
			let table = tables.find(t => t.table_num === tableNum);
			if (!table) continue;
			seen.add(tableNum);
			selected.push(table);
			if (selected.length >= MAX_SELECTED_TABLES) break;
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
	async selectNotesWithLLM(notes, query, readerContext = {}) {
		if (!notes?.length) return [];

		const MAX_SELECTED_NOTES = 10;
		let noteContext = notes.map((n, i) => `Note ${i + 1} (${n.title}): ${n.text}`).join("\n\n");

		let selectionPrompt = [
			"You are choosing which of the user's own notes/highlights/underlines on this paper (if any) are relevant to a user's question. There may be zero, one, or several relevant notes -- include all of them, not just the single best one.",
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
	// / `ref:note:KEY` links -- shared by request.js (a live request, with
	// `selectedNotes`, this message's own LLM-picked subset) and
	// llm-chat-pane.js's onImport (a historical message, which instead
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
	buildLinkIndex({ tableIndex, figureIndex, referenceIndex, equationIndex, notes = [] }) {
		return {
			table: new Map((tableIndex?.tables || []).map(t => [t.table_num, { position: t.position, caption: t.caption }])),
			figure: new Map((figureIndex?.figures || []).map(f => [f.figure_num, { position: f.position, caption: f.caption }])),
			reference: new Map((referenceIndex?.references || []).map(r => [r.index, {
				label: `[${r.index}] ${r.text}`,
				caption: r.text.split(/\s+/).slice(0, 8).join(" "),
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
			// Keyed by annotationKey (a real, stable Zotero item key), not a
			// per-message ordinal -- see this method's own doc comment above.
			note: new Map(notes.map(n => [n.annotationKey, {
				annotationKey: n.annotationKey,
				position: n.position,
				caption: n.caption,
			}])),
		};
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

	async buildPromptWithActivePDFContext(userPrompt, selectedText = null, pageText = null) {
		let item = LLMChatPane.getActiveReaderAttachment();

		if (!item || !item.isPDFAttachment()) {
			let parts = [];
			if (pageText) parts.push("<PAGE_CONTEXT>", pageText, "</PAGE_CONTEXT>");
			if (selectedText) parts.push("<SELECTION_CONTEXT>", selectedText, "</SELECTION_CONTEXT>");
			parts.push(this._systemPrompt, userPrompt);
			return {
				prompt: parts.join("\n"),
				contextInfo: null,
				selectedText,
				item: null,
				citationIndex: null,
			};
		}

		let text = await this.getAttachmentFullText(item);
		if (!text.trim()) {
			return {
				prompt: userPrompt,
				contextInfo: {
					title: item.getField("title") || item.libraryKey,
					missingText: true,
				},
				selectedText,
				item,
				citationIndex: null,
			};
		}

		let title = item.getField("title") || item.libraryKey;

		let citationIndex = null;
		try {
			citationIndex = await LLMCitation.getCitationIndex(item, text);
		}
		catch (e) {
			this.log(`getCitationIndex failed: ${e.message}`);
		}

		let context, retrieved = false, truncated = false, chunkCount = 0;
		if (text.length <= this.maxPDFContextChars) {
			// Full PDF fits within budget — use it as-is, no chunking needed.
			context = text;
		}
		else {
			try {
				let paragraphIndex = await LLMCitation.getParagraphIndex(item, text);
				if (paragraphIndex) {
					let chunks = await LLMCitation.getRelevantChunks(paragraphIndex, userPrompt, this.chunkContextTopK);
					if (chunks.length) {
						context = chunks.join("\n\n");
						retrieved = true;
						chunkCount = chunks.length;
					}
				}
			}
			catch (e) {
				this.log(`getParagraphIndex/getRelevantChunks failed: ${e.message}`);
			}
			if (!retrieved) {
				truncated = true;
				context = text.slice(0, this.maxPDFContextChars);
			}
		}

		let parts = [
			"You are answering a question about the currently open PDF in Zotero.",
			"Use the PDF context below when it is relevant. If the answer is not supported by the PDF context, say so.",
			`PDF title: ${title}`,
			retrieved
				? `PDF context note: the full PDF was too large for the context budget; showing the ${chunkCount} paragraphs most relevant to your question, retrieved by embedding similarity.`
				: (truncated ? `PDF context note: text was truncated to the first ${this.maxPDFContextChars} characters.` : ""),
			"<PDF_CONTEXT>",
			context,
			"</PDF_CONTEXT>",
		];
		if (pageText) parts.push("<PAGE_CONTEXT>", pageText, "</PAGE_CONTEXT>");
		if (selectedText) parts.push("<SELECTION_CONTEXT>", selectedText, "</SELECTION_CONTEXT>");
		parts.push(this._systemPrompt, "<USER_QUESTION>", userPrompt, "</USER_QUESTION>");

		return {
			prompt: parts.filter(line => line !== "").join("\n"),
			contextInfo: {
				title,
				charCount: text.length,
				truncated,
				retrieved,
				chunkCount,
			},
			selectedText,
			item,
			citationIndex,
		};
	},
};
