// Reads a conversation previously written by export.js's LLMExport back into
// [{ role, time, text }] entries, for repopulating ui/chat.js's message list
// (see llm-chat-pane.js's onImport, which also rebuilds table/figure/
// reference/equation links for each imported message using the active PDF's
// cached extraction indexes, and passes `time` back into
// chat.appendMessage() to preserve the original timestamp instead of
// stamping the import moment). Split out as its own top-level module (not
// ui/), mirroring export.js -- the file-picker interaction + markdown
// parsing is a self-contained feature, not UI construction.
LLMImport = {
	log(msg) {
		Zotero.debug("LLM Chat Pane [Import]: " + msg);
	},

	// $HOME/Zotero/LLMz/chats/ itself, with no per-PDF subfolder -- used
	// only as a fallback in _createFilePicker when there's no active PDF to
	// scope the default directory to (import isn't tied to "the current
	// paper" the way export is; the user can browse to any PDF's folder, or
	// anywhere else, from here regardless).
	async _defaultDir() {
		let dir = PathUtils.join(Zotero.DataDirectory.dir, "LLMz", "chats");
		await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
		return dir;
	},

	// An nsIFilePicker in the given mode, filtered to *.md, defaulting to
	// $HOME/Zotero/LLMz/chats/<item key>/ (see LLMConversationHistory.
	// conversationDir) if `item` (the active PDF attachment) is given, or
	// plain $HOME/Zotero/LLMz/chats/ (see _defaultDir) otherwise. Mirrors
	// export.js's LLMExport._createFilePicker -- kept as each module's own
	// copy rather than shared, same rationale as e.g. document/tables.js and
	// document/figures.js each having their own log()/cacheDir().
	async _createFilePicker(title, mode, item) {
		let win = Zotero.getMainWindow();
		let fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
		// nsIFilePicker.init() takes a BrowsingContext, not the window itself,
		// as of the Gecko version Zotero 7 is built on -- passing `win`
		// directly throws "Could not convert JavaScript argument arg 0
		// nsIFilePicker.init".
		fp.init(win.browsingContext, title, mode);
		fp.appendFilter("Markdown", "*.md");
		try {
			let dirFile = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
			dirFile.initWithPath(item ? await LLMConversationHistory.conversationDir(item) : await this._defaultDir());
			fp.displayDirectory = dirFile;
		}
		catch (e) {
			this.log(`Failed to set default directory: ${e.message}`);
		}
		return fp;
	},

	// Inverse of LLMExport.buildMarkdown's "## Conversation" block: finds
	// that heading, takes everything after it, and splits on standalone
	// "---" lines into individual "**Role | dd/mm/yyyy - hh:mm:ss:**\n\n<text>"
	// blocks -- tolerant of extra/missing blank lines around the separator
	// (e.g. from manual edits to the file), but otherwise expects the same
	// basic shape buildMarkdown produces. Falls back to the older
	// "**Role:**" heading (no timestamp) for files exported before
	// timestamps were added, leaving `time` empty in that case -- see
	// llm-chat-pane.js's onImport, which substitutes the current time when
	// `time` comes back empty. Any block that doesn't match either shape is
	// skipped (and logged), rather than aborting the whole import over one
	// bad block.
	parseConversation(markdown) {
		let marker = "## Conversation";
		let index = markdown.indexOf(marker);
		if (index === -1) {
			throw new Error('No "## Conversation" section found -- is this an exported conversation file?');
		}
		let body = markdown.slice(index + marker.length).trim();
		if (!body) return [];

		let blocks = body.split(/\n\s*---\s*\n/).map(b => b.trim()).filter(Boolean);
		let transcript = [];
		for (let block of blocks) {
			let match = block.match(/^\*\*(.+?)\s*\|\s*(.+?):\*\*\s*\n+([\s\S]*)$/);
			if (match) {
				let [, role, time, text] = match;
				transcript.push({ role: role.trim(), time: time.trim(), text: text.trim() });
				continue;
			}
			match = block.match(/^\*\*(.+?):\*\*\s*\n+([\s\S]*)$/);
			if (match) {
				let [, role, text] = match;
				transcript.push({ role: role.trim(), time: "", text: text.trim() });
				continue;
			}
			this.log(`Skipping unparseable block during import: ${block.slice(0, 80)}`);
		}
		return transcript;
	},

	// Shows a native open dialog (defaulting to $HOME/Zotero/LLMz/chats/<item
	// key>/ if `item` -- the active PDF attachment -- is given, filtered to
	// *.md) and parses the selected file's conversation back out (see
	// parseConversation). Returns null if the user cancels, otherwise
	// [{ role, time, text }] (possibly empty, if the file's Conversation
	// section had no parseable messages).
	async importConversation(item) {
		let fp = await this._createFilePicker("Import Conversation", Ci.nsIFilePicker.modeOpen, item);

		let result = await new Promise(resolve => fp.open(resolve));
		if (result === Ci.nsIFilePicker.returnCancel) {
			return null;
		}

		let markdown = await IOUtils.readUTF8(fp.file.path);
		let transcript = this.parseConversation(markdown);
		this.log(`Imported ${transcript.length} message(s) from ${fp.file.path}`);
		return transcript;
	},
};
