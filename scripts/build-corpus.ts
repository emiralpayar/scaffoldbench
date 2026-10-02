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
 * at a time with a pause between them and an identifying User-Agent; a
 * server's `Retry-After` is honoured. Nothing is written until every fetch has
 * succeeded, so a failed rebuild leaves the committed corpus as it was.
 *
 *   npx tsx scripts/build-corpus.ts                 # rebuild everything
 *   npx tsx scripts/build-corpus.ts --only rfc9110  # refetch some documents, keep the rest
 *   npx tsx scripts/build-corpus.ts --verify        # refetch and compare, write nothing
 *   npx tsx scripts/build-corpus.ts --notice        # regenerate NOTICE.md only, offline
 *
 * `--verify` is the reproducibility check: it rebuilds every document (or the
 * `--only` ones) from its source and reports which no longer match the
 * committed checksum, exiting 1 if any differ. A difference means the source
 * has changed since the snapshot (or the extractor has), not that the corpus
 * was edited — `Corpus.load` already refuses that.
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
const CORPUS_VERSION = 2;
const USER_AGENT =
  'ScaffoldBench-corpus-builder/1.0 (one-time snapshot of public documents for an open-source agent benchmark)';
const PAUSE_MS = 1_500;
const TIMEOUT_MS = 30_000;
const ATTEMPTS = 3;
/** The longest `Retry-After` honoured; a server asking for more fails the build instead. */
const MAX_RETRY_AFTER_MS = 120_000;
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

  const verify = process.argv.includes('--verify');
  const only = parseOnly(process.argv.slice(2));
  if ((only || verify) && !previous) throw new Error('--only and --verify need an existing manifest.');

  const unknown = [...(only ?? [])].filter((id) => !CORPUS_SOURCES.some((s) => s.id === id));
  if (unknown.length > 0) throw new Error(`Unknown source id(s): ${unknown.join(', ')}`);

  // Fetch and extract everything first, in memory: a failure part-way through
  // must not leave new documents next to an old manifest, which Corpus.load
  // would then refuse.
  const records: CorpusDocumentRecord[] = [];
  const texts = new Map<string, string>();
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

    texts.set(source.id, text);
    records.push({
      ...describe(source),
      fetchedFrom: fetchUrl,
      retrievedAt: new Date().toISOString(),
      sha256: sha256(text),
      chars: text.length,
    });
    const verdict = !verify ? '' : kept?.sha256 === sha256(text) ? ', identical to the snapshot' : ', DIFFERENT from the snapshot';
    process.stdout.write(`${''.padEnd(36)} ${text.length.toLocaleString('en-US')} characters${verdict}\n`);
  }

  if (verify) {
    const changed = records.filter(
      (record) => texts.has(record.id) && previous?.documents.find((old) => old.id === record.id)?.sha256 !== record.sha256,
    );
    process.stdout.write(
      changed.length === 0
        ? `\nAll ${texts.size} documents rebuild byte for byte from their sources.\n`
        : `\n${changed.length} of ${texts.size} documents differ from the snapshot: ${changed.map((record) => record.id).join(', ')}.\n`,
    );
    process.exitCode = changed.length === 0 ? 0 : 1;
    return;
  }

  await mkdir(path.join(corpusDir, 'docs'), { recursive: true });
  for (const [id, text] of texts) await writeFile(documentFile(corpusDir, id), text, 'utf8');

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
  process.stdout.write(`\nWrote ${texts.size} of ${records.length} documents to ${path.relative(process.cwd(), corpusDir)}.\n`);
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
    let wait = PAUSE_MS * 2 ** attempt;
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
      const asked = retryAfterMs(response.headers.get('retry-after'));
      if (asked !== undefined) {
        if (asked > MAX_RETRY_AFTER_MS) break;
        wait = Math.max(wait, asked);
      }
    } catch (error) {
      lastError = error;
    }
    if (attempt < ATTEMPTS) await sleep(wait);
  }
  throw new Error(`Could not fetch ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

/** A `Retry-After` header, in seconds or as an HTTP date, as milliseconds from now. */
function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (header === null || header.trim() === '') return undefined;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
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
    'plain-text rendering to plain text. Page furniture (site navigation, page headers and footers,',
    'sidebars, tables of contents, ratings, feedback and survey widgets) was removed, as were images,',
    'inline SVG, embedded live examples, interactive controls and, from the HTML Standard, the MDN',
    'browser-support boxes the WHATWG site inserts beside the specification text. List items and table',
    'cells are marked with plain-text separators, and runs of blank lines are reduced to one. Section',
    'numbers that pages.nist.gov displays through CSS are written into its headings, the serving',
    'timestamp on the revision 3 page is dropped, and older RFCs lose their print pagination. The',
    'wording of the documents is not otherwise altered.',
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
