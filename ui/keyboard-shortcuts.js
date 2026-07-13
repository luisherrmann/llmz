// The collapsible "Keyboard Shortcuts" reference panel -- purely
// informational (no hover/focus/click affordances), same disclosure pattern
// as ui/advanced.js/ui/providers.js. Split out of llm-chat-pane.js's onRender
// for the same reason as the other ui/ modules.
LLMUIKeyboardShortcuts = {
	// ⌃/⌘ (Ctrl-or-Cmd) is both accepted, on every platform (not just the
	// OS-conventional one) -- see llm-chat-pane.js's addToWindow/onRender
	// keydown handlers, which check `event.metaKey || event.ctrlKey` for
	// every one of these rather than picking one based on Zotero.isMac.
	// "Paste Image" is the one exception: it's not a custom keydown handler
	// at all, just a native `paste` DOM event listener (ui/image-paste.js),
	// which the OS already dispatches for whichever its own real paste
	// shortcut is (CMD+V on Mac, CTRL+V elsewhere) -- so it was always
	// cross-platform without any code here needing to change, and is only
	// listed the same way as the rest for a consistent reference table.
	//
	// `keys` is an array of "parts" pressed together (rendered joined by
	// "+", one badge per part -- see create() below), where a part is
	// either a single symbol or an array of ALTERNATIVE symbols (rendered
	// as ONE badge showing all alternatives joined by "/" -- e.g. ⌃/⌘ is a
	// single merged badge, not two separate ⌃ and ⌘ badges, since Ctrl and
	// Cmd are alternatives for the same modifier, not two keys pressed
	// together -- not hardcoded as a special case in the rendering code
	// below in case a future shortcut needs a different alternation).
	_shortcuts: [
		{ keys: [["⌃", "⌘"], "⇧", "⏎"], desc: "Submit" },
		{ keys: [["⌃", "⌘"], "⇧", "⌫"], desc: "Stop" },
		{ keys: [["⌃", "⌘"], "↓"], desc: "Older message" },
		{ keys: [["⌃", "⌘"], "↑"], desc: "Newer message" },
		{ keys: [["⌃", "⌘"], "⇧", "↓"], desc: "Oldest message" },
		{ keys: [["⌃", "⌘"], "⇧", "↑"], desc: "Newest message" },
		{ keys: [["⌃", "⌘"], "I"], desc: "Toggle chat pane" },
		{ keys: [["⌃", "⌘"], "V"], desc: "Paste Image" },
	],

	// Flattens a `keys` array (see _shortcuts' own comment) into a single
	// plain string, e.g. [["⌃","⌘"],"⇧","⏎"] -> "⌃/⌘+⇧+⏎" -- used both for
	// the badge cell's hover title (so the whole combo reads sensibly to a
	// screen reader or a tooltip, not as several disconnected badges) and
	// as the sort key in create() below.
	_flattenKeys(keys) {
		return keys.map(part => Array.isArray(part) ? part.join("/") : part).join("+");
	},

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

		// Sorted by (flattened-keys.length, flattened-keys) -- shorter combos
		// first, then ascending lexicographically (by the shortcut itself,
		// not the description) within each length -- same ordering as
		// before _flattenKeys existed, just computed from the structured
		// `keys` array now instead of a plain string. Plain `<`/`>` rather
		// than localeCompare(), since locale-aware collation could reorder
		// these symbol characters unpredictably instead of by simple
		// code-point order.
		let sorted = [...this._shortcuts].sort((a, b) => {
			let aFlat = this._flattenKeys(a.keys), bFlat = this._flattenKeys(b.keys);
			return aFlat.length - bFlat.length || (aFlat < bFlat ? -1 : aFlat > bFlat ? 1 : 0);
		});
		for (let { keys, desc } of sorted) {
			let tr = doc.createElement("tr");
			let descTd = doc.createElement("td");
			descTd.className = "llm-shortcut-desc";
			descTd.textContent = desc;
			let badgeTd = doc.createElement("td");
			badgeTd.className = "llm-shortcut-badge-cell";
			badgeTd.title = this._flattenKeys(keys);
			// One badge per part -- an alternatives part (e.g. ⌃/⌘) renders
			// as a SINGLE badge with its alternatives joined by "/" inside
			// it, not as several separate badges, since they're alternative
			// ways to press the same modifier, not distinct keys of the
			// combo. Parts themselves (e.g. the ⌃/⌘ badge vs ⇧ vs ⏎) are
			// separated by a plain "+" text node, matching _flattenKeys'
			// own separator.
			keys.forEach((part, i) => {
				if (i > 0) badgeTd.append(" + ");
				let badge = doc.createElement("span");
				badge.className = "llm-shortcut-badge";
				badge.textContent = Array.isArray(part) ? part.join("/") : part;
				badgeTd.appendChild(badge);
			});
			// Description first (left column), key-combo badges second
			// (right column) -- matches the reading order of "what it does,
			// then how to trigger it".
			tr.append(descTd, badgeTd);
			tbody.appendChild(tr);
		}
		table.appendChild(tbody);
		body.appendChild(table);

		details.append(summary, body);
		return { element: details };
	},
};
