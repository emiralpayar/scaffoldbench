/**
 * Build the frozen research corpus.
 *
 * Fetches every source in `packages/tasks/src/research/sources.ts` once,
 * extracts its readable text, and writes:
 *
 *   fixtures/corpus/docs/<id>.txt    the text an agent reads
 *   fixtures/corpus/manifest.json    URL, aliases, title, licence, retrieval time, sha256
 *   fixtures/NOTICE.md               source, licence and attribution for every document
 *
 * This is the only part of ScaffoldBench that touches the network for
 * research, and it runs by hand, never during a benchmark. Requests go out one
 * at a time with a pause between them and an identifying User-Agent.
 *
 *   npx tsx scripts/build-corpus.ts                 # rebuild everything
 *   npx tsx scripts/build-corpus.ts --only rfc9110  # refetch some documents, keep the rest
 *   npx tsx scripts/build-corpus.ts --notice        # regenerate NOTICE.md only, offline
 *
 * A rebuild is a new snapshot: answers graded against it can change, so run
 * the research tests afterwards — the sufficiency test fails when a gold
 * answer's quote is no longer in the corpus.
 */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FIXTURES_DIR } from '@arena/core';
import {
  CORPUS_DIRNAME,
  CORPUS_MANIFEST,
  documentFile,
  sha256,
  type CorpusDocumentRecord,
  type CorpusManifest,
} from '@arena/tasks/research/corpus';
import { extractDocument } from '@arena/tasks/research/extract';
import { CORPUS_SOURCES, LICENSES, type CorpusSource } from '@arena/tasks/research/sources';

/** Bump when the source list or the extraction rules change what the corpus contains. */
const CORPUS_VERSION = 1;
const USER_AGENT =
  'ScaffoldBench-corpus-builder/1.0 (one-time snapshot of public documents for an open-source agent benchmark)';
const PAUSE_MS = 1_500;
const TIMEOUT_MS = 30_000;
const ATTEMPTS = 3;
/** A page that extracts to less than this is a broken extractor, not a short page. */
const MIN_CHARS = 1_000;

const corpusDir = path.join(FIXTURES_DIR, CORPUS_DIRNAME);

