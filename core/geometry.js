// Small rect-geometry primitive, used by scripts/match-captions.js (unioning
// a figure's/table's/preformatted region's own body bbox with its matched
// caption's bbox -- see extract-tables-sdt.js/extract-figures-sdt.js/
// extract-preformatted-sdt.js's own callers of pairWithCaptions/
// findNearbyCaption). Lives under core/ rather than scripts/ purely by
// historical accident of where it was first introduced -- despite that,
// this is a plain Node module now: no plugin-runtime (chrome-JS) code
// consumes it directly anymore (core/citation.js's own former caption-
// matching logic for 'preformatted' blocks moved into
// extract-preformatted-sdt.js itself, alongside detection -- see
// core/document/preformatted.js's own header comment), so this no longer
// needs shared-patterns.js's dual-load (UMD-style) bridge -- just a normal
// module.exports, loaded via match-captions.js's own createRequire bridge
// from its ESM side.
//
// For a packed .xpi install, this file still needs to be deployed to a real
// filesystem path (Node needs a real path, not a jar: URI) -- see
// core/document/references.js's own _siblingCoreFileNames, which this is
// listed in (a separate list from _siblingScriptNames since this lands at
// destDir/core/, not destDir/scripts/, mirroring its own source-tree
// location so match-captions.js's relative require() resolves the same way
// on both an unpacked and a packed install).
function unionRect(a, b) {
	return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

module.exports = { unionRect };
