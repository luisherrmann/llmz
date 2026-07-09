// Central "which tool (if any) does this message want" router, checked by
// request.js before the normal chat flow runs. Dispatches to whichever
// detection strategy the CURRENTLY SELECTED MODEL actually supports (see
// llm-interfaces.js's modelSupportsTools -- gated per-model, not per-
// provider, since this is really an Ollama-model-capability question, not
// a provider one; all of OpenAI/Anthropic/LiteLLM/LM Studio are assumed to
// support it unconditionally):
//   - Tool-capable models get ONE combined streamModel call carrying every
//     registered tool's own descriptor (see _tools below), letting the
//     model pick at most one tool itself (see llm-interfaces.js's
//     streamOpenAICompatible/streamAnthropic/streamOllama -- all three
//     support tools/-calling as of Ollama's native /api/chat since 2024).
//   - Everything else (an Ollama model with no "tools" capability per
//     /api/show) falls back to running each tool module's own prompt-based
//     classifier (detectDownloadIntent/detectLinkIntent) sequentially,
//     exactly as request.js used to do directly before this module
//     existed.
// Either path returns the exact same shape, so request.js never needs to
// know or care which one actually ran.
LLMIntent = {
	log(msg) {
		Zotero.debug("LLM Chat Pane [Intent]: " + msg);
	},

	// Every registered tool's own {name, description, schema} descriptor
	// (see tools/reference-retrieval.js's/tools/reference-linker.js's own
	// intentTool). Listed explicitly here, rather than discovered
	// automatically by scanning globals, so registration is obvious at a
	// glance and doesn't depend on bootstrap.js's load order.
	_tools() {
		return [LLMReferenceRetrieval.intentTool, LLMReferenceLinker.intentTool];
	},

	// Maps a tool's own API-level `name` (what the model actually sees)
	// back to the short key request.js switches on -- kept as a separate
	// lookup rather than baking request.js's own vocabulary into the tool
	// name itself.
	_toolKeys: {
		download_reference: "download",
		link_reference: "link",
	},

	// Detects which tool (if any) `prompt` is asking for. `model`, if given,
	// is the caller's already-resolved current model (see request.js's
	// send(), which fetches this via LLMInterfaces.getCurrentModel() for
	// the reply-bubble label anyway, right before this runs) -- passed
	// through rather than re-fetched here, so this doesn't cost a second
	// "list models" round-trip to the provider on every single message.
	// Falls back to fetching it itself if omitted. `onProgress(msg)`, if
	// given, is called once with which detection route was taken -- surfaced
	// by the caller (request.js) to the Logs panel (see ui/logs.js), same
	// convention tools/reference-retrieval.js's downloadReferenceToLibrary
	// already uses for its own progress messages. Returns
	// { tool: "download"|"link", intent: <six-shape intent object, see
	// LLMReferenceRetrieval._parseIntentResponse> } or null if neither tool
	// applies (a normal chat message).
	async detectIntent(prompt, model, onProgress) {
		if (model === undefined) {
			model = await LLMInterfaces.getCurrentModel().catch(() => null);
		}
		let supportsTools = false;
		try {
			supportsTools = await LLMInterfaces.modelSupportsTools(model);
		}
		catch (e) {
			this.log(`detectIntent: modelSupportsTools check failed, falling back to classifiers: ${e.message}`);
		}
		if (!supportsTools) {
			let msg = `Intent detection: using prompt-based classifiers (model "${model}" has no tool support).`;
			this.log(msg);
			onProgress?.(msg);
			return this._detectIntentViaClassifiers(prompt);
		}
		let msg = `Intent detection: using native tool-calling (model "${model}").`;
		this.log(msg);
		onProgress?.(msg);
		return this._detectIntentViaTools(prompt);
	},

	// The pre-tool-calling fallback path -- unchanged behavior from before
	// this module existed, just moved here: each tool's own classify call,
	// tried in turn, first one to match wins. Two model calls in the worst
	// case (a normal chat message, matching neither) instead of native tool-
	// calling's one, but this is the only option for a non-tool-capable
	// Ollama model.
	async _detectIntentViaClassifiers(prompt) {
		let downloadIntent = await LLMReferenceRetrieval.detectDownloadIntent(prompt);
		if (downloadIntent) return { tool: "download", intent: downloadIntent };
		let linkIntent = await LLMReferenceLinker.detectLinkIntent(prompt);
		if (linkIntent) return { tool: "link", intent: linkIntent };
		return null;
	},

	// Single streamModel call carrying every registered tool -- `prompt` is
	// passed as a plain string (see llm-interfaces.js's streamModel, which
	// wraps it into a single {role:"user"} entry with no history/system
	// prompt), matching how the classify-prompt path already calls the
	// model for this same one-off, non-conversational purpose. onToken is a
	// no-op -- this call is never streamed to the visible chat, only its
	// final toolCalls matter. The model choosing to call NEITHER tool
	// (responding with plain text instead, or nothing) is the native-
	// tool-calling equivalent of the classify-prompt path's "none" response
	// -- result.toolCalls is empty either way, so no separate check is
	// needed for it.
	async _detectIntentViaTools(prompt) {
		let result = await LLMInterfaces.streamModel(prompt, () => {}, { tools: this._tools() });
		let call = result.toolCalls?.[0];
		if (!call || !call.arguments) return null;
		let toolKey = this._toolKeys[call.name];
		if (!toolKey) {
			this.log(`_detectIntentViaTools: unrecognized tool "${call.name}"`);
			return null;
		}
		let intent = this._argumentsToIntent(call.arguments);
		if (!intent) return null;
		return { tool: toolKey, intent };
	},

	// Coerces a tool call's already-parsed `arguments` object (see
	// llm-interfaces.js's _finalizeToolCalls) into the exact same intent
	// shape LLMReferenceRetrieval._parseIntentResponse returns from the
	// classify-prompt path -- downstream resolution (request.js's
	// _resolveIntentIndices) only ever consumes this shape, regardless of
	// which path produced it. Validates rather than trusting the model's
	// arguments blindly (a required field coming back missing/wrong-typed
	// despite the schema is exactly the kind of thing a model can still get
	// wrong) -- returns null on anything that doesn't cleanly fit one of
	// the six shapes, same as _parseIntentResponse's own unparseable-
	// response case.
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
