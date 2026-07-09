var LLMChatPane;
var LLMUIIcon;
var LLMUILogs;
var LLMUIChat;
var LLMUIProviderModelSelect;
var LLMUIImagePaste;
var LLMUIProviders;
var LLMUIKeyboardShortcuts;
var LLMUIAdvanced;
var LLMUIButtonRow;
var LLMRequest;
var LLMExport;
var LLMImport;
var LLMConversationHistory;
var LLMUIConversationHistory;
var LLMCitation;
var LLMFigures;
var LLMTables;
var LLMReferences;
var LLMEquations;
var LLMNotes;
var LLMReferenceRetrieval;
var LLMInterfaces;
var LLMPrompt;

function log(msg) {
	Zotero.debug("LLM Chat Pane: " + msg);
}

function install() {}

function uninstall() {}

async function startup({ id, version, rootURI }) {
	log("Starting 2.0");
	Services.scriptloader.loadSubScript(rootURI + "vendor/marked.min.js");
	Services.scriptloader.loadSubScript(rootURI + "vendor/highlight.min.js");
	Services.scriptloader.loadSubScript(rootURI + "vendor/katex.min.js");
	Services.scriptloader.loadSubScript(rootURI + "llm-citation.js");
	Services.scriptloader.loadSubScript(rootURI + "document/figures.js");
	Services.scriptloader.loadSubScript(rootURI + "document/tables.js");
	Services.scriptloader.loadSubScript(rootURI + "document/references.js");
	Services.scriptloader.loadSubScript(rootURI + "document/equations.js");
	Services.scriptloader.loadSubScript(rootURI + "document/notes.js");
	Services.scriptloader.loadSubScript(rootURI + "reference-retrieval.js");
	Services.scriptloader.loadSubScript(rootURI + "llm-interfaces.js");
	Services.scriptloader.loadSubScript(rootURI + "llm-prompt.js");
	Services.scriptloader.loadSubScript(rootURI + "ui/icon.js");
	Services.scriptloader.loadSubScript(rootURI + "ui/logs.js");
	Services.scriptloader.loadSubScript(rootURI + "ui/chat.js");
	Services.scriptloader.loadSubScript(rootURI + "ui/provider-model-select.js");
	Services.scriptloader.loadSubScript(rootURI + "ui/image-paste.js");
	Services.scriptloader.loadSubScript(rootURI + "ui/providers.js");
	Services.scriptloader.loadSubScript(rootURI + "ui/keyboard-shortcuts.js");
	Services.scriptloader.loadSubScript(rootURI + "ui/advanced.js");
	Services.scriptloader.loadSubScript(rootURI + "conversation-history.js");
	Services.scriptloader.loadSubScript(rootURI + "export.js");
	Services.scriptloader.loadSubScript(rootURI + "import.js");
	Services.scriptloader.loadSubScript(rootURI + "ui/past-conversations.js");
	Services.scriptloader.loadSubScript(rootURI + "ui/button-row.js");
	Services.scriptloader.loadSubScript(rootURI + "request.js");
	Services.scriptloader.loadSubScript(rootURI + "llm-chat-pane.js");
	await LLMReferences.init(rootURI);
	LLMChatPane.init({ id, version, rootURI });
	LLMReferenceRetrieval.init(LLMInterfaces.streamModel.bind(LLMInterfaces));
	// Awaited before main() so any item-pane render that happens once main()
	// resolves already has decrypted keys in LLMInterfaces._apiKeys, rather
	// than momentarily rendering the API key fields empty.
	await LLMInterfaces.loadApiKeys();
	// Synchronous (plain Zotero.Prefs, no keychain decrypt needed) -- must
	// still run before main() renders the provider/model dropdowns, which
	// read _provider/_selectedModel directly.
	LLMInterfaces.loadSelection();
	// Also synchronous/plain-Prefs -- must run before main() renders the
	// Providers panel (ui/providers.js), which reads _serverSettings
	// directly to pre-fill the Server IP/Port fields.
	LLMInterfaces.loadServerSettings();
	LLMChatPane.addToAllWindows();
	await LLMChatPane.main();
}

function onMainWindowLoad({ window }) {
	LLMChatPane.addToWindow(window);
}

function onMainWindowUnload({ window }) {
	LLMChatPane.removeFromWindow(window);
}

function shutdown() {
	log("Shutting down 2.0");
	LLMChatPane?.shutdown();
	LLMChatPane = undefined;
}
