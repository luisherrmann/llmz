<p align="center">
  <img src="res/img/LLMz.svg" alt="LLMz" width="300">
</p>

<p align="center">
  Chat with any PDF open in Zotero's reader, grounded in the paper's own tables, figures, equations, notes, and bibliography.
</p>

---

**LLMz** is a Zotero 7 item-pane plugin that adds an LLM chat pane next to the reader. Ask a question about the paper you're reading and it automatically pulls in whichever tables, figures, equations, your own highlights/notes, and bibliography entries are actually relevant, then answers with clickable citations that jump straight to the right spot in the PDF.

## Features

- **Multi-provider** — Ollama, LM Studio, and LiteLLM for local/self-hosted models, plus OpenAI and Anthropic directly. Switch providers and models at any time; vision support is detected per model.
- **PDF-grounded chat** — tables, figures, equations, your own annotations, and the paper's bibliography are extracted automatically and offered to the model as context, with a single tool-calling round-trip deciding what's actually relevant to your question.
- **Clickable citations** — the model's answer links back to `[Table N]`, `[Figure N]`, notes, and page numbers; clicking one jumps the reader to that exact spot.
- **Reference tools** — ask in plain language to download a bibliography entry into your library (with a PDF attached when one can be found), or link it to an item you already have.
- **Table export** — pull one, several, or all of a paper's tables out as CSV files bundled into a zip, image-grounded when the model supports vision.
- **Conversation history** — every chat is saved as markdown per PDF, browsable, exportable, and importable.
- **Image paste** — attach a screenshot or clipping directly into a chat turn.
- **Keyboard-driven** — shortcuts for submit, stop, and history navigation (see the in-pane "Keyboard Shortcuts" panel).

## Requirements

- Zotero 7.
- A running LLM backend: [Ollama](https://ollama.com) or [LM Studio](https://lmstudio.ai) locally, a [LiteLLM](https://www.litellm.ai) proxy, or an OpenAI/Anthropic API key.
- Node.js, for the bundled document-structure pipeline (`sdt/document-worker/`) used to extract equations, references, and notes.
- A Python 3 virtual environment at `~/Zotero/LLMz/venv`, used to extract and crop tables and figures, with dependencies from [`requirements.txt`](requirements.txt):
  ```bash
  python3 -m venv ~/Zotero/LLMz/venv
  ~/Zotero/LLMz/venv/bin/pip install -r requirements.txt
  ```

## Installation

1. Download the latest `llmz.xpi`, or build one yourself from source:
   ```bash
   cd plugins/llm-chat-pane
   zip -r build/llmz.xpi . -x ".*" -x "*.xpi" -x "scripts/__pycache__/*"
   ```
2. In Zotero, go to **Tools → Add-ons**, click the gear icon, choose **Install Add-on From File...**, and select the `.xpi`.
3. Restart Zotero.

## Setup

1. Open **Preferences → LLMz** (or the pane's own "Providers" panel) and pick a provider.
   - For a local server (Ollama/LM Studio/LiteLLM), set its host/port if it isn't running on the default.
   - For OpenAI/Anthropic, enter an API key.
2. Open a PDF in the reader — the LLMz pane appears in the item pane alongside it.
3. Pick a model from the dropdown and start asking questions.

## Usage

Just type a question about the paper in the chat box. Depending on what you ask, LLMz will:

- Pull in matching tables, figures, equations, notes, and/or the bibliography as context before answering.
- Recognize a request to **download** or **link** a specific reference ("download reference 12 into my library", "link everything by Smith to my library").
- Recognize a request to **export tables** ("export table 3 as CSV", "export all tables").

Click any `[Table N]` / `[Figure N]` / page-number link in a response to jump to that spot in the reader.

## Project structure

```
core/                    Plugin logic
core/document/           PDF content extraction: tables, figures, equations, references, notes
core/ui/                 Chat pane UI components (chat log, provider settings, history, etc.)
core/interfaces.js       Talks to the actual model backends (Ollama, LM Studio, LiteLLM, OpenAI, Anthropic)
core/prompt.js           Prompt construction and context selection
core/request.js          Orchestrates a single chat request end to end
core/intent.js           Routes a message to a tool (download/link/export) or normal chat
core/chat-pane.js        Main plugin entry point (item pane registration, onRender)
core/citation.js         Citation-index building and cosine-similarity search
tools/                   Native tool-calling features: reference download/link, table export
res/icons/, res/img/     SVG icons and the LLMz logo
styles/style.css         Pane stylesheet
sdt/document-worker      Vendored ML-based PDF layout classification pipeline
scripts/                 Python/Node extraction scripts run as subprocesses
```

## License

[MIT](LICENSE) © 2026 Luis Herrmann
