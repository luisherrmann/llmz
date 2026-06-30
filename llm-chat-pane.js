LLMChatPane = {
	id: null,
	version: null,
	rootURI: null,
	initialized: false,
	paneID: null,

	init({ id, version, rootURI }) {
		if (this.initialized) return;
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
		this.initialized = true;
	},

	log(msg) {
		Zotero.debug("LLM Chat Pane: " + msg);
	},

	async main() {
		this.registerItemPane();
		this.log("Hello World pane loaded");
	},

	registerItemPane() {
		if (this.paneID) return;
		this.paneID = Zotero.ItemPaneManager.registerSection({
			paneID: "llm-chat-pane",
			pluginID: this.id,
			header: {
				l10nID: "llm-chat-pane-header",
				icon: "chrome://zotero/skin/16/universal/note.svg",
			},
			sidenav: {
				l10nID: "llm-chat-pane-sidenav",
				icon: "chrome://zotero/skin/20/universal/note.svg",
				orderable: true,
			},
			onItemChange: ({ item, setEnabled }) => {
				setEnabled(!!item);
			},
			onRender: ({ doc, body }) => {
				body.replaceChildren();
				let container = doc.createElement("div");
				container.style.display = "flex";
				container.style.flexDirection = "column";
				container.style.gap = "8px";
				container.style.padding = "8px 0";

				let greeting = doc.createElement("div");
				greeting.textContent = "Hello World!";

				let input = doc.createElement("textarea");
				input.rows = 4;
				input.placeholder = "Type here...";
				input.style.boxSizing = "border-box";
				input.style.width = "100%";
				input.style.resize = "vertical";

				container.append(greeting, input);
				body.appendChild(container);
			},
		});
	},

	shutdown() {
		if (this.paneID) {
			Zotero.ItemPaneManager.unregisterSection(this.paneID);
			this.paneID = null;
		}
	},
};
