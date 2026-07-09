// Builds one masked icon <span> (see style.css's shared .llm-icon class --
// CSS mask-image + background-color: currentColor, so the icon's visible
// color always exactly matches whatever text it sits next to, regardless of
// the source SVG file's own hardcoded fill, and rendering doesn't depend on
// how this chrome context happens to parse raw SVG markup injected via
// innerHTML). Pulled out as its own tiny module once this exact
// span-plus-mask-image construction started repeating across
// ui/past-conversations.js (edit/done_outline), ui/provider-model-select.js
// (refresh), and ui/button-row.js/ui/image-paste.js (send/cancel/delete/
// upload/file_export/remove_selection).
LLMUIIcon = {
	// `iconURL` is a plain file:/jar: URL (see llm-chat-pane.js's onRender,
	// rootURI + "icons/*.svg"). Falls back to a plain, imageless span if
	// omitted, rather than throwing -- same as every call site's previous
	// `if (iconURL) ...` guard.
	create(doc, iconURL) {
		let icon = doc.createElement("span");
		icon.className = "llm-icon";
		if (iconURL) icon.style.maskImage = `url("${iconURL}")`;
		return icon;
	},
};
