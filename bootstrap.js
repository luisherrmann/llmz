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
var LLMEmbeddings;
var LLMCitation;
var LLMSemanticHistory;
var LLMFigures;
var LLMTables;
var LLMReferences;
var LLMEquations;
var LLMNotes;
var LLMCitationPosition;
var LLMReferenceRetrieval;
var LLMReferenceLinker;
var LLMTableExport;
var LLMInterfaces;
var LLMIntent;
var LLMPrompt;
var LLMPythonSetup;

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
	// LLMCitation's own embedding methods (getEmbedding/embedBatched/
	// cosineSimilarity/getEmbeddingModel) just delegate to LLMEmbeddings --
	// must load before it.
	Services.scriptloader.loadSubScript(rootURI + "core/llm/embeddings.js");
	Services.scriptloader.loadSubScript(rootURI + "core/citation.js");
	// Depends on LLMCitation's own embedding API (getEmbedding/embedBatched/
	// cosineSimilarity) -- must load after it.
	Services.scriptloader.loadSubScript(rootURI + "core/semantic-history.js");
	Services.scriptloader.loadSubScript(rootURI + "core/document/figures.js");
	Services.scriptloader.loadSubScript(rootURI + "core/document/tables.js");
	Services.scriptloader.loadSubScript(rootURI + "core/document/references.js");
	Services.scriptloader.loadSubScript(rootURI + "core/document/structure_sdt.js");
	Services.scriptloader.loadSubScript(rootURI + "core/document/equations.js");
	Services.scriptloader.loadSubScript(rootURI + "core/document/notes.js");
	Services.scriptloader.loadSubScript(rootURI + "core/document/citations.js");
	Services.scriptloader.loadSubScript(rootURI + "core/python-setup.js");
	Services.scriptloader.loadSubScript(rootURI + "tools/reference-retrieval.js");
	Services.scriptloader.loadSubScript(rootURI + "tools/reference-linker.js");
	Services.scriptloader.loadSubScript(rootURI + "tools/table-export.js");
	Services.scriptloader.loadSubScript(rootURI + "core/llm/interfaces.js");
	Services.scriptloader.loadSubScript(rootURI + "core/llm/intent.js");
	Services.scriptloader.loadSubScript(rootURI + "core/llm/prompt.js");
	Services.scriptloader.loadSubScript(rootURI + "core/ui/icon.js");
	Services.scriptloader.loadSubScript(rootURI + "core/ui/logs.js");
	Services.scriptloader.loadSubScript(rootURI + "core/ui/chat.js");
	Services.scriptloader.loadSubScript(rootURI + "core/ui/provider-model-select.js");
	Services.scriptloader.loadSubScript(rootURI + "core/ui/image-paste.js");
	Services.scriptloader.loadSubScript(rootURI + "core/ui/providers.js");
	Services.scriptloader.loadSubScript(rootURI + "core/ui/keyboard-shortcuts.js");
	Services.scriptloader.loadSubScript(rootURI + "core/ui/advanced.js");
	Services.scriptloader.loadSubScript(rootURI + "core/conversation-history.js");
	Services.scriptloader.loadSubScript(rootURI + "core/export.js");
	Services.scriptloader.loadSubScript(rootURI + "core/import.js");
	Services.scriptloader.loadSubScript(rootURI + "core/ui/past-conversations.js");
	Services.scriptloader.loadSubScript(rootURI + "core/ui/button-row.js");
	Services.scriptloader.loadSubScript(rootURI + "core/llm/request.js");
	Services.scriptloader.loadSubScript(rootURI + "core/chat-pane.js");
	await LLMReferences.init(rootURI);
	LLMPythonSetup.init(rootURI);
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
	// Must run AFTER LLMInterfaces.loadSelection() (see its own comment) --
	// applies whichever advanced settings are saved for the now-loaded
	// provider/model pair before main() renders the Advanced panel, which
	// reads LLMPrompt's properties directly at row-creation time.
	LLMPrompt.loadAdvancedSettings();
	// Same as above, but for the separate Embeddings provider/model
	// dropdowns in ui/advanced.js -- must run before main() renders those.
	LLMInterfaces.loadEmbeddingSelection();
	// Must run AFTER LLMInterfaces.loadEmbeddingSelection() immediately
	// above (same reasoning as LLMPrompt.loadAdvancedSettings() above) --
	// applies whichever "Batch size" is saved for the now-loaded EMBEDDING
	// provider/model pair before main() renders the Embeddings section.
	LLMEmbeddings.loadAdvancedSettings();
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
