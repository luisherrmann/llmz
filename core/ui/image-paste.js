// Images pasted (⌘V) into the prompt textarea, shown as a row of removable
// thumbnails and attached as context for the next request(s). Split out of
// chat-pane.js's onRender for the same reason as the other ui/ modules.
LLMUIImagePaste = {
	// Capped at maxPastedImages since providers' per-request image limits,
	// while generous, aren't unlimited, and a runaway paste of a large batch
	// would silently balloon request size/cost. Not cleared on submit
	// (matching the existing behavior of the text input itself, which also
	// isn't cleared) -- images stay attached across turns until removed via
	// the thumbnail's "x" or the "Discard All" button, so a follow-up
	// question about the same image(s) doesn't require re-pasting.
	maxPastedImages: 10,

	async _fingerprintDataUri(dataUri) {
		let digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(dataUri));
		return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
	},

	// Wires up paste-to-attach on `input` (the prompt textarea). Returns:
	//   row            -- the thumbnail row <div> to place in the pane layout
	//   discardButton  -- a "Discard All" <button>, placed separately (e.g.
	//                     in a button row alongside Submit/Stop) rather than
	//                     inside `row` itself
	//   getDataUris()  -- a fresh snapshot of the currently attached images'
	//                     data URIs, for the caller to read when building a
	//                     request
	// `onMessage(text)` is called for user-facing status text ("That image
	// is already attached.", the per-request limit message) -- routing this
	// (e.g. to the Logs panel) is the caller's concern, not this module's.
	// `discardIconURL` is a plain file:/jar: URL (see chat-pane.js's
	// onRender, rootURI + "res/icons/remove_selection_*.svg"), rendered via
	// LLMUIIcon.create.
	create(doc, input, onMessage, discardIconURL) {
		// Each entry is { dataUri, fingerprint } -- fingerprint is a SHA-256
		// hash of the data URI, used to silently skip re-adding an image
		// that's already attached (e.g. pasting the same screenshot twice).
		let pastedImages = [];

		let row = doc.createElement("div");
		row.className = "llm-images-row";
		row.hidden = true;

		let discardButton = doc.createElement("button");
		discardButton.className = "llm-discard-images";
		discardButton.disabled = true;
		discardButton.append(LLMUIIcon.create(doc, discardIconURL), doc.createTextNode("Discard All"));
		discardButton.title = "Remove all attached images";

		let render = () => {
			row.innerHTML = "";
			row.hidden = pastedImages.length === 0;
			discardButton.disabled = pastedImages.length === 0;
			for (let [index, { dataUri }] of pastedImages.entries()) {
				let thumb = doc.createElement("div");
				thumb.className = "llm-image-thumb";
				let img = doc.createElement("img");
				img.src = dataUri;
				let removeButton = doc.createElement("span");
				removeButton.className = "llm-image-thumb-remove";
				removeButton.textContent = "×";
				removeButton.title = "Remove image";
				removeButton.addEventListener("click", () => {
					pastedImages.splice(index, 1);
					render();
				});
				thumb.append(img, removeButton);
				row.appendChild(thumb);
			}
		};

		discardButton.addEventListener("click", () => {
			pastedImages = [];
			render();
		});

		input.addEventListener("paste", async (e) => {
			let items = e.clipboardData?.items;
			if (!items) return;
			let imageItems = Array.from(items).filter(item => item.kind === "file" && item.type.startsWith("image/"));
			if (!imageItems.length) return;
			// Only swallow the paste when it actually carries an image --
			// clipboard content that's just text should still paste normally.
			e.preventDefault();
			for (let item of imageItems) {
				if (pastedImages.length >= this.maxPastedImages) {
					onMessage?.(`You can attach up to ${this.maxPastedImages} images at once.`);
					break;
				}
				let blob = item.getAsFile();
				if (!blob) continue;
				let dataUri = await new Promise((resolve, reject) => {
					let reader = new FileReader();
					reader.onload = () => resolve(reader.result);
					reader.onerror = () => reject(reader.error);
					reader.readAsDataURL(blob);
				});
				let fingerprint = await this._fingerprintDataUri(dataUri);
				if (pastedImages.some(img => img.fingerprint === fingerprint)) {
					onMessage?.("That image is already attached.");
					continue;
				}
				pastedImages.push({ dataUri, fingerprint });
				render();
			}
		});

		return {
			row,
			discardButton,
			getDataUris: () => pastedImages.map(img => img.dataUri),
		};
	},
};
