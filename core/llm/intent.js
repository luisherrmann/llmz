// Central "which tool (if any) does this message want" router, checked by
// llm/request.js before the normal chat flow runs. Always uses native tool-
// calling (see llm/interfaces.js's streamOpenAICompatible/streamAnthropic/
// streamOllama, all of which support it -- Ollama natively since 2024) --
// there used to be a prompt-based-classifier fallback for a non-tool-
// capable Ollama model, removed after confirming empirically across every
// model actually used with this plugin that it was never once needed.
LLMIntent = {
	log(msg) {
		Zotero.debug("LLM Chat Pane [Intent]: " + msg);
	},

	// One entry per registered tool -- the short key llm/request.js switches on
	// (its own internal vocabulary), paired with that tool's own
	// {name, description, schema, resolver} descriptor (see
	// tools/reference-retrieval.js's/tools/reference-linker.js's/
	// tools/table-export.js's own intentTool -- `resolver` bundles the
	// four functions llm/request.js's _resolveIntentIndices needs to turn a
	// resolved intent into concrete numbers). THE single registry for
	// "what tools exist" -- llm/request.js used to keep its own second,
	// separate per-tool map (keyed by these same short keys) just for
	// resolvers, which had to be updated by hand in lockstep with this one
	// every time a tool was added; now llm/request.js reads resolvers from
	// here instead (see getResolver below), so there's exactly one place
	// to register a new tool. Listed explicitly here, rather than
	// discovered automatically by scanning globals, so registration is
	// obvious at a glance and doesn't depend on bootstrap.js's load order.
	_registry: [
		{ key: "download", tool: LLMReferenceRetrieval.intentTool },
		{ key: "link", tool: LLMReferenceLinker.intentTool },
		{ key: "tables", tool: LLMTableExport.intentTool },
	],

	// Every registered tool's own {name, description, schema} descriptor,
	// in the shape llm/interfaces.js's streamModel `opts.tools` expects
	// (resolver isn't part of the wire format -- only detectIntent/
	// getResolver below read it, streamModel never sees it).
	_tools() {
		return this._registry.map(r => r.tool);
	},

	// Maps a tool's own API-level `name` (what the model actually sees)
	// back to the short key llm/request.js switches on.
	_keyForName(name) {
		return this._registry.find(r => r.tool.name === name)?.key ?? null;
	},

	// Returns the resolver bundle (see each intentTool's own `resolver`)
	// for the tool llm/request.js is currently handling, keyed by the same
	// short key detectIntent returns as `tool`.
	getResolver(key) {
		return this._registry.find(r => r.key === key)?.tool.resolver ?? null;
	},

	// Detects which tool (if any) `prompt` is asking for -- a single
	// streamModel call carrying every registered tool, letting the model
	// pick at most one itself. `prompt` is passed as a plain string (see
	// llm/interfaces.js's streamModel, which wraps it into a single
	// {role:"user"} entry with no history/system prompt) -- this is a one-
	// off, non-conversational classification call, not part of the visible
	// chat. onToken is a no-op -- never streamed to the visible chat, only
	// the final toolCalls matter. The model choosing to call NEITHER tool
	// (responding with plain text instead, or nothing) means this wasn't a
	// reference-tool request at all -- result.toolCalls is empty either
	// way, so no separate "none" check is needed for it.
	// `onProgress(msg)`, if given, is called once a call is actually made
	// -- surfaced by the caller (llm/request.js) to the Logs panel (see
	// ui/logs.js), same convention tools/reference-retrieval.js's
	// downloadReferenceToLibrary already uses for its own progress
	// messages. Returns { tool: "download"|"link"|"tables", intent:
	// <six-shape intent object -- see llm/request.js's _resolveIntentIndices
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
		let toolKey = this._keyForName(call.name);
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
	// llm/interfaces.js's _finalizeToolCalls) into the six-shape intent
	// object llm/request.js's _resolveIntentIndices consumes -- { type:
	// "single", index } | { type: "describe"|"select", description } |
	// { type: "list", indices } | { type: "range", from, to } |
	// { type: "all" }. Validates rather than trusting the model's
	// arguments blindly (a required field coming back missing/wrong-typed
	// despite the schema is exactly the kind of thing a model can still get
	// wrong) -- returns null on anything that doesn't cleanly fit one of
	// the six shapes.
	//
	// `index`/`indices` accept EITHER an integer (download/link -- a
	// reference is always plainly numbered, and the user can name it
	// directly, e.g. "download reference 5", so intent-detection alone can
	// extract the real number with no further lookup, see tools/reference-
	// retrieval.js's schema) OR a non-empty string (tables -- the user
	// names a table by whatever label THEY know it by, e.g. "D.2", but the
	// model has no access to this paper's actual table list at intent-
	// detection time to convert that into the table's real `table_id`; see
	// tools/table-export.js's schema/resolver.single/resolver.list, which
	// resolve the raw string against the real listing in a SECOND call
	// instead). This validator is shared across all three tools'
	// differently-shaped `index` fields, so it has to accept both.
	_isValidIndexToken(v) {
		return Number.isInteger(v) || (typeof v === "string" && v.length > 0);
	},

	_argumentsToIntent(args) {
		let { type, index, description, indices, from, to } = args;
		if (type === "single" && this._isValidIndexToken(index)) return { type, index };
		if ((type === "describe" || type === "select") && typeof description === "string" && description) {
			return { type, description };
		}
		if (type === "list" && Array.isArray(indices)) {
			let cleaned = indices.filter(v => this._isValidIndexToken(v));
			return cleaned.length ? { type, indices: cleaned } : null;
		}
		if (type === "range" && Number.isInteger(from) && Number.isInteger(to)) return { type, from, to };
		if (type === "all") return { type: "all" };
		return null;
	},
};
