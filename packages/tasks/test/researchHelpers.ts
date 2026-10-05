import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { JournaledToolSpec, ToolCall } from '@scaffoldbench/core';
import {
  CORPUS_DIRNAME,
  CORPUS_MANIFEST,
  documentFile,
  sha256,
  type CorpusDocumentRecord,
  type CorpusManifest,
} from '../src/research/corpus';

/** A document for a test corpus; everything but `id`, `url` and `text` is defaulted. */
export interface TestDocument {
  id: string;
  url: string;
  text: string;
  aliases?: string[];
  title?: string;
}

/**
 * Write a corpus the way `scripts/build-corpus.ts` does, under
 * `<fixtureDir>/corpus`, and return `fixtureDir`. Each test should use a fresh
 * directory: `Corpus.load` caches by path for the life of the process.
 */
export function writeCorpus(fixtureDir: string, documents: TestDocument[]): string {
  const dir = path.join(fixtureDir, CORPUS_DIRNAME);
  mkdirSync(path.join(dir, 'docs'), { recursive: true });
  const records: CorpusDocumentRecord[] = documents.map((document) => {
    writeFileSync(documentFile(dir, document.id), document.text, 'utf8');
    return {
      id: document.id,
      url: document.url,
      aliases: document.aliases ?? [],
      title: document.title ?? `Title of ${document.id}`,
      publisher: 'Test publisher',
      license: 'cc-by-4.0',
      fetchedFrom: document.url,
      retrievedAt: '2026-10-01T00:00:00.000Z',
      sha256: sha256(document.text),
      chars: document.text.length,
    };
  });
  const manifest: CorpusManifest = { version: 1, snapshot: '2026-10-01', documents: records };
  writeFileSync(path.join(dir, CORPUS_MANIFEST), JSON.stringify(manifest, null, 2), 'utf8');
  return fixtureDir;
}

export interface Reply {
  text: string;
  isError: boolean;
}

/**
 * Call a tool handler exactly as the journaling MCP wrapper does: the reply
 * goes back to the caller, and a journal entry records the call and whether
 * it succeeded.
 */
export async function callTool(
  tools: readonly JournaledToolSpec[],
  journal: ToolCall[],
  name: string,
  args: Record<string, unknown>,
): Promise<Reply> {
  const spec = tools.find((candidate) => candidate.name === name);
  if (!spec) throw new Error(`no tool named ${name}`);
  const reply = await spec.handler(args);
  const result = typeof reply === 'string' ? { text: reply, isError: false } : { text: reply.text, isError: reply.isError === true };
  journal.push({ name, args, tMs: journal.length, ok: !result.isError, result: result.text.slice(0, 2_000) });
  return result;
}

/** A finished answer: prose followed by the fenced JSON block research answers end with. */
export function answerWithBlock(prose: string, block: unknown): string {
  return `${prose}\n\n\`\`\`json\n${JSON.stringify(block, null, 2)}\n\`\`\``;
}
