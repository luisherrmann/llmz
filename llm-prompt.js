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
		"Each entry in <NOTE_CONTEXT> starts with 'Note N (...):' -- when you mention one, wrap it in a link so the reader can jump to it: [Note N](<ref:note:N>), using the exact N shown for that entry (this N is unrelated to any other numbering in this conversation, e.g. reference numbers).",
		"Example: 'Your highlight on this point [Note 1](<ref:note:1>) is directly relevant here.'",
	].join(" "),

	log(msg) {
		Zotero.debug("LLM Chat Pane [Prompt]: " + msg);
	},

	// Asks the LLM itself to pick the most relevant figure by number, given the
	// list of figure captions. Tried embedding-based retrieval first (both plain
	// image-embedding similarity and text/image score fusion via raw max, z-score
	// max, and Reciprocal Rank Fusion at various k) — all of them conflated a
	// merely topically-adjacent caption with genuine relevance on queries like
	// "is there a figure describing model performance", consistently picking a
	// data-prep figure that shares vocabulary ("model", "evaluate", "test") over
	// the actual performance-metrics figure. An LLM reading the captions can
	// reason about what they mean rather than just measuring vector distance,
	// and got this and three other test queries right where every embedding
	// fusion approach failed at least one.
	async selectFigureWithLLM(figureIndex, query) {
		let figures = figureIndex?.figures;
		if (!figures?.length) return null;

		let captionList = figures.map(f => `${f.label}: ${f.caption}`).join("\n");
		let selectionPrompt = [
			"You are choosing which figure (if any) from a scientific paper best helps answer a user's question.",
			"Here are the figures in this paper:",
			captionList,
			"",
			`User's question: "${query}"`,
			"",
			'Respond with ONLY the figure number (e.g. "4") that best matches the question, or "none" if no figure is relevant. Do not include any other text.',
		].join("\n");

		let result = await LLMInterfaces.streamModel(selectionPrompt, () => {}, {});
		let text = (result.text || "").trim();
		if (!text || /none/i.test(text)) return null;
		let match = text.match(/\d+/);
		if (!match) return null;
		let figureNum = parseInt(match[0], 10);
		return figures.find(f => f.figure_num === figureNum) || null;
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

	_formatEquationText(eq) {
		return `**${eq.label}:** ${eq.text}`;
	},

	// Asks the LLM to pick the most relevant equation, given each equation's
	// full extracted text (equations are text-native and short, like tables'
	// contentText, so showing all of them in full is cheap) — same approach
	// and rationale as selectTableWithLLM above. Equations come in two label
	// series -- "Equation N" (the paper's own number) and "Formula N"
	// (document-order among unlabeled ones) -- which share the same numeric
	// range and would collide under a bare-number response (e.g. "3" could
	// mean either), so selection is matched against the exact label text
	// instead, unlike the numeric matching selectTableWithLLM/
	// selectFigureWithLLM use.
	async selectEquationWithLLM(equationIndex, query) {
		let equations = equationIndex?.equations;
		if (!equations?.length) return null;

		let equationContext = equations.map(eq => `${eq.label}: ${eq.text}`).join("\n");
		let selectionPrompt = [
			"You are choosing which equation (if any) from a scientific paper best helps answer a user's question.",
			"Here are the equations in this paper, each preceded by its exact label:",
			"",
			equationContext,
			"",
			`User's question: "${query}"`,
			"",
			'Respond with ONLY the exact label of the best-matching equation (e.g. "Equation 3" or "Formula 2"), or "none" if no equation is relevant. Do not include any other text.',
		].join("\n");

		let result = await LLMInterfaces.streamModel(selectionPrompt, () => {}, {});
		let text = (result.text || "").trim().replace(/^["'.]+|["'.]+$/g, "");
		if (!text || /^none$/i.test(text)) return null;
		return equations.find(eq => eq.label.toLowerCase() === text.toLowerCase()) || null;
	},

	// Asks the LLM to pick the most relevant table by number, given each table's
	// full content (not just captions — unlike figures, table content is text-native
	// and cheap to show in full). Validated against image embedding and text-embedding
	// max(caption, content) on 5 content-specific queries: image embedding scored 1/5
	// (table images are visually near-identical grids, giving it little to work with —
	// worse than for figures, which are visually distinctive), text-max scored 3/5
	// (failed when one table merely mentioned the query's keywords more often than the
	// table that actually answered it), LLM selection scored 5/5.
	async selectTableWithLLM(tableIndex, query) {
		let tables = tableIndex?.tables;
		if (!tables?.length) return null;

		let tableContext = tables.map(t => `${t.label}: ${t.caption}\n${t.contentText}`).join("\n\n");
		let selectionPrompt = [
			"You are choosing which table (if any) from a scientific paper best helps answer a user's question.",
			"Here are the tables in this paper:",
			"",
			tableContext,
			"",
			`User's question: "${query}"`,
			"",
			'Respond with ONLY the table number (e.g. "3") that best matches the question, or "none" if no table is relevant. Do not include any other text.',
		].join("\n");

		let result = await LLMInterfaces.streamModel(selectionPrompt, () => {}, {});
		let text = (result.text || "").trim();
		if (!text || /none/i.test(text)) return null;
		let match = text.match(/\d+/);
		if (!match) return null;
		let tableNum = parseInt(match[0], 10);
		return tables.find(t => t.table_num === tableNum) || null;
	},

	// `refNum` is a per-request index (1..K over just the notes actually
	// selected for THIS message, not a stable paper-wide number like
	// table/figure/equation numbers) -- notes have no natural number of their
	// own, so this is purely a label the model can echo back in
	// [Note N](<ref:note:N>) to make its own mention of it clickable. Not
	// persisted or stable across turns -- linkIndex is rebuilt fresh per
	// message anyway (see llm-chat-pane.js), so that's fine.
	_formatNoteContext(note, refNum) {
		return `**Note ${refNum} (${note.title}):** ${note.text}`;
	},

	// Asks the LLM which of the user's own notes on this paper are relevant,
	// given each note's full text -- same "let the LLM read the full, short
	// content and pick" approach as selectTableWithLLM, but multi-select
	// (unlike the other selectXWithLLM helpers): a query like "what notes do
	// I have on this page?" can genuinely have several right answers, not
	// one. This is still a SINGLE round-trip over all candidates -- the model
	// reads the whole list once and returns every relevant number, rather
	// than one call per candidate (O(N) calls, and N here can be dozens).
	// Notes have no paper-native number to key off of (unlike tables/
	// figures/equations), so this numbers them 1..N purely for this one
	// selection round-trip -- that index has no meaning outside this call
	// and isn't persisted. Capped at MAX_SELECTED_NOTES as a sanity limit in
	// case the model over-selects on a broad query -- extras beyond the cap
	// are dropped (in the model's own returned order) rather than bloating
	// the prompt with every note in the paper.
	//
	// readerContext ({ pageNum, selectedText, selectedAnnotationNote })
	// surfaces what page the user is currently looking at, any text they have
	// selected there, and any annotation they have actively selected/
	// highlighted in the reader -- clicked on the page or in the sidebar, no
	// distinction (LLMChatPane.getSelectedAnnotation(), pre-formatted via
	// LLMNotes.formatAnnotation() into the same { title, text } shape as
	// `notes`). Without pageNum, a page-scoped question like "what notes do I
	// have on this page?" has nothing to match against, since the query
	// itself carries no page number and each note's title only states ITS
	// OWN page (e.g. "Highlight (p. 4)"), not what page the user means by
	// "this page". selectedAnnotationNote is the strongest possible signal
	// for a query like "explain this" -- the user is looking right at it.
	async selectNotesWithLLM(notes, query, readerContext = {}) {
		if (!notes?.length) return [];

		const MAX_SELECTED_NOTES = 10;
		let { pageNum, selectedText, selectedAnnotationNote } = readerContext;
		let noteContext = notes.map((n, i) => `Note ${i + 1} (${n.title}): ${n.text}`).join("\n\n");
		let contextLines = [];
		if (pageNum) contextLines.push(`The user is currently viewing page ${pageNum} of the PDF.`);
		if (selectedText) {
			contextLines.push(`The user currently has this text selected on that page: "${selectedText.slice(0, 300)}${selectedText.length > 300 ? "…" : ""}"`);
		}
		if (selectedAnnotationNote) {
			contextLines.push(`The user currently has this annotation selected/highlighted in the reader: ${selectedAnnotationNote.title}: ${selectedAnnotationNote.text}`);
		}

		let selectionPrompt = [
			"You are choosing which of the user's own notes/highlights/underlines on this paper (if any) are relevant to a user's question. There may be zero, one, or several relevant notes -- include all of them, not just the single best one.",
			...contextLines,
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
