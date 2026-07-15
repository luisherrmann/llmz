// Resolves a bibliography entry from the paper currently open in the reader
// to whatever matching item ALREADY exists in the user's Zotero library, and
// links the two items together via Zotero's own "Related" relation. Sibling
// to tools/reference-retrieval.js (LLMReferenceRetrieval), which this module
// deliberately reuses the citation/title helpers from ( _callModel,
// _extractCitationMetadata, _findExistingItem) rather than duplicating them
// -- the two modules solve almost the same problem (resolve a bibliography
// entry to a real paper), just differing in what happens once a match is
// found: retrieval downloads a NEW copy from the web, this module only ever
// links to something the user ALREADY has. No web search/download logic
// lives here at all.
LLMReferenceLinker = {
	log(msg) {
		Zotero.debug("LLM Chat Pane [Reference Linker]: " + msg);
	},

	// Native-tool-calling descriptor for this tool (see llm/intent.js's
	// detectIntent/_registry) -- same shape/rationale as
	// LLMReferenceRetrieval.intentTool, see its own comment. `resolver` is
	// the EXACT SAME object as LLMReferenceRetrieval.intentTool's own (not
	// a copy) -- safe to reference directly here since
	// tools/reference-retrieval.js is loaded first (see bootstrap.js) and
	// is therefore already fully defined by the time this object literal
	// is constructed. Both tools resolve against the identical reference
	// index/methods, only diverging in what happens with the resolved
	// numbers afterward (see llm/request.js's _handleDownloadOrLink).
	intentTool: {
		name: "link_reference",
		description: [
			"Links one or more bibliography/reference-list entries from the paper",
			"currently open in the reader to the matching item ALREADY in the",
			"user's Zotero library, creating a \"Related\" relation between the",
			"current paper and that reference. Use this when the user asks to",
			"link, relate, or connect a reference to the corresponding library",
			"item -- NOT for downloading, saving, or fetching a reference from the",
			"web (a separate tool exists for that), and not for anything else",
			"about the PDF's content.",
		].join(" "),
		schema: {
			type: "object",
			properties: {
				type: {
					type: "string",
					enum: ["single", "describe", "list", "range", "all", "select"],
					description: [
						"single: one reference, but ONLY when the user states the reference's",
						"own EXPLICIT number themselves (e.g. \"reference 5\", \"citation [12]\")",
						"-- set index to that exact number. NEVER use 'single' with a number",
						"you invented or guessed from a title/author/topic -- if the user",
						"didn't give a number, use 'describe' or 'select' instead, even if",
						"you're confident which entry they mean. describe: one reference",
						"identified by title/author/description, no number given (set",
						"description). list: an enumerated set of specific numbers (set",
						"indices). range: a numeric range (set from/to). all: every reference",
						"in the bibliography (no other fields needed). select: a criterion",
						"other than an explicit number/range/list, e.g. author/year/topic --",
						"including a request for MULTIPLE items by the same author/venue/topic",
						"(e.g. \"the papers by Kohler et al.\", \"anything from Nature\") (set",
						"description).",
					].join(" "),
				},
				index: { type: "integer", description: "Required when type is 'single' -- the reference number the user themselves stated. Never invent or guess this number." },
				description: { type: "string", description: "Required when type is 'describe' or 'select' -- the identifying text or selection criterion, in the user's own words." },
				indices: { type: "array", items: { type: "integer" }, description: "Required when type is 'list' -- the explicit reference numbers." },
				from: { type: "integer", description: "Required when type is 'range' -- the start of the range." },
				to: { type: "integer", description: "Required when type is 'range' -- the end of the range." },
			},
			required: ["type"],
		},
		resolver: LLMReferenceRetrieval.intentTool.resolver,
	},

	// Resolves a bibliography entry (by its own reference number) to
	// whatever matching item ALREADY exists in the user's library (see
	// LLMReferenceRetrieval._findExistingItem -- the same title-based lookup
	// downloadReferenceToLibrary uses before deciding whether to download
	// anything new), and links the two items via Zotero's own "Related"
	// relation. Deliberately does NOT search the web or download anything if
	// no matching item is found -- that's downloadReferenceToLibrary's job;
	// this only ever touches what's already in the library.
	// `pdfItem` is the PDF ATTACHMENT (see chat-pane.js's
	// getActiveReaderAttachment) -- the paper being linked FROM is its
	// parentItem, not the attachment itself, since "Related" is a relation
	// between top-level bibliographic items (confirmed via Zotero's own
	// relatedBox.js custom element, which is what actually renders the
	// "Related" section of the item pane).
	// Relation is added on BOTH sides (this item -> the reference, AND the
	// reference -> this item) inside one transaction, matching exactly the
	// pattern relatedBox.js's own "+" button uses (addRelatedItem returns
	// false, rather than throwing, for an already-existing relation or a
	// self-relation -- checked below to report "already linked" accurately
	// instead of silently no-oping) -- Zotero relations are stored
	// directionally, so only adding one side would make the link visible
	// from this paper's own Related pane but not from the reference's.
	// Returns { success, linked, alreadyLinked, item, title, message }
	// (`item`/`title` only set when a matching library item was found,
	// `message` a user-facing status string for the no-match/error cases).
	async linkReferenceToLibrary(index, pdfItem, onProgress, onStage) {
		if (!pdfItem) {
			return { success: false, message: "No active PDF to look up references from." };
		}
		let paperItem = pdfItem.parentItem;
		if (!paperItem) {
			return { success: false, message: "The active PDF has no parent library item to link from." };
		}

		onProgress?.(`Looking up reference ${index} in the bibliography...`);
		let referenceIndex = await LLMReferences.getReferenceIndex(pdfItem);
		let ref = referenceIndex?.references?.find(r => LLMReferences.displayNumber(r) === index);
		if (!ref) {
			return { success: false, message: `Reference ${index} was not found in this paper's bibliography.` };
		}

		let citationText = ref.text;
		this.log(`linkReferenceToLibrary: resolving reference ${index}: ${citationText.slice(0, 100)}`);

		onProgress?.(`Extracting title from reference ${index}...`);
		onStage?.("Extracting title...");
		let title = null;
		try {
			let metadata = await LLMReferenceRetrieval._extractCitationMetadata(citationText);
			title = metadata.title;
		}
		catch (e) {
			this.log(`linkReferenceToLibrary: metadata extraction failed: ${e.message}`);
		}
		if (!title) {
			return { success: false, message: `Could not determine a title for reference ${index}.` };
		}

		onProgress?.(`Checking if "${title}" is already in your library...`);
		onStage?.("Checking your library...");
		let existing;
		try {
			existing = await LLMReferenceRetrieval._findExistingItem(title);
		}
		catch (e) {
			this.log(`linkReferenceToLibrary: existing-item check failed: ${e.message}`);
			return { success: false, message: `Failed to search your library for reference ${index}: ${e.message}` };
		}
		if (!existing) {
			return { success: true, linked: false, title, message: `"${title}" was not found in your library, so nothing was linked.` };
		}
		if (existing.id === paperItem.id) {
			return { success: true, linked: false, title, message: `Reference ${index} ("${title}") is the current paper itself.` };
		}

		onProgress?.(`Linking "${title}" to the current paper...`);
		onStage?.("Linking...");
		let added = false;
		try {
			await Zotero.DB.executeTransaction(async () => {
				if (paperItem.addRelatedItem(existing)) {
					await paperItem.save({ skipDateModifiedUpdate: true });
					added = true;
				}
				if (existing.addRelatedItem(paperItem)) {
					await existing.save({ skipDateModifiedUpdate: true });
					added = true;
				}
			});
		}
		catch (e) {
			this.log(`linkReferenceToLibrary: linking failed: ${e.message}`);
			return { success: false, message: `Failed to link reference ${index} ("${title}"): ${e.message}` };
		}

		return { success: true, linked: true, alreadyLinked: !added, item: existing, title: existing.getField("title") };
	},
};
