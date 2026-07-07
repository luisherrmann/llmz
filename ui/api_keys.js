// The collapsible "API Keys" panel. Keys are always editable here regardless
// of which provider is currently selected (so the user can pre-configure a
// provider before switching to it), and are persisted via
// LLMInterfaces.setApiKey() (OS-keychain-encrypted, survives restarts) so
// they don't need to be re-entered every session. Split out of
// llm-chat-pane.js's onRender for the same reason as the other ui/ modules.
LLMUIApiKeys = {
	log(msg) {
		Zotero.debug("LLM Chat Pane [ApiKeys]: " + msg);
	},

	_fields: [
		{ providerKey: "litellm", label: "LiteLLM" },
		{ providerKey: "openai", label: "OpenAI" },
		{ providerKey: "anthropic", label: "Anthropic" },
	],

	// Builds the API Keys panel. `onError(label, message)` is called if
	// persisting a key fails (e.g. OS keychain access denied) -- surfacing
	// that (e.g. to the Logs panel) is the caller's concern, not this
	// module's.
	create(doc, onError) {
		let details = doc.createElement("details");
		details.className = "llm-api-keys-details";
		let summary = doc.createElement("summary");
		summary.textContent = "API Keys";
		let body = doc.createElement("div");
		body.className = "llm-api-keys-body";
		for (let { providerKey, label } of this._fields) {
			let row = doc.createElement("label");
			row.className = "llm-api-key-row";
			let span = doc.createElement("span");
			span.textContent = label;
			let keyInput = doc.createElement("input");
			keyInput.type = "password";
			keyInput.className = "llm-api-key-input";
			keyInput.placeholder = "API key";
			keyInput.value = LLMInterfaces._apiKeys[providerKey];
			keyInput.addEventListener("change", async () => {
				try {
					await LLMInterfaces.setApiKey(providerKey, keyInput.value);
				}
				catch (e) {
					this.log(`Failed to save ${label} API key: ${e.message}`);
					onError?.(label, e.message);
				}
			});
			row.append(span, keyInput);
			body.appendChild(row);
		}
		details.append(summary, body);
		return { element: details };
	},
};
