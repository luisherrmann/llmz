// The collapsible "Providers" panel: per-provider connection settings, one
// group per provider, showing only the fields that actually apply to it --
// an API key row for a cloud API or self-hosted proxy that needs auth
// (LiteLLM/OpenAI/Anthropic), and/or a Server IP + Port row for anything
// with a configurable local/self-hosted address (Ollama/LM Studio/LiteLLM).
// OpenAI/Anthropic are fixed cloud endpoints (openaiBaseURL/anthropicBaseURL
// in llm-interfaces.js), so they get no server fields; Ollama/LM Studio are
// unauthenticated local servers, so they get no API key field. Replaces the
// old "API Keys" panel now that the server address is also configurable,
// not just hardcoded.
//
// API keys are always editable here regardless of which provider is
// currently selected (so the user can pre-configure a provider before
// switching to it), and are persisted via LLMInterfaces.setApiKey()
// (OS-keychain-encrypted, survives restarts). Server IP/port are NOT
// secrets, so they're persisted via LLMInterfaces.saveServerSetting()
// instead (a plain Zotero.Prefs entry). Both are pre-filled from
// LLMInterfaces' current settings (which are themselves defaults unless
// previously overridden -- see loadServerSettings), so this panel always
// shows what's actually in effect, not blank fields. Split out of
// llm-chat-pane.js's onRender for the same reason as the other ui/ modules.
LLMUIProviders = {
	log(msg) {
		Zotero.debug("LLM Chat Pane [Providers]: " + msg);
	},

	_providers: [
		{ key: "ollama", label: "Ollama", apiKey: false, server: true },
		{ key: "lmstudio", label: "LM Studio", apiKey: false, server: true },
		{ key: "litellm", label: "LiteLLM", apiKey: true, server: true },
		{ key: "openai", label: "OpenAI", apiKey: true, server: false },
		{ key: "anthropic", label: "Anthropic", apiKey: true, server: false },
	],

	// Builds a <tr> for one field -- shared by all fields below so every
	// row within a provider's <table> lines up in the same two columns
	// (label, input), regardless of label length ("API Key" vs. "Port").
	_makeFieldRow(doc, labelText, inputEl) {
		let tr = doc.createElement("tr");
		let labelTd = doc.createElement("td");
		labelTd.className = "llm-provider-field-label";
		labelTd.textContent = labelText;
		let inputTd = doc.createElement("td");
		inputTd.className = "llm-provider-field-input";
		inputTd.appendChild(inputEl);
		tr.append(labelTd, inputTd);
		return tr;
	},

	// Builds the Providers panel. `onError(label, message)` is called if
	// persisting an API key fails (e.g. OS keychain access denied) --
	// surfacing that (e.g. to the Logs panel) is the caller's concern, not
	// this module's.
	create(doc, onError) {
		let details = doc.createElement("details");
		details.className = "llm-providers-details";
		let summary = doc.createElement("summary");
		summary.textContent = "Providers";
		let body = doc.createElement("div");
		body.className = "llm-providers-body";

		for (let { key, label, apiKey, server } of this._providers) {
			let group = doc.createElement("div");
			group.className = "llm-provider-group";
			let groupLabel = doc.createElement("div");
			groupLabel.className = "llm-provider-group-label";
			groupLabel.textContent = label;
			group.append(groupLabel);

			// One <table> per provider (not one shared across all of them)
			// -- each provider has its own field set, so there's no shared
			// column to align across groups anyway, only within one.
			let table = doc.createElement("table");
			table.className = "llm-provider-table";
			let tbody = doc.createElement("tbody");

			if (apiKey) {
				let keyInput = doc.createElement("input");
				keyInput.type = "password";
				keyInput.className = "llm-provider-input";
				keyInput.placeholder = "API key";
				keyInput.value = LLMInterfaces._apiKeys[key] || "";
				keyInput.addEventListener("change", async () => {
					try {
						await LLMInterfaces.setApiKey(key, keyInput.value);
					}
					catch (e) {
						this.log(`Failed to save ${label} API key: ${e.message}`);
						onError?.(label, e.message);
					}
				});
				tbody.append(this._makeFieldRow(doc, "API Key", keyInput));
			}

			if (server) {
				let settings = LLMInterfaces._serverSettings[key];

				let hostInput = doc.createElement("input");
				hostInput.type = "text";
				hostInput.className = "llm-provider-input";
				hostInput.value = settings.host;
				hostInput.addEventListener("change", () => {
					let value = hostInput.value.trim();
					if (value) LLMInterfaces.saveServerSetting(key, "host", value);
					// Re-reads from LLMInterfaces rather than trusting
					// `value` directly, so an empty/whitespace-only entry
					// visibly reverts to whatever's actually in effect
					// instead of leaving the field showing something that
					// was silently rejected.
					hostInput.value = LLMInterfaces._serverSettings[key].host;
				});
				tbody.append(this._makeFieldRow(doc, "Server IP", hostInput));

				let portInput = doc.createElement("input");
				portInput.type = "number";
				portInput.className = "llm-provider-input";
				portInput.min = "1";
				portInput.step = "1";
				portInput.value = settings.port;
				portInput.addEventListener("change", () => {
					let value = parseInt(portInput.value, 10);
					if (Number.isInteger(value) && value > 0) {
						LLMInterfaces.saveServerSetting(key, "port", value);
					}
					portInput.value = LLMInterfaces._serverSettings[key].port;
				});
				tbody.append(this._makeFieldRow(doc, "Port", portInput));
			}

			table.appendChild(tbody);
			group.appendChild(table);
			body.append(group);
		}

		details.append(summary, body);
		return { element: details };
	},
};
