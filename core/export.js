// Exports the current conversation (the visible user/LLM message list from
// ui/chat.js -- NOT the separate Logs panel, which is debug/status output,
// not part of "the conversation") as a Markdown file: the paper's title as
// an H1, an "Info" section with every non-empty bibliographic field Zotero's
// own Info pane would show for it (Authors, plus whatever else applies to
// that item type -- Publication, DOI, Repository, etc.), an "Abstract"
// section if one exists, then "Conversation" with each message as
// "**Role:**" followed by its text, separated by "---". The reverse
// (reading a file back into messages) is import.js's LLMImport, which reads
// the same "## Conversation" format this module writes. Split out as its
// own top-level module (not ui/) since the markdown building + filesystem/
// file-picker interaction is a self-contained feature, not UI construction
// -- same rationale as llm/request.js.
LLMExport = {
	log(msg) {
		Zotero.debug("LLM Chat Pane [Export]: " + msg);
	},

	// ddmmyy, local time, zero-padded, no separators -- matches the
	// "<ddmmyy>_<NNN>.md" default filename format (see exportConversation).
	_formatDateDDMMYY() {
		let d = new Date();
		let pad = n => String(n).padStart(2, "0");
		return `${pad(d.getDate())}${pad(d.getMonth() + 1)}${String(d.getFullYear()).slice(-2)}`;
	},

	// Finds the next available zero-padded index for today's date within
	// the PDF's own conversation folder, so the default export filename
	// "<ddmmyy>_<NNN>.md" doesn't collide with an existing file from
	// earlier the same day -- scans for existing "<datePrefix>_NNN.md"
	// files and returns (highest existing index found) + 1, or 1 if none
	// exist yet. No item-key prefix needed in the filename itself (unlike
	// the old "<item key>_<ddmmyy>.md" format) since these files already
	// live under a per-PDF folder (see LLMConversationHistory.conversationDir)
	// -- the folder itself is what scopes them to this paper.
	async _nextIndexForToday(dir, datePrefix) {
		let entries = [];
		try {
			entries = await IOUtils.getChildren(dir);
		}
		catch (e) {
			return 1;
		}
		let re = new RegExp(`^${datePrefix}_(\\d{3})\\.md$`, "i");
		let maxIndex = 0;
		for (let path of entries) {
			let match = PathUtils.filename(path).match(re);
			if (match) {
				maxIndex = Math.max(maxIndex, parseInt(match[1], 10));
			}
		}
		return maxIndex + 1;
	},

	_formatCreatorName(creator) {
		// Institutional/single-field creators (fieldMode 1, e.g. "World
		// Health Organization") come through as { name } instead of
		// { firstName, lastName } -- see Zotero.Creators.internalToJSON.
		if (creator.name) return creator.name;
		return [creator.firstName, creator.lastName].filter(Boolean).join(" ");
	},

	// Builds the "Info" section's lines: "Authors: ..." (every creator on
	// the item, regardless of creatorType -- author/editor/translator/etc.
	// -- collapsed into one field, rather than a separate row per role like
	// Zotero's own Info pane) followed by every OTHER field valid for this
	// item's type that actually has a value, in the same order Zotero's
	// Info pane shows them, using Zotero's own field labels. Title and
	// Abstract are skipped here since they get their own sections.
	_buildInfoLines(paperItem) {
		let lines = [];

		let names = paperItem.getCreatorsJSON().map(c => this._formatCreatorName(c)).filter(Boolean);
		if (names.length) {
			lines.push(`Authors: ${names.join(", ")}`);
		}

		for (let fieldID of Zotero.ItemFields.getItemTypeFields(paperItem.itemTypeID)) {
			let fieldName = Zotero.ItemFields.getName(fieldID);
			if (fieldName === "title" || fieldName === "abstractNote") continue;
			let value = paperItem.getField(fieldName);
			if (!value) continue;
			lines.push(`${Zotero.ItemFields.getLocalizedString(fieldID)}: ${value}`);
		}

		return lines;
	},

	// `transcript` is [{ role, time, text }], as returned by ui/chat.js's
	// exportTranscript() -- role is already human-readable ("You", the
	// provider label like "OpenAI - gpt-5.4", or "Zotero" for e.g.
	// download-reference results), and `time` is already formatted
	// "dd/mm/yyyy - hh:mm:ss", so both are used verbatim in each message's
	// "ROLE | time:" heading. import.js's parseConversation is this format's
	// inverse -- keep the two in sync if this ever changes.
	// Always regenerates the WHOLE document (including the METADATA block
	// -- see conversation-history.js) from the CURRENT transcript,
	// whether this is a brand new file or an overwrite of an existing one
	// -- so there's no separate "patch an existing file's METADATA" path to
	// keep in sync; ui/past-conversations.js's card list just reflects
	// whatever's actually on disk the next time it reads the folder.
	buildMarkdown(paperItem, transcript) {
		let title = paperItem.getField("title") || paperItem.libraryKey;
		let messageBlocks = transcript.map(({ role, time, text }) => `**${role} | ${time}:**\n\n${text}`);

		let sections = [`# ${title}`];

		let metadata = LLMConversationHistory.computeMetadata(transcript);
		sections.push(LLMConversationHistory.formatMetadataBlock(metadata));

		let infoLines = this._buildInfoLines(paperItem);
		if (infoLines.length) {
			sections.push(`## Info\n\n${infoLines.join("\n")}`);
		}

		let abstract = paperItem.getField("abstractNote");
		if (abstract) {
			sections.push(`## Abstract\n\n${abstract}`);
		}

		sections.push(`## Conversation\n\n${messageBlocks.join("\n\n---\n\n")}`);

		return sections.join("\n\n") + "\n";
	},

	// An nsIFilePicker in the given mode, filtered to *.md, defaulting to
	// $HOME/Zotero/LLMz/chats/<item key>/ (see LLMConversationHistory.
	// conversationDir) as its initial directory -- `item` is the PDF
	// ATTACHMENT, same as everywhere else in this file.
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
			dirFile.initWithPath(await LLMConversationHistory.conversationDir(item));
			fp.displayDirectory = dirFile;
		}
		catch (e) {
			this.log(`Failed to set default directory: ${e.message}`);
		}
		return fp;
	},

	// Shows a native save dialog (defaulting to $HOME/Zotero/LLMz/chats/<item
	// key>/<ddmmyy>_<NNN>.md, editable by the user) and writes the exported
	// markdown there. Returns { cancelled: true } if the user dismisses the
	// dialog without saving, or { cancelled: false, path } once written.
	async exportConversation(item, transcript) {
		if (!transcript.length) {
			throw new Error("Nothing to export -- the conversation is empty.");
		}
		// `item` is the PDF ATTACHMENT (see LLMChatPane.getActiveReaderAttachment),
		// whose own "title" field (and Info-pane fields generally) are usually
		// just generic translator-assigned values (e.g. title "Full Text PDF")
		// -- the actual paper metadata lives on its parent (regular) item.
		// Falls back to the attachment itself for a standalone PDF with no
		// parent.
		let paperItem = item.parentItem || item;
		let markdown = this.buildMarkdown(paperItem, transcript);

		let fp = await this._createFilePicker("Export Conversation", Ci.nsIFilePicker.modeSave, item);
		let datePrefix = this._formatDateDDMMYY();
		let dir = await LLMConversationHistory.conversationDir(item);
		let index = await this._nextIndexForToday(dir, datePrefix);
		fp.defaultString = `${datePrefix}_${String(index).padStart(3, "0")}.md`;
		fp.defaultExtension = "md";

		let result = await new Promise(resolve => fp.open(resolve));
		if (result === Ci.nsIFilePicker.returnCancel) {
			return { cancelled: true };
		}

		await IOUtils.writeUTF8(fp.file.path, markdown);
		this.log(`Exported conversation to ${fp.file.path}`);
		return { cancelled: false, path: fp.file.path };
	},
};
