// Fetches Zotero's document-worker, pdf.js, and structured-document-text
// sources at pinned commits and copies the subpaths LLMz's Node pipeline
// needs into place. Run at install time (via the "postinstall" script in
// package.json) rather than committed to this repo, so LLMz never conveys
// their (AGPL-3.0 / Apache-2.0) source itself -- see PINNED-SOURCES.md and
// the main README's License section for why.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, cpSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

// pdf.js's external/ carries one subdir per third-party asset (fonts,
// cmaps, brotli tables, ...), each with its own bundled license. Only the
// ones the pipeline actually loads at runtime are copied -- not pdf.js's
// own build tooling (builder/, chromium/, eslint_plugins/, ...).
const PDFJS_EXTERNAL_DIRS = [
	'bcmaps', 'brotli', 'cmapscompress', 'iccs', 'jbig2',
	'openjpeg', 'qcms', 'quickjs', 'standard_fonts',
];

const REPOS = [
	{
		name: 'document-worker',
		url: 'https://github.com/zotero/document-worker.git',
		commit: '05287e4b8d9f2e1fd3fc81b02fbd864b9cc010e1',
		copy: [
			['src', 'src'],
			['scripts/pdfjs-resolve.js', 'scripts/pdfjs-resolve.js'],
			['scripts/pdfjs-setup.js', 'scripts/pdfjs-setup.js'],
			['COPYING', 'COPYING'],
		],
	},
	{
		name: 'pdf.js',
		url: 'https://github.com/zotero/pdf.js.git',
		commit: '553a34b3010f7826b50b321350e08ebf14a5bd0d',
		copy: [
			['src', 'pdf.js/src'],
			...PDFJS_EXTERNAL_DIRS.map(dir => [`external/${dir}`, `pdf.js/external/${dir}`]),
			['LICENSE', 'pdf.js/LICENSE'],
		],
	},
	{
		name: 'structured-document-text',
		url: 'https://github.com/zotero/structured-document-text.git',
		commit: '5a6c392ef1995fd5131d0baa6bedebbfc21c8c5e',
		copy: [['src', 'structured-document-text/src']],
	},
];

// zotero/structured-document-text publishes no LICENSE/COPYING as of the
// pinned commit above. This is not a license grant -- it's a record of that
// gap so it isn't silently lost. See PINNED-SOURCES.md.
const STRUCTURED_DOCUMENT_TEXT_NOTICE = `Upstream zotero/structured-document-text does not publish a LICENSE or
COPYING file as of commit 5a6c392ef1995fd5131d0baa6bedebbfc21c8c5e (verified
via GitHub's license API, which also reports none). LLMz fetches and uses
this code on the assumption that it is licensed the same as its sibling
Zotero repositories (AGPL-3.0), pending confirmation from the Corporation
for Digital Scholarship. Do not treat this file as a substitute for an
actual license grant. See ../PINNED-SOURCES.md.
`;

const PIN_FILE = '.source-pins.json';
const currentPins = Object.fromEntries(REPOS.map(r => [r.name, r.commit]));
// Every copy destination across all repos -- used below to confirm the
// fetched output is actually still on disk, not just that the pin file
// says it should be (e.g. after a manual `rm -rf` of the fetched dirs
// without also deleting .source-pins.json, npm install would otherwise
// report success while leaving the pipeline's own source missing).
const allTargets = REPOS.flatMap(repo => repo.copy.map(([, to]) => to));

function alreadyUpToDate() {
	if (!existsSync(PIN_FILE)) return false;
	try {
		if (JSON.stringify(JSON.parse(readFileSync(PIN_FILE, 'utf8'))) !== JSON.stringify(currentPins)) {
			return false;
		}
	}
	catch {
		return false;
	}
	return allTargets.every(existsSync);
}

if (alreadyUpToDate()) {
	console.log('Fetched sources already up to date, skipping fetch.');
	process.exit(0);
}

for (const repo of REPOS) {
	console.log(`Fetching ${repo.name} @ ${repo.commit.slice(0, 12)}...`);
	let tmp = mkdtempSync(join(tmpdir(), `llmz-fetch-${repo.name}-`));
	try {
		execFileSync('git', ['clone', '--quiet', '--no-tags', repo.url, tmp]);
		execFileSync('git', ['checkout', '--quiet', repo.commit], { cwd: tmp });
		for (let [from, to] of repo.copy) {
			let src = join(tmp, from);
			if (!existsSync(src)) {
				console.warn(`  skip ${from} (not found at this commit)`);
				continue;
			}
			mkdirSync(dirname(to), { recursive: true });
			cpSync(src, to, { recursive: true });
		}
	}
	finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

mkdirSync('structured-document-text', { recursive: true });
writeFileSync('structured-document-text/NOTICE.md', STRUCTURED_DOCUMENT_TEXT_NOTICE);

writeFileSync(PIN_FILE, JSON.stringify(currentPins, null, 2) + '\n');
console.log('Sources fetched.');
