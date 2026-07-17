# Vendored third-party scripts

The files in this directory are committed verbatim (minified builds fetched
from their official CDN distribution, not built from source here). Each
retains its own copyright/license banner at the top of the file. All are
permissively licensed and compatible with LLMz's own [MIT license](../LICENSE)
-- no relicensing or attribution beyond what's already in each file is
required.

| File | Library | Version | License | Used for |
|---|---|---|---|---|
| `marked.min.js` | [marked](https://github.com/markedjs/marked) | 4.3.0 | MIT | Markdown rendering in the chat pane |
| `highlight.min.js` | [highlight.js](https://github.com/highlightjs/highlight.js) | 11.9.0 | BSD-3-Clause | Code block syntax highlighting |
| `atom-one-dark.min.css` | highlight.js "Atom One Dark" theme | 11.9.0 | BSD-3-Clause | Styling for the above (bundled with highlight.js, not separately licensed) |
| `katex.min.js` | [KaTeX](https://github.com/KaTeX/KaTeX) | 0.16.9 | MIT | Equation rendering |

## Updating

Each file's own top-of-file comment records the exact CDN URL it was
fetched from (e.g. `https://cdn.jsdelivr.net/npm/marked@4.3.0/marked.min.js`).
To bump a version, re-download from the same CDN path with the new version
number, confirm the license banner is still present, and update the table
above.
