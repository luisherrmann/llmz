// The collapsible "Keyboard Shortcuts" reference panel -- purely
// informational (no hover/focus/click affordances), same disclosure pattern
// as ui/advanced.js/ui/providers.js. Split out of llm-chat-pane.js's onRender
// for the same reason as the other ui/ modules.
LLMUIKeyboardShortcuts = {
	_shortcuts: [
		{ keys: "⌘ ⇧ ⏎", desc: "Submit" },
		{ keys: "⌘ ⇧ ⌫", desc: "Stop" },
		{ keys: "⌘ ↓", desc: "Older message" },
		{ keys: "⌘ ↑", desc: "Newer message" },
		{ keys: "⌘ ⇧ ↓", desc: "Oldest message" },
		{ keys: "⌘ ⇧ ↑", desc: "Newest message" },
		{ keys: "⌘ I", desc: "Toggle chat pane" },
		{ keys: "⌘ V", desc: "Paste Image" },
	],

	create(doc) {
		let details = doc.createElement("details");
		details.className = "llm-shortcuts-details";
		let summary = doc.createElement("summary");
		summary.textContent = "Keyboard Shortcuts";
		let body = doc.createElement("div");
		body.className = "llm-collapsible-body llm-shortcuts-body";

		// A real <table>, same as ui/providers.js/ui/advanced.js -- so the
		// description column lines up at the same position for every row
		// regardless of how wide a given key-combo badge is.
		let table = doc.createElement("table");
		table.className = "llm-shortcuts-table";
		let tbody = doc.createElement("tbody");

		// Sorted by (keys.length, keys) -- shorter combos first, then
		// ascending lexicographically (by the shortcut itself, not the
		// description) within each length. Plain `<`/`>` rather than
		// localeCompare(), since locale-aware collation could reorder these
		// symbol characters unpredictably instead of by simple code-point
		// order.
		let sorted = [...this._shortcuts].sort((a, b) => a.keys.length - b.keys.length || (a.keys < b.keys ? -1 : a.keys > b.keys ? 1 : 0));
		for (let { keys, desc } of sorted) {
			let tr = doc.createElement("tr");
			let descTd = doc.createElement("td");
			descTd.className = "llm-shortcut-desc";
			descTd.textContent = desc;
			let badgeTd = doc.createElement("td");
			badgeTd.className = "llm-shortcut-badge-cell";
			let badge = doc.createElement("span");
			badge.className = "llm-shortcut-badge";
			badge.textContent = keys;
			badgeTd.appendChild(badge);
			// Description first (left column), key-combo badge second (right
			// column) -- matches the reading order of "what it does, then
			// how to trigger it".
			tr.append(descTd, badgeTd);
			tbody.appendChild(tr);
		}
		table.appendChild(tbody);
		body.appendChild(table);

		details.append(summary, body);
		return { element: details };
	},
};
