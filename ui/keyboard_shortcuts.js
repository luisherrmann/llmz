// The collapsible "Keyboard Shortcuts" reference panel -- purely
// informational (no hover/focus/click affordances), same disclosure pattern
// as ui/advanced.js/ui/api_keys.js. Split out of llm-chat-pane.js's onRender
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
	],

	create(doc) {
		let details = doc.createElement("details");
		details.className = "llm-shortcuts-details";
		let summary = doc.createElement("summary");
		summary.textContent = "Keyboard Shortcuts";
		let body = doc.createElement("div");
		body.className = "llm-shortcuts-body";
		// Sorted by (keys.length, keys) -- shorter combos first, then
		// ascending lexicographically (by the shortcut itself, not the
		// description) within each length. Plain `<`/`>` rather than
		// localeCompare(), since locale-aware collation could reorder these
		// symbol characters unpredictably instead of by simple code-point
		// order.
		let sorted = [...this._shortcuts].sort((a, b) => a.keys.length - b.keys.length || (a.keys < b.keys ? -1 : a.keys > b.keys ? 1 : 0));
		for (let { keys, desc } of sorted) {
			let row = doc.createElement("div");
			row.className = "llm-shortcut-row";
			let badge = doc.createElement("span");
			badge.className = "llm-shortcut-badge";
			badge.textContent = keys;
			let label = doc.createElement("span");
			label.className = "llm-shortcut-desc";
			label.textContent = desc;
			row.append(badge, label);
			body.appendChild(row);
		}
		details.append(summary, body);
		return { element: details };
	},
};
