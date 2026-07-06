// Resolves a bibliography entry from the paper currently open in the reader
// to an online source, and saves it into the user's Zotero library (with a
// PDF attached directly, when one can be found). Split out from
// llm-chat-pane.js since this whole pipeline is self-contained -- distinct
// from llm-references.js, which only extracts/parses the bibliography list
// itself -- and needs only a single narrow hook back into the chat pane: a
// way to call the currently active LLM (see init()).
LLMReferenceRetrieval = {
	_streamModel: null,

	log(msg) {
		Zotero.debug("LLM Chat Pane [Reference Retrieval]: " + msg);
	},

	// `streamModel` is LLMChatPane's own provider-aware model-calling
	// function (Ollama/LM Studio/LiteLLM), bound to LLMChatPane by the
	// caller -- passed in rather than imported, since this module has no
	// business knowing about chat providers itself.
	init(streamModel) {
		this._streamModel = streamModel;
	},

	async _callModel(prompt) {
		let result = await this._streamModel(prompt, () => {}, {});
		return (result.text || "").trim();
	},

	// Detects a "download reference N" request before the message is sent to
	// the main chat model, in whatever phrasing the user happens to use --
	// either NUMBERED ("download reference 15", "save ref 3 to my library",
	// "grab citation 7 for me") or identified by TITLE/AUTHOR/description
	// instead ("download the Jumper AlphaFold paper", "save the paper by He
	// et al. about masked autoencoders") -- the latter is resolved against
	// the paper's own reference list afterward, in resolveReferenceByDescription,
	// since matching free text against 50+ citation strings needs the actual
	// list in front of the model, which this first, cheap classification
	// pass deliberately skips. Checked via an LLM call rather than a fixed
	// regex so reasonable rephrasings are still recognized, at the cost of
	// one extra (fast, single-token) model call per message.
	// Returns { index } for a numbered request, { description } for a
	// name/title-based one, or null if this isn't a download request at all.
	async detectDownloadIntent(prompt) {
		let classifyPrompt = [
			"You are detecting whether the user's message is a request to download",
			"a bibliography/reference-list entry from the current PDF into their Zotero",
			'library. This can be phrased by NUMBER ("download reference 15", "save ref 3',
			'to my library", "grab citation 7 for me") OR by naming the paper itself',
			'("download the Jumper AlphaFold paper", "save the paper by He et al. about',
			'masked autoencoders", "add the transformer paper to my library").',
			"",
			"If it IS such a request AND a reference number is explicitly given, respond",
			'with ONLY that number (e.g. "15").',
			"If it IS such a request but NO number is given (the paper is identified by",
			"title, author, or description instead), respond with exactly:",
			'DESCRIBE: <the identifying text from the user\'s message>',
			'If it is NOT such a request (e.g. a normal question about the PDF\'s content),',
			'respond with exactly "none". Do not explain.',
			"",
			`User's message: "${prompt}"`,
		].join("\n");
		let text = await this._callModel(classifyPrompt);
		if (!text || /^none$/i.test(text)) return null;
		let describeMatch = text.match(/^DESCRIBE:\s*(.+)$/is);
		if (describeMatch) return { description: describeMatch[1].trim() };
		let match = text.match(/\d+/);
		return match ? { index: parseInt(match[0], 10) } : null;
	},

	// Resolves a "download <title/author description>" request (no explicit
	// reference number given) against the paper's own reference list --
	// gives the LLM the full numbered bibliography and lets it match loosely
	// (partial title, author surname, "the AlphaFold paper", etc.), since
	// citation formatting varies far too much for a fixed substring match to
	// be reliable.
	async resolveReferenceByDescription(referenceIndex, description) {
		let refs = referenceIndex?.references || [];
		if (!refs.length) return null;
		let listing = refs.map(r => `[${r.index}] ${r.text}`).join("\n");
		let prompt = [
			"Below is a paper's numbered bibliography. Identify which entry (if any)",
			"matches the following description of a paper the user wants to download.",
			'Respond with ONLY the reference number. If no entry is a confident match,',
			'respond with exactly "none". Do not explain.',
			"",
			`Description: "${description}"`,
			"",
			"Bibliography:",
			listing,
		].join("\n");
		let text = await this._callModel(prompt);
		if (!text || /none/i.test(text)) return null;
		let match = text.match(/\d+/);
		return match ? parseInt(match[0], 10) : null;
	},

	// Asks the model to pull structured metadata (title, authors, year,
	// venue) out of a formatted citation in a single call -- citation styles
	// vary too much for a regex to do this reliably (title position,
	// quoting, and punctuation all differ across styles), and a clean title
	// is a much better search query than the raw citation string: the venue
	// name/page numbers/punctuation in a full citation measurably hurts
	// match quality against both Crossref's bibliographic search and
	// arXiv's title search (confirmed: a raw full-citation query missed a
	// paper that a clean-title query found immediately on arXiv). Also
	// extracting authors/year/venue here (rather than a second LLM call)
	// lets the fast title-only web-search stage (see _saveMinimalItem) save
	// a reasonably complete item without needing a slower, richer
	// identity-discovery stage (page translation or Crossref) just for
	// metadata. Returns { title, authors: [{firstName, lastName}], year,
	// venue }, any of which may be null if the model couldn't determine it.
	async _extractCitationMetadata(citationText) {
		let prompt = [
			"Extract structured metadata from this bibliography citation. Respond",
			"with ONLY a JSON object (no code fences, no markdown, no explanation)",
			"in exactly this shape:",
			'{"title": "...", "authors": [{"firstName": "...", "lastName": "..."}], "year": "...", "venue": "..."}',
			"Use null for any field you cannot determine. Split author names into",
			'firstName/lastName as best as possible. Do not include "et al." as an',
			"author.",
			"",
			`Citation: "${citationText}"`,
		].join("\n");
		let text = await this._callModel(prompt);
		text = text.replace(/^```(?:json)?\s*|\s*```$/g, "");
		try {
			let parsed = JSON.parse(text);
			return {
				title: typeof parsed.title === "string" ? parsed.title.replace(/^["'“]+|["'”]+$/g, "") : null,
				authors: Array.isArray(parsed.authors) ? parsed.authors : [],
				year: parsed.year || null,
				venue: parsed.venue || null,
			};
		}
		catch (e) {
			this.log(`_extractCitationMetadata: failed to parse model response as JSON: ${e.message}`);
			return { title: null, authors: [], year: null, venue: null };
		}
	},

	// Character-bigram Sørensen-Dice coefficient -- a plain substring-
	// containment check (the previous approach) turns out to score a WRAPPER
	// title as a perfect match whenever it fully contains the real one (e.g.
	// "Faculty Opinions recommendation of <title>", or "<title>: A Survey"),
	// which is exactly the false-positive shape confirmed twice in practice
	// (a commentary piece outranking the real AlphaFold paper on Crossref;
	// an unrelated "butterfly recognition" paper for a ResNet lookup).
	// Bigram Dice still scores those wrapper titles fairly high (extra
	// prefix/suffix text dilutes but doesn't eliminate the overlap), but
	// clearly lower than a genuine match -- see _TITLE_MATCH_THRESHOLD.
	// Robust to minor word-order shuffling, punctuation, and the small
	// spacing/OCR-like noise PDF-extracted citation text can introduce,
	// without needing an external fuzzy-matching library. Returns 1.0 for an
	// exact (post-normalization) match, 0.0 for no shared bigrams at all.
	_titleSimilarity(a, b) {
		let norm = s => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
		let na = norm(a);
		let nb = norm(b);
		if (!na || !nb) return 0;
		if (na === nb) return 1;
		if (na.length < 2 || nb.length < 2) return 0;
		let bigramCounts = s => {
			let counts = new Map();
			for (let i = 0; i < s.length - 1; i++) {
				let bg = s.substr(i, 2);
				counts.set(bg, (counts.get(bg) || 0) + 1);
			}
			return counts;
		};
		let countsA = bigramCounts(na);
		let countsB = bigramCounts(nb);
		let intersection = 0;
		for (let [bg, count] of countsA) {
			if (countsB.has(bg)) intersection += Math.min(count, countsB.get(bg));
		}
		return (2 * intersection) / ((na.length - 1) + (nb.length - 1));
	},

	// Minimum _titleSimilarity score to accept a candidate as "the same
	// paper". Chosen empirically against confirmed real cases: a genuine
	// match (even with a prefixed acronym, e.g. "ProSST: ...") scores
	// >=0.95, while the two confirmed false-positive wrapper titles above
	// score 0.77 (Faculty Opinions) and 0.63-0.90 (unrelated papers sharing
	// several keywords) -- 0.8 sits cleanly between the two clusters.
	_TITLE_MATCH_THRESHOLD: 0.8,

	_titlesRoughlyMatch(a, b) {
		return this._titleSimilarity(a, b) >= this._TITLE_MATCH_THRESHOLD;
	},

	// Checked before running any search/save stage, to avoid creating a
	// duplicate item for a reference the user already has. Searches on just
	// the first few words rather than the full title -- Zotero's "contains"
	// condition needs a real substring match, and the full extracted title
	// can differ from the saved item's stored title in minor punctuation/
	// unicode-dash/subtitle-colon ways, so a shorter, more distinctive
	// fragment is more likely to actually match at the DB level. Each
	// candidate is then confirmed (or rejected) with the same loose
	// _titlesRoughlyMatch used to validate newly-saved items.
	async _findExistingItem(title) {
		if (!title) return null;
		let keywords = title.split(/\s+/).slice(0, 6).join(" ");
		let search = new Zotero.Search();
		search.libraryID = Zotero.Libraries.userLibraryID;
		search.addCondition("title", "contains", keywords);
		let ids = await search.search();
		for (let id of ids) {
			let item = await Zotero.Items.getAsync(id);
			if (item && this._titlesRoughlyMatch(item.getField("title") || "", title)) {
				return item;
			}
		}
		return null;
	},

	async _saveViaIdentifier(identifier) {
		let translate = new Zotero.Translate.Search();
		translate.setIdentifier(identifier);
		let translators = await translate.getTranslators();
		if (!translators.length) return [];
		translate.setTranslator(translators);
		return translate.translate({
			libraryID: Zotero.Libraries.userLibraryID,
			saveAttachments: true,
		});
	},

	// DuckDuckGo's HTML endpoint needs no API key/auth, unlike Google/Bing
	// (which block automated queries) or Semantic Scholar's public API
	// (confirmed empirically: its unauthenticated tier 429s persistently even
	// with backoff) -- returns a real results page, parsed here for
	// candidate URLs. Result links are wrapped in a redirect,
	// "//duckduckgo.com/l/?uddg=<url-encoded target>&rut=...", unwrapped
	// below to get the actual target URL. Also captures each result's own
	// displayed link text as `title` -- an untrusted but useful, free signal
	// for pre-filtering obviously-wrong candidates before fetching them (see
	// _findPDFViaWebSearch), since a raw PDF URL otherwise carries no page
	// metadata at all to check against the target title.
	async _searchWeb(query, maxResults = 5) {
		let url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
		let response = await Zotero.HTTP.request("GET", url, {
			timeout: 15000,
			headers: { "User-Agent": "Mozilla/5.0" },
		});
		let doc = new DOMParser().parseFromString(response.responseText, "text/html");
		let results = [];
		for (let a of doc.querySelectorAll("a.result__a")) {
			let href = a.getAttribute("href");
			if (!href) continue;
			try {
				let full = href.startsWith("http") ? href : "https:" + href;
				let target = new URL(full).searchParams.get("uddg");
				if (target) results.push({ url: decodeURIComponent(target), title: a.textContent.trim() });
			}
			catch (e) {
				// unparseable result link -- skip
			}
			if (results.length >= maxResults) break;
		}
		return results;
	},

	// Checks the actual Content-Type via a HEAD request rather than trusting
	// the URL's file extension -- confirmed concretely that this matters:
	// arxiv.org/pdf/<id> (and many other repositories) serve a real PDF with
	// no ".pdf" suffix at all, which a naive extension check would miss.
	// Falls back to the extension check if HEAD isn't supported (some
	// servers 405 it).
	async _isDirectPDF(url) {
		try {
			let headResponse = await Zotero.HTTP.request("HEAD", url, { timeout: 10000, followRedirects: true });
			let contentType = headResponse.getResponseHeader("Content-Type") || "";
			if (/pdf/i.test(contentType)) return true;
		}
		catch (e) {
			// fall through to the extension-based check
		}
		return /\.pdf(?:[?#]|$)/i.test(url);
	},

	// Detects (without saving anything) whether a PDF is reachable at the
	// given URL -- either the URL is itself a direct PDF link (common for
	// search results pointing straight at a repository's PDF, e.g. an
	// open-access conference proceedings page), or Zotero has a web
	// translator for the page that populates a PDF attachment (e.g. many
	// publisher/repository pages). Returns { url, title, mimeType, titleIsReal }
	// or null. Used both for a DOI-resolved landing page and for general
	// web-search candidate pages -- same shape either way, only the URL
	// source differs. `titleIsReal` tells the caller whether `title` came
	// from the page's own metadata (safe to validate against the target
	// title) or is just the caller-supplied fallback substituted in for a
	// raw PDF byte stream, which carries no metadata of its own at all --
	// without this distinction, a caller validating title could wrongly
	// "confirm" a mismatched direct-PDF result just because its title
	// happens to equal whatever fallback was passed in.
	async _findPDFAtURL(url, fallbackTitle) {
		if (await this._isDirectPDF(url)) {
			return { url, title: fallbackTitle || url, mimeType: "application/pdf", titleIsReal: false };
		}
		const { HiddenBrowser } = ChromeUtils.importESModule("chrome://zotero/content/HiddenBrowser.mjs");
		let browser;
		try {
			browser = new HiddenBrowser({ blockRemoteResources: false });
			await browser.load(url, { requireSuccessfulStatus: true });
			let doc = await browser.getDocument();
			let fileInfo = await Zotero.Utilities.Internal.getFileFromDocument(doc);
			if (fileInfo && /pdf/i.test(fileInfo.mimeType || "")) {
				// The translator can claim a PDF attachment exists purely
				// from the page's own markup (e.g. a "download PDF" link)
				// without that meaning the file is actually fetchable --
				// confirmed concretely with IEEE Xplore: the page links to
				// its own stampPDF/getPDF.jsp endpoint regardless of access
				// rights, but hitting that URL without institutional/paid
				// access returns HTTP 418 with an HTML block page, not real
				// PDF bytes. Verify the actual download URL's Content-Type
				// before trusting the translator's claim -- otherwise a
				// paywalled "success" here stops the search before later
				// stages (e.g. the general web search, which would find an
				// open-access copy on arXiv) ever get a chance to run.
				if (!await this._isDirectPDF(fileInfo.url)) {
					this.log(`_findPDFAtURL: ${url} -- translator-claimed PDF at ${fileInfo.url} isn't actually downloadable (paywalled?)`);
					return null;
				}
				return { ...fileInfo, titleIsReal: !!fileInfo.title };
			}
			return null;
		}
		catch (e) {
			this.log(`_findPDFAtURL: ${url} failed: ${e.message}`);
			return null;
		}
		finally {
			if (browser) browser.destroy();
		}
	},

	async _attachPDF(fileInfo, item) {
		await Zotero.Attachments.importFromURL({
			libraryID: item.libraryID,
			url: fileInfo.url,
			parentItemID: item.id,
			title: fileInfo.title,
			contentType: fileInfo.mimeType,
		});
	},

	// A Zotero.Item used when a PDF is found via the fast title-only web
	// search below, before any translator/Crossref-based identity-discovery
	// stage has run. Populated straight from the same _extractCitationMetadata
	// call already made for the title -- no extra LLM or network round-trip
	// needed -- so it ends up reasonably complete (authors, year, venue)
	// despite skipping the slower stages that would otherwise be needed just
	// to get that metadata. `url` is set explicitly (unlike a
	// translator-populated item, which sets it itself) since
	// downloadReferenceToLibrary's sourceURL reporting reads it straight off
	// the saved item via getField("url") -- without this, the "Added ..."
	// message would have no source to show at all once hasPDF is already
	// true (later PDF-only fallback stages, which would otherwise supply
	// sourceURL, only run when hasPDF is still false).
	async _saveMinimalItem(url, metadata) {
		let item = new Zotero.Item("journalArticle");
		item.libraryID = Zotero.Libraries.userLibraryID;
		item.setField("title", metadata.title);
		if (url) item.setField("url", url);
		if (metadata.year) item.setField("date", metadata.year);
		if (metadata.venue) item.setField("publicationTitle", metadata.venue);
		if (metadata.authors?.length) {
			item.setCreators(metadata.authors.map(a => ({
				firstName: a.firstName || "",
				lastName: a.lastName || "",
				creatorType: "author",
			})));
		}
		await item.saveTx();
		return item;
	},

	// Validates that a batch of just-saved items actually matches the
	// citation we were looking for, keeps only the BEST-scoring one (see
	// _titleSimilarity), and erases the rest (not just moves to trash --
	// these were never something the user asked for individually). Scores
	// EVERY item rather than accepting the first one over threshold -- a
	// single search stage can save many items at once (confirmed concretely:
	// Crossref's bibliographic search returns up to 20 loosely related
	// results by default, and the Crossref REST translator saves one Zotero
	// item per result), so several candidates can clear the threshold at
	// once (e.g. the real paper AND a "Survey" paper about it), and the
	// highest-scoring one is the better bet. Also fixes the failure mode
	// where checking only items[0] left every other loosely-related result
	// sitting unvalidated in the user's library as clutter even when [0]
	// happened to be right.
	async _validateAndCleanup(items, title) {
		if (!items.length || !title) return items;
		let scored = items
			.map(item => ({ item, score: this._titleSimilarity(item.getField("title") || "", title) }))
			.sort((a, b) => b.score - a.score);
		let best = scored[0];
		let match = best.score >= this._TITLE_MATCH_THRESHOLD ? best.item : null;
		if (!match) {
			this.log(`_validateAndCleanup: rejecting ${items.length} mismatched result(s) (best score ${best.score.toFixed(2)} for "${best.item.getField("title")}" vs expected "${title}")`);
		}
		else if (scored.length > 1) {
			this.log(`_validateAndCleanup: picked best match (score ${best.score.toFixed(2)}) out of ${items.length} candidates for "${title}"`);
		}
		for (let { item } of scored) {
			if (item === match) continue;
			try {
				await item.eraseTx();
			}
			catch (e) {
				this.log(`_validateAndCleanup: failed to erase unmatched item: ${e.message}`);
			}
		}
		return match ? [match] : [];
	},

	// Tries a sequence of increasingly loose search queries, each with more
	// candidate results, until one yields a working PDF -- a single quoted
	// "<title>" pdf query often returns very few (or zero) hits. Confirmed
	// concretely with a real paper (ProSST): the exact-quoted query returned
	// only 2 results, NEITHER a real PDF (a paywalled ACM DL page and a
	// conference-proceedings listing page), while the unquoted variant
	// immediately surfaced both a direct NeurIPS PDF and the bioRxiv preprint
	// landing page (which itself resolves to a PDF via its own web
	// translator) -- exact title-string matching is too strict since a
	// preprint host commonly differs from the final citation in
	// capitalization or minor wording.
	// Used ONLY to decide whether a candidate is worth fetching at all --
	// search-engine result titles routinely carry extra site-name/ID noise
	// (e.g. "[1512.03385] Deep Residual Learning for Image Recognition",
	// "... - IEEE Xplore") that legitimately lowers the score without
	// indicating a wrong paper; confirmed several such real examples score
	// 0.72-0.89, comfortably above this. NOT used to actually ACCEPT a
	// direct-PDF result -- that needs the full _TITLE_MATCH_THRESHOLD (see
	// below), since a raw PDF byte stream has no other signal to validate
	// against at all once fetched.
	_PDF_SNIPPET_PREFILTER_THRESHOLD: 0.6,

	async _findPDFViaWebSearch(title, fallbackTitle) {
		let queries = [`"${title}" pdf`, title];
		for (let query of queries) {
			let candidates = await this._searchWeb(query, 8);
			for (let candidate of candidates) {
				let snippetScore = candidate.title ? this._titleSimilarity(candidate.title, title) : null;
				// Cheap pre-filter using the search engine's own displayed
				// result title, before spending a fetch on it at all.
				if (snippetScore !== null && snippetScore < this._PDF_SNIPPET_PREFILTER_THRESHOLD) {
					continue;
				}
				let fileInfo = await this._findPDFAtURL(candidate.url, fallbackTitle);
				if (!fileInfo) continue;
				if (fileInfo.titleIsReal) {
					// A translator-detected page exposes a REAL title --
					// confirmed concretely that blindly trusting "some PDF
					// was found" here is exactly how a wrong PDF gets
					// attached to an otherwise-correctly-identified item, so
					// hold this to the same strict bar used everywhere else
					// rather than accepting it just because it's a PDF.
					if (this._titleSimilarity(fileInfo.title, title) < this._TITLE_MATCH_THRESHOLD) {
						this.log(`_findPDFViaWebSearch: rejecting mismatched PDF page title "${fileInfo.title}" for "${title}"`);
						continue;
					}
				}
				else {
					// A raw PDF byte stream carries NO metadata of its own
					// to check after fetching -- confirmed concretely that
					// this matters: a Universidad Nacional de Colombia
					// thesis (totally unrelated to the target paper) was
					// served as a genuine, real, downloadable PDF from a
					// repository "download" endpoint. Nothing about the
					// HTTP response itself was wrong -- only the search
					// engine's OWN displayed title for that result could
					// have caught it, so require it to clear the FULL
					// strict bar (not just the loose pre-filter above)
					// before trusting an unverifiable direct-PDF result.
					if (snippetScore === null || snippetScore < this._TITLE_MATCH_THRESHOLD) {
						this.log(`_findPDFViaWebSearch: rejecting unverifiable direct-PDF candidate ${candidate.url} (snippet score ${snippetScore})`);
						continue;
					}
				}
				return fileInfo;
			}
		}
		return null;
	},

	// Resolves a bibliography entry (by the paper's own reference number) to
	// an online source and saves it into the user's library. Before any
	// stage runs, checks whether the paper is already saved (see
	// _findExistingItem) -- if so, returns immediately with
	// { alreadyInLibrary: true, item } rather than re-downloading or
	// creating a duplicate. Otherwise, stages, each tried only if the
	// previous one came up empty (and, from stage 1
	// onward, validated against the extracted title via _validateAndCleanup
	// -- see there for why a stage merely returning something isn't enough):
	// (1) Identifiers already embedded in the citation text itself
	// (DOI/arXiv/ISBN/PMID), via Zotero.Translate.Search.setIdentifier().
	// No separate arXiv-by-title stage is needed here -- an arXiv preprint
	// not cited with its own arXiv ID gets picked up by stage 2 (below)
	// instead, same as any other freely-hosted source.
	// (2) A FAST, title-only web search for a directly-downloadable PDF (see
	// _findPDFViaWebSearch/_saveMinimalItem) -- just a HEAD request or two
	// per candidate, rather than a full page load. The saved item's
	// authors/year/venue come from the SAME _extractCitationMetadata call
	// already made for the title, so this stays fast (no extra LLM call, no
	// extra network round-trip) while still ending up reasonably
	// well-cataloged, not just a bare title.
	// (3) LAST-RESORT free-text bibliographic query via Zotero's own
	// "Crossref REST" translator, selected directly by ID (see the code
	// comment there for why getTranslators() can't be used). Only tried once
	// stages 1-2 have BOTH failed to produce anything AT ALL -- Crossref
	// search results essentially never carry a PDF, so this exists purely to
	// salvage a metadata-only save (no freely-hosted copy exists anywhere)
	// rather than failing outright, and it's the slowest stage besides
	// (saves up to ~20 candidate items and erases all but the best match --
	// see _validateAndCleanup).
	// Stages 1-3 all save with saveAttachments:true (or attach directly, for
	// stage 2) in case a PDF is available (reliably true for arXiv and many
	// web translators, essentially never true for Crossref search). If the
	// saved item still has no PDF afterward:
	// (4) try a general web search again, checking progressively looser
	// queries/candidates via _findPDFAtURL (detect-only, attach if found)
	// until one yields a PDF (see _findPDFViaWebSearch). (A DOI-resolved-
	// landing-page stage used to run before this one -- removed since it
	// needed a full HiddenBrowser page load per attempt, the slowest step in
	// the pipeline, and failed more often than not on exactly the papers
	// that reach this point: a DOI landing page gated enough to need a real
	// page load tends to also be paywalled for the PDF itself, confirmed
	// concretely with both IEEE Xplore and a Curran/proceedings.com reprint
	// DOI -- while this stage finds the same open-access copies without
	// that cost.)
	// Mirrors the same HiddenBrowser + Zotero.Utilities.Internal.getFileFromDocument
	// + Zotero.Attachments.importFromURL pattern Zotero's own
	// addAvailableFile/downloadFirstAvailableFile machinery uses
	// (chrome/content/zotero/xpcom/attachments.js) for stage 4 -- there's no
	// ItemSaver-level API to redirect a web-translated save onto an existing
	// item, so this stage deliberately does the narrower "detect only, then
	// download+attach the one PDF URL found" version of that flow, rather
	// than a second full translate+save that might duplicate the item.
	async downloadReferenceToLibrary(index, pdfItem) {
		if (!pdfItem) {
			return { success: false, message: "No active PDF to look up references from." };
		}

		let referenceIndex = await LLMReferences.getReferenceIndex(pdfItem);
		let ref = referenceIndex?.references?.find(r => r.index === index);
		if (!ref) {
			return { success: false, message: `Reference ${index} was not found in this paper's bibliography.` };
		}

		let citationText = ref.text;
		this.log(`downloadReferenceToLibrary: resolving reference ${index}: ${citationText.slice(0, 100)}`);

		let title = null;
		let metadata = { title: null, authors: [], year: null, venue: null };
		try {
			metadata = await this._extractCitationMetadata(citationText);
			title = metadata.title;
		}
		catch (e) {
			this.log(`downloadReferenceToLibrary: metadata extraction failed: ${e.message}`);
		}

		// Checked before any search/save stage runs, so a reference the user
		// already has doesn't get re-downloaded (or worse, saved as a
		// duplicate item).
		if (title) {
			try {
				let existing = await this._findExistingItem(title);
				if (existing) {
					this.log(`downloadReferenceToLibrary: reference ${index} already in library (item ${existing.id})`);
					return { success: true, alreadyInLibrary: true, item: existing, title: existing.getField("title") };
				}
			}
			catch (e) {
				this.log(`downloadReferenceToLibrary: existing-item check failed: ${e.message}`);
			}
		}

		let savedItems = [];

		// Stage 1: identifiers already in the citation text. Validated like
		// every other stage, despite a DOI/arXiv/ISBN/PMID being a strong
		// signal in principle -- more than one translator can match the same
		// identifier (each then saving its own item), and identifier-based
		// searches (e.g. ISBN) can themselves resolve to several editions/
		// records, so this can return multiple candidates just like the
		// free-text and web-search stages below.
		let identifiers = Zotero.Utilities.extractIdentifiers(citationText);
		for (let identifier of identifiers) {
			try {
				let items = await this._saveViaIdentifier(identifier);
				items = await this._validateAndCleanup(items, title);
				if (items.length) {
					savedItems = items;
					break;
				}
			}
			catch (e) {
				this.log(`downloadReferenceToLibrary: identifier search failed: ${e.message}`);
			}
		}

		// Stage 2: fast, title-only web search for a directly-downloadable
		// PDF (see _findPDFViaWebSearch) -- just a HEAD request or two per
		// candidate, rather than a full HiddenBrowser page load + translator
		// detection, or Crossref's save-~20-then-erase-most dance. Saves a
		// reasonably complete item itself, using the authors/year/venue
		// already pulled out by the same _extractCitationMetadata call as
		// the title, at no extra LLM or network cost.
		if (!savedItems.length && title) {
			try {
				let fileInfo = await this._findPDFViaWebSearch(title, title);
				if (fileInfo) {
					let item = await this._saveMinimalItem(fileInfo.url, metadata);
					await this._attachPDF(fileInfo, item);
					savedItems = [item];
				}
			}
			catch (e) {
				this.log(`downloadReferenceToLibrary: fast PDF-first web search failed: ${e.message}`);
			}
		}

		// Stage 3: LAST-RESORT free-text bibliographic query (title only,
		// not the raw citation), via Zotero's own "Crossref REST" translator
		// (0a61e167-de9a-4f93-a68a-628b48855909), selected DIRECTLY by ID
		// rather than through translate.getTranslators() -- confirmed by
		// reading that translator's source that its detectSearch() is
		// hardcoded to `return false` unconditionally, which (traced through
		// Zotero's own translate.js: _detectTranslatorLoaded() only adds a
		// translator to _foundTranslators when detectSearch's return value is
		// truthy) means getTranslators() NEVER selects it for a plain
		// query-based .setSearch() call, no matter what the query is.
		// Deliberately tried only after stages 1-2 have BOTH failed to
		// produce anything at all (not merely "no PDF yet") -- Crossref
		// search results essentially never carry a PDF, so this exists
		// purely to salvage a metadata-only save (no arXiv/bioRxiv/etc. copy
		// exists, e.g. an older paywalled journal article) rather than
		// failing outright, and it's the slowest stage besides (saves up to
		// ~20 candidate items and erases all but the best match -- see
		// _validateAndCleanup), so it isn't worth trying any earlier.
		if (!savedItems.length && title) {
			try {
				let translator = Zotero.Translators.get("0a61e167-de9a-4f93-a68a-628b48855909");
				if (translator) {
					let translate = new Zotero.Translate.Search();
					translate.setSearch({ itemType: "journalArticle", query: title });
					translate.setTranslator(translator);
					savedItems = await translate.translate({
						libraryID: Zotero.Libraries.userLibraryID,
						saveAttachments: true,
					});
					savedItems = await this._validateAndCleanup(savedItems, title);
				}
			}
			catch (e) {
				this.log(`downloadReferenceToLibrary: free-text search failed: ${e.message}`);
			}
		}

		if (!savedItems.length) {
			return { success: false, message: `Could not find "${ref.label ? ref.label + ": " : ""}${citationText.slice(0, 80)}${citationText.length > 80 ? "…" : ""}" online.` };
		}

		let saved = savedItems[0];
		let bestAttachment = await saved.getBestAttachment();
		let hasPDF = !!bestAttachment?.isPDFAttachment();
		let doi = saved.getField("DOI");
		// Defaults to wherever the item's own metadata was resolved from --
		// overwritten below with the more specific PDF location if stage 4
		// finds one.
		let sourceURL = saved.getField("url") || (doi ? `https://doi.org/${doi}` : null);

		// Stage 4: general web search for the title, trying progressively
		// looser queries/candidates until one yields a PDF (see
		// _findPDFViaWebSearch) -- rather than giving up after one narrow
		// query comes up empty. (A DOI-resolved-landing-page stage used to
		// run before this one -- removed: it needed a full HiddenBrowser
		// page load per attempt, the slowest step in the whole pipeline, and
		// empirically failed more often than not on exactly the papers that
		// reach this point at all, since a DOI landing page that's paywalled/
		// bot-protected enough to need a real page load is also usually
		// paywalled for the PDF itself -- confirmed concretely with both
		// IEEE Xplore and a Curran/proceedings.com reprint DOI. This stage
		// finds the same open-access copies (arXiv, etc.) without that cost.)
		if (!hasPDF && title) {
			try {
				let fileInfo = await this._findPDFViaWebSearch(title, saved.getField("title"));
				if (fileInfo) {
					await this._attachPDF(fileInfo, saved);
					hasPDF = true;
					sourceURL = fileInfo.url;
				}
			}
			catch (e) {
				this.log(`downloadReferenceToLibrary: web search fallback failed: ${e.message}`);
			}
		}

		return { success: true, item: saved, hasPDF, title: saved.getField("title"), sourceURL };
	},
};
