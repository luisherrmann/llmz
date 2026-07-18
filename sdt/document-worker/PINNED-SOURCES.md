# Fetched sources

`src/`, `scripts/pdfjs-resolve.js`, `scripts/pdfjs-setup.js`, `pdf.js/`, and
`structured-document-text/` in this directory are **not committed to this
repo**. They're fetched at install time by [`fetch-sources.js`](fetch-sources.js)
(run automatically via `npm install`'s `postinstall` script) from
[zotero/document-worker](https://github.com/zotero/document-worker),
[zotero/pdf.js](https://github.com/zotero/pdf.js), and
[zotero/structured-document-text](https://github.com/zotero/structured-document-text),
pinned at the commits below.

| Component | Commit | Date | Subject |
|---|---|---|---|
| `document-worker` (`src/`, `scripts/pdfjs-resolve.js`, `scripts/pdfjs-setup.js`) | [`05287e4b8d9f2e1fd3fc81b02fbd864b9cc010e1`](https://github.com/zotero/document-worker/commit/05287e4b8d9f2e1fd3fc81b02fbd864b9cc010e1) | 2026-06-12 | SDT: Bundle reader module in build |
| `pdf.js` (`src/`, select `external/` asset dirs) | [`553a34b3010f7826b50b321350e08ebf14a5bd0d`](https://github.com/zotero/pdf.js/commit/553a34b3010f7826b50b321350e08ebf14a5bd0d) | 2026-06-05 | Optimize document-worker text extraction |
| `structured-document-text` (`src/`) | [`5a6c392ef1995fd5131d0baa6bedebbfc21c8c5e`](https://github.com/zotero/structured-document-text/commit/5a6c392ef1995fd5131d0baa6bedebbfc21c8c5e) | 2026-06-12 | Remove Zotero-specific build script |

`fetch-sources.js` copies exactly the same subpaths listed above -- not the
full upstream repos, and not their build tooling, tests, or docs, none of
which the plugin's Node-subprocess pipeline needs. `package.json`,
`package-lock.json`, `postinstall.js`, and `fetch-sources.js` in this
directory are LLMz's own -- they pin the runtime npm dependencies
(`pako`, `fastest-levenshtein`, `@napi-rs/canvas`) the fetched code needs
under Node, which upstream doesn't ship as a standalone package. See the
main [README](../../README.md#requirements).

## Why fetched, not vendored

`document-worker` is licensed AGPL-3.0 (see the `COPYING` fetched into this
directory) and `pdf.js` is Apache-2.0 (see the `LICENSE` fetched into
`pdf.js/`). Copying that source into this repo and shipping it as part of
LLMz's own distribution would make LLMz a conveyor of a combined work,
which would require LLMz itself to be licensed AGPL-3.0. Fetching it at
install time instead means each user obtains it directly from its own
license holder -- LLMz's own code stays under its own
[LICENSE](../../LICENSE) (MIT). See the main README's License section for
more on this, including the still-open question of
`structured-document-text`'s license (it publishes no LICENSE/COPYING file
upstream -- see [`structured-document-text/NOTICE.md`](structured-document-text/NOTICE.md),
written by `fetch-sources.js`, once fetched).

## Updating the pins

To pick up a newer upstream commit:

1. Update the commit hashes in the `REPOS` array in
   [`fetch-sources.js`](fetch-sources.js).
2. Update the commit table above to match.
3. Delete `.source-pins.json` and re-run `npm install` (or `node
   fetch-sources.js` directly) to fetch the new pins.
4. Run the extraction pipeline against a sample PDF to confirm nothing
   broke (see the main README's testing notes).
