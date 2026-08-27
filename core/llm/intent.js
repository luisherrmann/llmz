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
		{ key: "listElements", tool: LLMListElements.intentTool },
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

	// Whether this tool opts OUT of the index-pipeline pass llm/request.js
	// runs before dispatching (see its own comment there, and
	// llm/index-pipeline.js's ensureIndexed). Default false.
	skipsIndexing(key) {
		return !!this._registry.find(r => r.key === key)?.tool.skipIndexing;
	},

	// Returns the resolver bundle (see each intentTool's own `resolver`)
	// for the tool llm/request.js is currently handling, keyed by the same
	// short key detectIntent returns as `tool`.
	getResolver(key) {
		return this._registry.find(r => r.key === key)?.tool.resolver ?? null;
	},

	// Detects which tool (if any) `prompt` is asking for -- a single
	// streamModel call carrying every registered tool, letting the model
	// pick at most one itself. Still not part of the visible chat (onToken
	// is a no-op below, and this never carries the full useMessageHistory
	// window llm/prompt.js's own systemPrompt/chat flow does) -- but no
	// longer BLIND to the conversation either, see `recentHistory` below.
	// The model choosing to call NEITHER tool (responding with plain text
	// instead, or nothing) means this wasn't a reference-tool request at
	// all -- result.toolCalls is empty either way, so no separate "none"
	// check is needed for it.
	// `onProgress(msg)`, if given, is called once a call is actually made
	// -- surfaced by the caller (llm/request.js) to the Logs panel (see
	// ui/logs.js), same convention tools/reference-retrieval.js's
	// downloadReferenceToLibrary already uses for its own progress
	// messages.
	// `recentHistory` -- a short slice of the conversation's own recent
	// turns (see llm/request.js's own priorTranscript, mirroring
	// LLMRequest._RECENT_HISTORY_TURNS/its own comment on why
	// deliberately narrow: just the single most recent exchange, not a
	// wider window that risks re-anchoring on an OLDER offer instead of
	// whatever's actually being affirmed) -- sent as real prior {role,
	// content} messages (not folded into `prompt` as text) plus a short
	// system-prompt instruction, so a bare "yes please"/"no thanks" reply
	// to something the model itself just proposed (e.g. "want me to export
	// Table 3 as CSV?") can still resolve to the right tool call, or
	// correctly resolve to none at all on a decline -- without this, such a
	// reply carries no table/reference identity of its own for ANY
	// registered tool to match against.
	// Returns { tool: "download"|"link"|"tables", intent: <six-shape intent
	// object -- see llm/request.js's _resolveIntentIndices for how it's
	// consumed, against whichever index (reference or table) the matched
	// tool operates on> } or null if no tool applies (a normal chat
	// message). A tool with its own toIntent returns its own shape.
	async detectIntent(prompt, onProgress, recentHistory = []) {
		let messages = recentHistory.map(({ role, text }) => ({ role: role === "You" ? "user" : "assistant", content: text }));
		messages.push({ role: "user", content: prompt });
		let systemPrompt = recentHistory.length
			? "You are deciding whether the user's latest message is requesting one of the tools available to you. If that message is a short reply (e.g. 'yes', 'yes please', 'sure', 'no thanks') affirming or declining something YOU proposed, offered, or asked about earlier in this conversation, resolve what is being affirmed/declined from your own last message before deciding whether a tool applies and what arguments to use -- e.g. if you asked 'want me to export Table 3 as CSV?' and the user replies 'yes please', call the export tool for Table 3. If the reply is a decline, do not call any tool."
			: undefined;
		let result = await LLMInterfaces.streamModel(messages, () => {}, { tools: this._tools(), systemPrompt });
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
		// Tools whose arguments aren't index-shaped supply their own
		// validator instead of using the shared six-shape one below (see
		// tools/list-elements.js's own toIntent).
		let entry = this._registry.find(r => r.key === toolKey);
		let intent = entry.tool.toIntent
			? entry.tool.toIntent(call.arguments)
			: this._argumentsToIntent(call.arguments);
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
	// instead). This validator is shared across the differently-shaped
	// `index` fields of every tool that HAS one, so it has to accept both
	// (listElements has none -- see its own toIntent).
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
