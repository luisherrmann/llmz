var LLMChatPane;
var LLMCitation;
var LLMFigures;
var LLMTables;

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
	Services.scriptloader.loadSubScript(rootURI + "llm-figures.js");
	Services.scriptloader.loadSubScript(rootURI + "llm-tables.js");
	Services.scriptloader.loadSubScript(rootURI + "llm-chat-pane.js");
	LLMChatPane.init({ id, version, rootURI });
	await LLMChatPane.main();
}

function shutdown() {
	log("Shutting down 2.0");
	LLMChatPane?.shutdown();
	LLMChatPane = undefined;
}
