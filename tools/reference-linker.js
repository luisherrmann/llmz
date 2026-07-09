// Resolves a bibliography entry from the paper currently open in the reader
// to whatever matching item ALREADY exists in the user's Zotero library, and
// links the two items together via Zotero's own "Related" relation. Sibling
// to tools/reference-retrieval.js (LLMReferenceRetrieval), which this module
// deliberately reuses the intent-classification parsing and citation/title
// helpers from ( _parseIntentResponse, _callModel, _extractCitationMetadata,
// _findExistingItem) rather than duplicating them -- the two modules solve
// almost the same problem (resolve a bibliography entry to a real paper),
// just differing in what happens once a match is found: retrieval downloads
// a NEW copy from the web, this module only ever links to something the
// user ALREADY has. No web search/download logic lives here at all.
LLMReferenceLinker = {
	log(msg) {
		Zotero.debug("LLM Chat Pane [Reference Linker]: " + msg);
	},

	// Same six-shape classification as LLMReferenceRetrieval.
	// detectDownloadIntent, but for a "link reference(s) to the existing
	// library item" request instead of a download -- e.g. "link reference
	// 12 to my library", "relate the He et al. paper to this one". Shares
	// _parseIntentResponse with detectDownloadIntent (identical response
	// format, just different classify-prompt wording) rather than
	// duplicating that parsing logic. Explicitly excludes download phrasing
	// in its own "none" case (and vice versa in detectDownloadIntent) so a
	// single message reliably matches at most one of the two, despite both
	// being checked independently (see request.js, which tries download
	// intent first, then link intent, each its own classify call).
	// Returns one of:
	//   { type: "single", index }
	//   { type: "describe", description }
	//   { type: "list", indices: [...] }
	//   { type: "range", from, to }
	//   { type: "all" }
	//   { type: "select", description }
	//   null -- not a link request at all
	async detectLinkIntent(prompt) {
		let classifyPrompt = [
			"You are detecting whether the user's message is a request to LINK one or",
			"more bibliography/reference-list entries from the current PDF to the",
			"matching item ALREADY in their Zotero library (creating a \"Related\"",
			"relation between the current paper and that reference) -- NOT a request",
			"to download, save, or search the web for anything. Determine which of the",
			"following forms the request takes, and respond with EXACTLY ONE line in",
			"the corresponding format. Do not explain.",
			"",
			'1. A SINGLE reference by explicit number ("link reference 15", "relate ref',
			'   3 to this paper", "connect citation 7 to the library item"):',
			"   SINGLE: <number>",
			"",
			"2. A SINGLE reference identified by title/author/description, with NO",
			'   number given ("link the Jumper AlphaFold paper", "relate the paper by',
			'   He et al. about masked autoencoders"):',
			"   DESCRIBE: <the identifying text from the user's message>",
			"",
			'3. An ENUMERATED list of specific reference numbers ("link references 1, 2,',
			'   45 and 46", "relate refs 3, 7, 9"):',
			"   LIST: <comma-separated numbers>",
			"",
			'4. A RANGE of reference numbers ("link references 8-20", "relate references',
			'   10 through 15"):',
			"   RANGE: <start>-<end>",
			"",
			'5. ALL references in the bibliography ("link all references", "relate every',
			'   paper from this bibliography\'s reference list"):',
			"   ALL",
			"",
			"6. A SELECTION described by some CRITERION other than an explicit",
			"   number/range/list, which requires actually reading the reference list",
			'   to resolve ("link all papers by Kaiming He", "relate every reference',
			'   from before 2016"):',
			"   SELECT: <the selection criterion, in the user's own words>",
			"",
			'If the message is NOT a reference-link request at all (e.g. a normal',
			'question about the PDF\'s content, or a request to DOWNLOAD a reference',
			'rather than link it), respond with exactly "none".',
			"",
			`User's message: "${prompt}"`,
		].join("\n");
		let text = await LLMReferenceRetrieval._callModel(classifyPrompt);
		return LLMReferenceRetrieval._parseIntentResponse(text);
	},

	// Resolves a bibliography entry (by its own reference number) to
	// whatever matching item ALREADY exists in the user's library (see
	// LLMReferenceRetrieval._findExistingItem -- the same title-based lookup
	// downloadReferenceToLibrary uses before deciding whether to download
	// anything new), and links the two items via Zotero's own "Related"
	// relation. Deliberately does NOT search the web or download anything if
	// no matching item is found -- that's downloadReferenceToLibrary's job;
	// this only ever touches what's already in the library.
	// `pdfItem` is the PDF ATTACHMENT (see llm-chat-pane.js's
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
		let ref = referenceIndex?.references?.find(r => r.index === index);
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
