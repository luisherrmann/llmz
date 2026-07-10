// Reads/writes the "METADATA:" block each conversation .md file carries
// (see export.js's buildMarkdown, which embeds it directly under the title,
// before "## Info"), and lists every conversation stored for a given PDF
// under $HOME/Zotero/LLMz/chats/<PDF_ID>/ -- the data source for
// ui/past-conversations.js's card list. Lives at the plugin root (NOT
// under ui/, despite the near-identical filename that briefly lived there
// too) for the same reason export.js/import.js do: this is filesystem
// interaction + markdown parsing, not UI construction, so it isn't folded
// into ui/past-conversations.js or given an LLMUI-prefixed name like
// every actual ui/ module has.
//
// There's no separate persisted index/manifest of conversations -- the .md
// files themselves are the source of truth, and listConversations() below
// just re-reads the whole per-PDF folder fresh every time it's asked,
// matching how table/figure/equation/reference extraction caches already
// work elsewhere in this plugin (one file per unit, no separate manifest to
// keep in sync). This is also why "updating an existing file's METADATA on
// overwrite" needs no special patch-in-place logic: export.js's
// buildMarkdown always regenerates the ENTIRE document (including
// METADATA) fresh from the live in-memory transcript, whether writing a
// brand new file or overwriting an existing one, so the next
// listConversations() call picks up accurate values either way.
LLMConversationHistory = {
	log(msg) {
		Zotero.debug("LLM Chat Pane [Conversation History]: " + msg);
	},

	// $HOME/Zotero/LLMz/chats/<item key>/ -- `item` is the PDF ATTACHMENT
	// (the same key export.js's filenames already use), so each PDF's
	// conversations live in their own folder instead of one flat directory
	// shared by every paper.
	async conversationDir(item) {
		let dir = PathUtils.join(Zotero.DataDirectory.dir, "LLMz", "chats", item.key);
		await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
		return dir;
	},

	// dd/mm/yyyy - hh:mm:ss, local time, zero-padded -- matches ui/chat.js's
	// own message-timestamp format, reused here for METADATA's "Saved"
	// field so the two read the same way throughout the plugin.
	_formatTimestamp() {
		let d = new Date();
		let pad = n => String(n).padStart(2, "0");
		return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} - ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
	},

	// Up to this many words of the user's OWN LAST prompt (not the model's
	// replies, and not the FIRST prompt) -- see ui/chat.js's
	// exportTranscript, which returns messages in the order they were sent,
	// so the last entry with role "You" is whatever the user asked most
	// recently. Deliberately the last prompt rather than the first: the
	// opening prompt is often generic ("Explain this paper"), while the
	// most recent one is usually a much better indicator of what the
	// conversation actually ended up being about. Truncated with "…" if
	// the message itself runs longer.
	_PREVIEW_MAX_WORDS: 20,
	_preview(transcript) {
		let userMessages = transcript.filter(m => m.role === "You");
		let lastPrompt = userMessages[userMessages.length - 1]?.text || "";
		let words = lastPrompt.trim().split(/\s+/).filter(Boolean);
		if (!words.length) return "";
		let truncated = words.slice(0, this._PREVIEW_MAX_WORDS).join(" ");
		return words.length > this._PREVIEW_MAX_WORDS ? `${truncated}…` : truncated;
	},

	// Number of prompts BY THE USER, not total messages -- a reply doesn't
	// count as a separate "turn" the user themselves initiated.
	_conversationLength(transcript) {
		return transcript.filter(m => m.role === "You").length;
	},

	// The first message's own timestamp (already "dd/mm/yyyy - hh:mm:ss",
	// stamped when it was actually sent -- see ui/chat.js's appendMessage)
	// -- distinct from "Saved" (when the FILE was last written to disk,
	// i.e. export time), which is why both exist as separate METADATA
	// fields rather than one.
	_started(transcript) {
		return transcript[0]?.time || "";
	},

	// Computes the METADATA fields for a transcript at the moment it's
	// being saved -- see export.js's buildMarkdown, the only caller.
	computeMetadata(transcript) {
		return {
			preview: this._preview(transcript),
			started: this._started(transcript),
			saved: this._formatTimestamp(),
			length: this._conversationLength(transcript),
		};
	},

	// Renders the "METADATA:" block export.js's buildMarkdown inserts
	// directly under the title, before "## Info". Kept as a plain bullet
	// list (not a table) to match the rest of the exported document's
	// plain-Markdown style.
	formatMetadataBlock({ preview, started, saved, length }) {
		return [
			"METADATA:",
			`- Preview: ${preview}`,
			`- Started: ${started}`,
			`- Saved: ${saved}`,
			`- Conversation length: ${length}`,
		].join("\n");
	},

	// Inverse of formatMetadataBlock -- pulls the METADATA block's fields
	// out of a conversation file's raw markdown. Any field not found (an
	// older export from before METADATA existed, or a hand-edited file)
	// comes back as "UNKNOWN" rather than failing the whole parse -- same
	// per-field fallback whether the entire block is missing or just one
	// bullet within it.
	parseMetadataBlock(markdown) {
		let fields = { preview: "UNKNOWN", started: "UNKNOWN", saved: "UNKNOWN", length: "UNKNOWN" };
		// Plain substring search, not a `^...$`-anchored regex spanning
		// multiple lines -- with the `m` flag, `$` matches end-of-LINE, not
		// just end-of-string, so a non-greedy `[\s\S]*?` capture stops after
		// the very first bullet instead of the whole block (confirmed
		// concretely: this bug ate the Saved/Conversation length fields
		// during testing). Finding the block's boundaries with indexOf
		// first, then only using anchored regexes WITHIN that isolated
		// slice for each individual field, sidesteps the issue entirely.
		let marker = "METADATA:\n";
		let start = markdown.indexOf(marker);
		if (start === -1) return fields;
		let bodyStart = start + marker.length;
		let blankLineIndex = markdown.indexOf("\n\n", bodyStart);
		let block = blankLineIndex === -1 ? markdown.slice(bodyStart) : markdown.slice(bodyStart, blankLineIndex);
		let preview = block.match(/^-\s*Preview:\s*(.*)$/m);
		let started = block.match(/^-\s*Started:\s*(.*)$/m);
		let saved = block.match(/^-\s*Saved:\s*(.*)$/m);
		let length = block.match(/^-\s*Conversation length:\s*(.*)$/m);
		if (preview && preview[1].trim()) fields.preview = preview[1].trim();
		if (started && started[1].trim()) fields.started = started[1].trim();
		if (saved && saved[1].trim()) fields.saved = saved[1].trim();
		if (length && length[1].trim()) fields.length = length[1].trim();
		return fields;
	},

	// Parses a "Saved" field (the "dd/mm/yyyy - hh:mm:ss" format
	// _formatTimestamp produces) into a real epoch value for sorting --
	// plain string comparison would sort lexicographically wrong (day
	// first). Returns null for "UNKNOWN" or anything else unparseable.
	_parseSavedTimestamp(saved) {
		let m = saved.match(/^(\d{2})\/(\d{2})\/(\d{4}) - (\d{2}):(\d{2}):(\d{2})$/);
		if (!m) return null;
		let [, dd, mm, yyyy, hh, min, ss] = m;
		let time = new Date(`${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}`).getTime();
		return Number.isNaN(time) ? null : time;
	},

	// Lists every conversation currently saved for `item` (the PDF
	// attachment), newest-saved first (anything with an unparseable/missing
	// "Saved" field sorts last rather than throwing off the rest of the
	// ordering). Returns [{ filename, path, preview, started, saved, length }].
	async listConversations(item) {
		let dir = await this.conversationDir(item);
		let entries = [];
		try {
			entries = await IOUtils.getChildren(dir);
		}
		catch (e) {
			this.log(`listConversations: failed to read ${dir}: ${e.message}`);
			return [];
		}
		let conversations = [];
		for (let path of entries) {
			if (!path.endsWith(".md")) continue;
			try {
				let markdown = await IOUtils.readUTF8(path);
				let { preview, started, saved, length } = this.parseMetadataBlock(markdown);
				conversations.push({ filename: PathUtils.filename(path), path, preview, started, saved, length });
			}
			catch (e) {
				this.log(`listConversations: failed to read ${path}: ${e.message}`);
			}
		}
		conversations.sort((a, b) => {
			let da = this._parseSavedTimestamp(a.saved);
			let db = this._parseSavedTimestamp(b.saved);
			if (da === null && db === null) return 0;
			if (da === null) return 1;
			if (db === null) return -1;
			return db - da;
		});
		return conversations;
	},

	// Permanently removes a conversation file from disk -- used by
	// ui/past-conversations.js's Delete button. The caller is
	// responsible for updating whatever's displayed (removing the
	// corresponding card) -- this module has no UI to keep in sync itself.
	async deleteConversation(path) {
		await IOUtils.remove(path);
		this.log(`deleteConversation: removed ${path}`);
	},

	// Strips characters that aren't safe as a filename (path separators,
	// reserved Windows characters, etc.) from a user-typed title -- used by
	// renameConversation below before ever touching the filesystem, rather
	// than letting an unsanitized "/" or similar silently turn into a
	// nested path or a failed IOUtils.move.
	_sanitizeTitle(title) {
		return title.trim().replace(/[/\\:*?"<>|]/g, "_");
	},

	// Renames a conversation file to `<newTitle>.md`, in the same directory
	// the original file lives in -- used by ui/past-conversations.js's
	// inline title editor. Throws if `newTitle` sanitizes down to nothing,
	// or if a file with that name already exists (deliberately NOT
	// overwritten -- IOUtils.move's default behavior -- so renaming one
	// conversation can never silently clobber another). Returns the new
	// path.
	async renameConversation(path, newTitle) {
		let sanitized = this._sanitizeTitle(newTitle);
		if (!sanitized) {
			throw new Error("Title can't be empty.");
		}
		let dir = PathUtils.parent(path);
		let newPath = PathUtils.join(dir, `${sanitized}.md`);
		if (newPath === path) {
			return path; // no-op rename (unchanged title)
		}
		if (await IOUtils.exists(newPath)) {
			throw new Error(`A conversation named "${sanitized}.md" already exists.`);
		}
		await IOUtils.move(path, newPath);
		this.log(`renameConversation: ${path} -> ${newPath}`);
		return newPath;
	},
};
