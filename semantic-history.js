// Ranks a conversation's own prior turns by embedding similarity to the
// current user query, for LLMPrompt's "semantic" message-history mode (see
// llm-prompt.js's own comment on useMessageHistory for the
// union(last K, top-L-by-similarity) rationale this implements). Reuses
// LLMCitation's existing embedding API (getEmbedding/embedBatched/
// cosineSimilarity) -- this module owns only the conversation-message-
// specific cache and ranking logic, not embedding-provider plumbing.
//
// Embeddings are kept in a Map keyed by a content FINGERPRINT
// (role+time+text), not a plain array position-aligned with
// chat.exportTranscript()'s own transcript array -- transcript entries have
// no stable ID of their own, and messages get created/finished from several
// different code paths in request.js (a normal reply, an empty-response
// reply, a cancelled request, an error bubble), not all of which are
// guaranteed to call embedNewMessage. A content-keyed Map degrades
// gracefully under that: a message that was never embedded (or whose
// embedding call failed) simply has no entry and is silently excluded from
// semantic-similarity ranking -- it's still eligible for the plain
// last-K/recency half of selectRelevant's own union, which needs no
// embedding at all -- rather than a positional array silently drifting out
// of alignment with the transcript and corrupting EVERY entry after the
// gap.
LLMSemanticHistory = {
	log(msg) {
		Zotero.debug("LLM Chat Pane [SemanticHistory]: " + msg);
	},

	// fingerprint -> embedding vector, for the CURRENTLY displayed
	// conversation only -- cleared (see reset()) whenever the chat itself
	// is cleared/replaced: a fresh item-pane render, Clear Conversation, or
	// loading a different past conversation. Never persisted to disk --
	// unlike LLMCitation's own PDF-content embedding caches, a live
	// conversation's own turns are cheap to re-embed from scratch each
	// session (embedAll below), and persisting them would need real
	// per-conversation identity this feature doesn't otherwise need.
	_embeddings: new Map(),

	// `entry` is a plain { role, time, text } object, the same shape
	// chat.exportTranscript() itself returns -- role+time+text together are
	// specific enough that a same-role message would need to be byte-for-
	// byte identical AND land within the same one-second timestamp
	// resolution to collide, a negligible risk for a best-effort ranking
	// feature (worst case, one of the two colliding messages' own
	// embedding silently wins for both -- never a crash or a wrong-message
	// mix-up with some THIRD unrelated entry).
	_fingerprint(entry) {
		return `${entry.role}|${entry.time}|${entry.text}`;
	},

	reset() {
		this._embeddings = new Map();
	},

	// Embeds exactly one message and stores it -- call right after a "You"
	// message is appended (request.js's _handleNormalChat) or right after a
	// reply finishes (same file, once its final text/timestamp are known).
	// Deliberately NOT awaited by callers (fire-and-forget) -- embedding
	// runs in the background and simply isn't ready yet for a
	// selectRelevant call that happens to race it (that message just won't
	// be a semantic-match candidate for THIS particular query; it's still
	// available in every LATER query once the embedding lands, and still
	// counts toward the plain recency-based half regardless).
	async embedNewMessage(entry) {
		if (!entry.text) return;
		try {
			let embedding = await LLMCitation.getEmbedding(entry.text);
			this._embeddings.set(this._fingerprint(entry), embedding);
		}
		catch (e) {
			this.log(`embedNewMessage: failed: ${e.message}`);
		}
	},

	// Embeds an entire freshly-loaded transcript in one batched, concurrent
	// call (LLMCitation.embedBatched, the same machinery LLMCitation's own
	// PDF paragraph index uses) rather than one embedNewMessage call per
	// entry -- call once right after loading a past conversation into the
	// chat (llm-chat-pane.js's loadTranscriptIntoChat), after chat.clear()
	// (which this does NOT call itself -- see reset()'s own comment on
	// where that happens instead) and after every entry has actually been
	// appended. `onProgress(current, total)`, if given, is forwarded
	// straight to embedBatched -- see its own comment -- so a caller can
	// show a Logs progress bar for a long conversation's re-embedding.
	async embedAll(transcript, onProgress) {
		this.reset();
		if (!transcript.length) return;
		try {
			let embeddings = await LLMCitation.embedBatched(transcript.map(entry => entry.text), undefined, undefined, { onProgress });
			transcript.forEach((entry, i) => {
				if (embeddings[i]) this._embeddings.set(this._fingerprint(entry), embeddings[i]);
			});
		}
		catch (e) {
			this.log(`embedAll: failed: ${e.message}`);
		}
	},

	// Returns the union of the last `lastK` transcript entries (plain
	// recency, identical to the existing "last-k" mode's own
	// `slice(-lastK)`) and the `topL` entries with the highest cosine
	// similarity to `query` among whichever entries have a stored embedding
	// -- re-sorted back into original transcript (chronological) order and
	// de-duplicated, since the model reads conversation history far more
	// coherently in its own original order than as a jumbled
	// most-relevant-first list, even though "most relevant" is how the
	// semantic half got selected in the first place.
	async selectRelevant(transcript, query, lastK, topL) {
		if (!transcript.length) return [];
		let selected = new Set();
		for (let i = Math.max(0, transcript.length - lastK); i < transcript.length; i++) selected.add(i);

		if (topL > 0) {
			try {
				let queryEmbedding = await LLMCitation.getEmbedding(query);
				let scored = [];
				transcript.forEach((entry, i) => {
					let embedding = this._embeddings.get(this._fingerprint(entry));
					if (embedding) scored.push({ i, score: LLMCitation.cosineSimilarity(queryEmbedding, embedding) });
				});
				scored.sort((a, b) => b.score - a.score);
				for (let { i } of scored.slice(0, topL)) selected.add(i);
			}
			catch (e) {
				this.log(`selectRelevant: query embedding failed: ${e.message}`);
			}
		}

		return [...selected].sort((a, b) => a - b).map(i => transcript[i]);
	},
};