async function main(): Promise<void> {
  const previous = await readPrevious();
  if (process.argv.includes('--notice')) {
    // Regenerate NOTICE.md from the existing manifest, without the network.
    if (!previous) throw new Error('--notice needs an existing manifest.');
    await writeFile(path.join(FIXTURES_DIR, 'NOTICE.md'), renderNotice(previous), 'utf8');
    return;
  }

  const only = parseOnly(process.argv.slice(2));
  if (only && !previous) throw new Error('--only needs an existing manifest to update.');

  const unknown = [...(only ?? [])].filter((id) => !CORPUS_SOURCES.some((s) => s.id === id));
  if (unknown.length > 0) throw new Error(`Unknown source id(s): ${unknown.join(', ')}`);

  await mkdir(path.join(corpusDir, 'docs'), { recursive: true });
  const records: CorpusDocumentRecord[] = [];

  let first = true;
  for (const source of CORPUS_SOURCES) {
    const kept = previous?.documents.find((record) => record.id === source.id);
    if (only && !only.has(source.id) && kept) {
      records.push({ ...kept, ...describe(source), fetchedFrom: kept.fetchedFrom });
      continue;
    }

    if (!first) await sleep(PAUSE_MS);
    first = false;

    const fetchUrl = source.fetchUrl ?? source.url;
    process.stdout.write(`${source.id.padEnd(36)} ${fetchUrl}\n`);
    const raw = await fetchText(fetchUrl);
    const { text } = extractDocument(raw, source.extract);
    check(source, text);

    await writeFile(documentFile(corpusDir, source.id), text, 'utf8');
    records.push({
      ...describe(source),
      fetchedFrom: fetchUrl,
      retrievedAt: new Date().toISOString(),
      sha256: sha256(text),
      chars: text.length,
    });
    process.stdout.write(`${''.padEnd(36)} ${text.length.toLocaleString('en-US')} characters\n`);
  }

  // Files from sources that have since been removed from the list.
  const wanted = new Set(records.map((record) => `${record.id}.txt`));
  for (const name of await readdir(path.join(corpusDir, 'docs'))) {
    if (!wanted.has(name)) await rm(path.join(corpusDir, 'docs', name));
  }

  const manifest: CorpusManifest = {
    version: CORPUS_VERSION,
    snapshot: snapshotDate(records),
    documents: records,
  };
  await writeFile(path.join(corpusDir, CORPUS_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(path.join(FIXTURES_DIR, 'NOTICE.md'), renderNotice(manifest), 'utf8');
  process.stdout.write(`\nWrote ${records.length} documents to ${path.relative(process.cwd(), corpusDir)}.\n`);
}

function describe(
  source: CorpusSource,
): Omit<CorpusDocumentRecord, 'fetchedFrom' | 'retrievedAt' | 'sha256' | 'chars'> {
  return {
    id: source.id,
    url: source.url,
    aliases: source.aliases ?? [],
    title: source.title,
    publisher: source.publisher,
    license: source.license,
  };
}

/** Refuse output that is obviously not the article: empty, binary, or a bare shell page. */
function check(source: CorpusSource, text: string): void {
  if (text.length < MIN_CHARS) {
    throw new Error(`${source.id}: only ${text.length} characters extracted; check its extractor.`);
  }
  if (text.startsWith('%PDF') || text.includes('\u0000')) {
    throw new Error(`${source.id}: extracted text looks binary.`);
  }
}

/** The day the newest document was retrieved: a snapshot is as old as its freshest page. */
function snapshotDate(records: readonly CorpusDocumentRecord[]): string {
  const latest = records.map((record) => record.retrievedAt).sort().at(-1) ?? new Date().toISOString();
  return latest.slice(0, 10);
}

async function fetchText(url: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
          'accept-language': 'en-US,en;q=0.9',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.ok) return await response.text();
      lastError = new Error(`HTTP ${response.status}`);
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      lastError = error;
    }
    await sleep(PAUSE_MS * 2 ** attempt);
  }
  throw new Error(`Could not fetch ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function renderNotice(manifest: CorpusManifest): string {
  const lines = [
    '# Third-party documents in `fixtures/corpus/`',
    '',
    'The research tasks run against a frozen snapshot of public documents, so every architecture',
    'searches and reads the same web. This file lists every document redistributed here, where it',
    'came from, when it was retrieved, and the licence it is redistributed under.',
    '',
    '**These documents are not covered by the repository’s MIT licence.** Each remains under its own',
    'licence, listed below. Changes made: every document was converted from its published HTML or',
    'plain-text rendering to plain text; page furniture (site navigation, headers, footers, sidebars,',
    'feedback widgets) was removed; list items and table cells are marked with plain-text separators.',
    'Section numbers that pages.nist.gov displays through CSS are written into its headings, and older',
    'RFCs lose their print pagination. The wording of the documents is not otherwise altered.',
    '',
    `Corpus version ${manifest.version}, snapshot ${manifest.snapshot}, ${manifest.documents.length} documents.`,
    'Generated by `scripts/build-corpus.ts`; do not edit by hand.',
    '',
    '## Licences',
    '',
  ];
  const used = [...new Set(manifest.documents.map((record) => record.license))].sort();
  for (const id of used) {
    const license = LICENSES[id as keyof typeof LICENSES];
    if (!license) throw new Error(`Unknown licence ${id}`);
    lines.push(`- **${license.name}** (<${license.url}>). ${license.terms}`);
  }
  lines.push('', '## Documents', '');

  const sources = new Map(CORPUS_SOURCES.map((source) => [source.id, source]));
  for (const record of [...manifest.documents].sort((a, b) => a.id.localeCompare(b.id))) {
    const source = sources.get(record.id);
    const license = LICENSES[record.license as keyof typeof LICENSES];
    lines.push(
      `### \`${record.id}\``,
      '',
      `- **Title:** ${record.title}`,
      `- **Source:** <${record.url}>${record.fetchedFrom !== record.url ? ` (text fetched from <${record.fetchedFrom}>)` : ''}`,
      `- **Publisher:** ${record.publisher}`,
      `- **Licence:** ${license?.name ?? record.license}`,
      `- **Attribution:** ${source?.attribution ?? record.title}`,
      `- **Retrieved:** ${record.retrievedAt}`,
      `- **File:** \`corpus/docs/${record.id}.txt\` (sha256 \`${record.sha256.slice(0, 16)}…\`)`,
      '',
    );
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

async function readPrevious(): Promise<CorpusManifest | undefined> {
  try {
    return JSON.parse(await readFile(path.join(corpusDir, CORPUS_MANIFEST), 'utf8')) as CorpusManifest;
  } catch {
    return undefined;
  }
}

function parseOnly(argv: string[]): Set<string> | undefined {
  const index = argv.indexOf('--only');
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value) throw new Error('--only needs a comma-separated list of source ids.');
  return new Set(value.split(',').map((id) => id.trim()).filter(Boolean));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
