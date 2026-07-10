// Central "which tool (if any) does this message want" router, checked by
// request.js before the normal chat flow runs. Always uses native tool-
// calling (see llm-interfaces.js's streamOpenAICompatible/streamAnthropic/
// streamOllama, all of which support it -- Ollama natively since 2024) --
// there used to be a prompt-based-classifier fallback for a non-tool-
// capable Ollama model, removed after confirming empirically across every
// model actually used with this plugin that it was never once needed.
LLMIntent = {
	log(msg) {
		Zotero.debug("LLM Chat Pane [Intent]: " + msg);
	},

	// Every registered tool's own {name, description, schema} descriptor
	// (see tools/reference-retrieval.js's/tools/reference-linker.js's/
	// tools/table-export.js's own intentTool). Listed explicitly here,
	// rather than discovered automatically by scanning globals, so
	// registration is obvious at a glance and doesn't depend on
	// bootstrap.js's load order.
	_tools() {
		return [LLMReferenceRetrieval.intentTool, LLMReferenceLinker.intentTool, LLMTableExport.intentTool];
	},

	// Maps a tool's own API-level `name` (what the model actually sees)
	// back to the short key request.js switches on -- kept as a separate
	// lookup rather than baking request.js's own vocabulary into the tool
	// name itself.
	_toolKeys: {
		download_reference: "download",
		link_reference: "link",
		export_tables: "tables",
	},

	// Detects which tool (if any) `prompt` is asking for -- a single
	// streamModel call carrying every registered tool, letting the model
	// pick at most one itself. `prompt` is passed as a plain string (see
	// llm-interfaces.js's streamModel, which wraps it into a single
	// {role:"user"} entry with no history/system prompt) -- this is a one-
	// off, non-conversational classification call, not part of the visible
	// chat. onToken is a no-op -- never streamed to the visible chat, only
	// the final toolCalls matter. The model choosing to call NEITHER tool
	// (responding with plain text instead, or nothing) means this wasn't a
	// reference-tool request at all -- result.toolCalls is empty either
	// way, so no separate "none" check is needed for it.
	// `onProgress(msg)`, if given, is called once a call is actually made
	// -- surfaced by the caller (request.js) to the Logs panel (see
	// ui/logs.js), same convention tools/reference-retrieval.js's
	// downloadReferenceToLibrary already uses for its own progress
	// messages. Returns { tool: "download"|"link"|"tables", intent:
	// <six-shape intent object -- see request.js's _resolveIntentIndices
	// for how it's consumed, against whichever index (reference or table)
	// the matched tool operates on> } or null if no tool applies (a normal
	// chat message).
	async detectIntent(prompt, onProgress) {
		let result = await LLMInterfaces.streamModel(prompt, () => {}, { tools: this._tools() });
		let call = result.toolCalls?.[0];
		if (!call || !call.arguments) {
			onProgress?.("Intent detection: no tool called.");
			return null;
		}
		let toolKey = this._toolKeys[call.name];
		if (!toolKey) {
			this.log(`detectIntent: unrecognized tool "${call.name}"`);
			return null;
		}
		let intent = this._argumentsToIntent(call.arguments);
		if (!intent) return null;
		onProgress?.(`Intent detection: called "${call.name}".`);
		return { tool: toolKey, intent };
	},

	// Coerces a tool call's already-parsed `arguments` object (see
	// llm-interfaces.js's _finalizeToolCalls) into the six-shape intent
	// object request.js's _resolveIntentIndices consumes -- { type:
	// "single", index } | { type: "describe"|"select", description } |
	// { type: "list", indices } | { type: "range", from, to } |
	// { type: "all" }. Validates rather than trusting the model's
	// arguments blindly (a required field coming back missing/wrong-typed
	// despite the schema is exactly the kind of thing a model can still get
	// wrong) -- returns null on anything that doesn't cleanly fit one of
	// the six shapes.
	_argumentsToIntent(args) {
		let { type, index, description, indices, from, to } = args;
		if (type === "single" && Number.isInteger(index)) return { type, index };
		if ((type === "describe" || type === "select") && typeof description === "string" && description) {
			return { type, description };
		}
		if (type === "list" && Array.isArray(indices)) {
			let cleaned = indices.filter(Number.isInteger);
			return cleaned.length ? { type, indices: cleaned } : null;
		}
		if (type === "range" && Number.isInteger(from) && Number.isInteger(to)) return { type, from, to };
		if (type === "all") return { type: "all" };
		return null;
	},
};
