// Enumerates every extracted element of ONE type (figure/table/equation/
// preformatted) for the paper open in the reader, as a numbered markdown
// list of clickable links -- "list all figures", "what tables are in this
// paper", "enumerate the code listings".
//
// Deliberately NOT a model-generated answer. The normal chat flow could
// produce a list like this too, but only from whatever subset of the paper
// fit that turn's context budget (see llm/prompt.js's own top-K selection
// for tables/figures/equations/preformatted), and only as well as the model
// counts -- both of which fail exactly on the papers where an exhaustive
// list matters most: the ones with 20+ figures. This reads the extraction
// caches directly, so the list is complete by construction, in true
// document order, with every number and label taken from the index rather
// than restated by a model that never saw all of them at once.
//
// The same reasoning applies to the links: each entry's ref: token is built
// from the index entry's own id, so a link here can't be mis-numbered the
// way a model-written one can (which is why llm/prompt.js has to warn the
// model three separate times not to invent an N, and why chat-pane.js's
// _renderMarkdown carries a byLabel fallback for when it does anyway).
LLMListElements = {
	log(msg) {
		Zotero.debug("LLM Chat Pane [ListElements]: " + msg);
	},

	// Longest a single entry's visible link text may get before it's
	// truncated. Labels are usually short and paper-native ("Figure 3",
	// "Listing 6"), but an uncaptioned element gets a synthetic label
	// derived from its enclosing section instead (see
	// extract-figures-sdt.js/LLMPreformatted._assignLabels), and a table
	// whose caption IS its label can run to several hundred characters --
	// which would turn one row of this list into a paragraph.
	_MAX_LABEL: 100,

	// One entry per element type the tool accepts. Each supplies:
	//   plural/singular -- for the surrounding prose.
	//   indexKey        -- this index's own parameter name in
	//                      llm/prompt.js's buildLinkIndex, so the returned
	//                      linkIndex can be built from the index already
	//                      fetched here instead of re-reading all four.
	//   getIndex()      -- the cache accessor (all four hit the same
	//                      memory/disk cache the normal chat flow uses, so
	//                      this never re-extracts if a chat turn already
	//                      ran for this paper).
	//   entries()       -- where the per-element records live in that index.
	//   ref()           -- the ref: payload for one entry, MINUS the
	//                      leading "ref:". Types that split numbered from
	//                      un-numbered elements across two linkIndex maps
	//                      (table/tableExtra, figure/figureExtra,
	//                      equation/formula -- see
	//                      llm/prompt.js's buildLinkIndex for why each
	//                      split exists) pick the matching one here.
	//   page()          -- 1-based page number, from whichever field this
	//                      index exposes it as.
	//   dedupe()        -- optional; returns a stable per-ELEMENT key when
	//                      one element can span several index entries.
	_TYPES: {
		figure: {
			plural: "figures",
			singular: "figure",
			indexKey: "figureIndex",
			getIndex: (item, onMessage) => LLMFigures.getFigureIndex(item, undefined, onMessage),
			entries: index => index?.figures || [],
			ref: f => (f.figure_num !== null && f.figure_num !== undefined
				? `figure:${f.figure_num}`
				: (f.figure_extra_num != null ? `figureExtra:${f.figure_extra_num}` : null)),
			page: f => f.page_num,
		},
		table: {
			plural: "tables",
			singular: "table",
			indexKey: "tableIndex",
			getIndex: (item, onMessage) => LLMTables.getTableIndex(item, undefined, onMessage),
			entries: index => index?.tables || [],
			ref: t => (t.table_num !== null && t.table_num !== undefined
				? `table:${t.table_num}`
				: (t.table_extra_num != null ? `tableExtra:${t.table_extra_num}` : null)),
			page: t => t.page_num,
		},
		equation: {
			plural: "equations",
			singular: "equation",
			indexKey: "equationIndex",
			getIndex: (item, onMessage) => LLMEquations.getEquationIndex(item, undefined, onMessage),
			entries: index => index?.equations || [],
			// equation_num is the paper's OWN printed "(3)"; everything else
			// is carried in a separate synthetic "Formula N" series -- the
			// two share a numeric range, hence two maps (see buildLinkIndex).
			ref: eq => (eq.equation_num !== null && eq.equation_num !== undefined
				? `equation:${eq.equation_num}`
				: (eq.formula_num != null ? `formula:${eq.formula_num}` : null)),
			// No page_num of its own on this index, unlike table/figure.
			page: eq => (eq.position?.pageIndex != null ? eq.position.pageIndex + 1 : null),
		},
		preformatted: {
			plural: "preformatted blocks",
			singular: "preformatted block",
			indexKey: "preformattedIndex",
			getIndex: (item, onMessage) => LLMPreformatted.getPreformattedIndex(item, undefined, onMessage),
			entries: index => index?.sentences || [],
			ref: pf => (pf.preformatted_id != null ? `preformatted:${pf.preformatted_id}` : null),
			page: pf => (pf.pageIndex != null ? pf.pageIndex + 1 : null),
			// A listing split across a page break (or across columns) is
			// several entries sharing ONE preformatted_id -- see
			// extract-preformatted-sdt.js's grouping pass. Listing it once
			// per fragment would show "Listing 7" twice with two different
			// page numbers; keeping the first fragment shows it once, at
			// the page it starts on.
			dedupe: pf => pf.preformatted_id,
		},
	},

	// Native-tool-calling descriptor (see llm/intent.js's _registry/
	// detectIntent). No `resolver`: unlike the other three tools, this one
	// has nothing to resolve -- there's no user-named subset to map onto
	// index numbers, the answer is always "all of them" -- so
	// llm/request.js branches to it BEFORE its own _resolveIntentIndices
	// runs rather than routing through it.
	intentTool: {
		name: "list_elements",
		description: [
			"Lists or enumerates ALL elements of one given type (figures, tables,",
			"equations, or preformatted/code blocks) from the paper currently open in",
			"the reader, as a numbered list of links. Use this whenever the user asks",
			"what elements of a type the paper contains, or asks to list, enumerate,",
			"show, or give an overview of them -- e.g. 'list all figures', 'what",
			"tables are in this paper', 'show me the code listings', 'how many",
			"equations are there'. Only for enumerating the elements themselves: do",
			"NOT use it to export tables to CSV/zip (a separate tool does that), to",
			"answer a question ABOUT the content of any element, or to list anything",
			"other than these four types (in particular NOT for bibliography",
			"references).",
		].join(" "),
		schema: {
			type: "object",
			properties: {
				elementType: {
					type: "string",
					enum: ["figure", "table", "equation", "preformatted"],
					description: [
						"Which type to list. preformatted covers code listings,",
						"algorithm blocks, JSON/config samples, and any other",
						"monospaced verbatim block -- use it for a request naming any",
						"of those.",
					].join(" "),
				},
			},
			required: ["elementType"],
		},

		// This tool's own arguments validator (see llm/intent.js's
		// detectIntent, which prefers this over its shared six-shape
		// `index`-oriented one). Checks elementType against the real
		// _TYPES table rather than just re-checking the schema's enum, so
		// a model returning a plausible-but-unsupported type ("listing",
		// "algorithm") resolves to no tool call at all instead of reaching
		// listElements and throwing.
		toIntent(args) {
			let elementType = args?.elementType;
			if (typeof elementType !== "string") return null;
			return LLMListElements._TYPES[elementType] ? { elementType } : null;
		},
	},

	// Truncates one entry's visible link text -- see _MAX_LABEL. Cuts on a
	// word boundary where there is one nearby, so a truncated label still
	// ends in a readable word rather than mid-token.
	_truncate(text) {
		if (text.length <= this._MAX_LABEL) return text;
		let cut = text.slice(0, this._MAX_LABEL);
		let lastSpace = cut.lastIndexOf(" ");
		if (lastSpace > this._MAX_LABEL * 0.6) cut = cut.slice(0, lastSpace);
		return cut.trimEnd() + "...";
	},

	// Builds the markdown list for `elementType` from `pdfItem`'s caches.
	// Returns { markdown, linkIndex } -- llm/request.js owns rendering it
	// (via the same chatPane._renderMarkdown + chat.renderMarkdownMessage
	// pair a normal reply goes through, so these links behave identically
	// to a model-written one, including on transcript re-import).
	//
	// `linkIndex` covers ONLY the listed type -- built here, from the index
	// this function already fetched, rather than by the caller re-reading
	// all four indexes just to resolve links into one of them. Every other
	// map buildLinkIndex would build comes back empty, which is harmless:
	// nothing in `markdown` refers to them.
	//
	// `onMessage` is forwarded into the index accessors so a cold cache
	// still reports its extraction progress into the chat, exactly as it
	// does when a normal chat turn triggers the same extraction.
	async listElements(elementType, pdfItem, onMessage) {
		let spec = this._TYPES[elementType];
		if (!spec) throw new Error(`Unknown element type "${elementType}"`);

		let index = await spec.getIndex(pdfItem, onMessage);
		let entries = spec.entries(index);

		if (spec.dedupe) {
			let seen = new Set();
			entries = entries.filter((e) => {
				let key = spec.dedupe(e);
				// A null key means "not part of any group" -- keep every
				// such entry rather than collapsing them all onto one row.
				if (key == null) return true;
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			});
		}

		let linkIndex = LLMPrompt.buildLinkIndex({ [spec.indexKey]: index });

		if (!entries.length) {
			return { markdown: `No ${spec.plural} were found in this paper.`, linkIndex };
		}

		// Index order IS document order for all four types -- each
		// extractor sorts before returning (see extract-figures-sdt.js's
		// own compareReadingOrder, and the blockIndex ordering the others
		// use) -- so this deliberately doesn't re-sort.
		let lines = entries.map((entry, i) => {
			let label = this._truncate((entry.label || "").trim() || `${spec.singular} ${i + 1}`);
			let ref = spec.ref(entry);
			let page = spec.page(entry);
			let suffix = page ? ` (p. ${page})` : "";
			// An entry with no usable ref can't be linked -- still list it,
			// as plain text, rather than dropping it and under-reporting
			// the count.
			let linked = ref ? `[${label}](<ref:${ref}>)` : label;
			return `${i + 1}. ${linked}${suffix}`;
		});

		let noun = entries.length === 1 ? spec.singular : spec.plural;
		let markdown = `Found ${entries.length} ${noun} in this paper:\n\n${lines.join("\n")}`;
		return { markdown, linkIndex };
	},
};
