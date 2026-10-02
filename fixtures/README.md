# The research corpus

ScaffoldBench's research tasks never touch the live web. They run against `corpus/`, a frozen
snapshot of 26 public documents, so every architecture searches the same pages, gets the same
ranking for the same query, and reads the same text. A comparison between two architectures on
two different webs would not be a comparison.

```
fixtures/
  NOTICE.md                 source, licence and attribution of every document (generated)
  corpus/manifest.json      URL, aliases, title, publisher, licence, retrieval time and sha256 per document
  corpus/docs/<id>.txt      the extracted text an agent reads
```

## What a task sees

Each research task names the documents its web consists of, by role
(`packages/tasks/src/research/tasks.ts`, `breadthTasks.ts`):

- **primary**: the authoritative sources the gold answer comes from (RFC 9110, NIST SP 800-63B-4, …);
- **secondary**: reliable restatements such as MDN and web.dev;
- **superseded**: earlier versions the primary sources replaced (RFC 7231, NIST SP 800-63B rev. 3),
  kept on purpose because confusing them with the current version is a real research failure;
- **distractor**: plausible but off-target pages.

`search` ranks only that task's documents with BM25 (`bm25.ts`: plain lexical ranking, with no
authority or recency prior, so an obsolete RFC can outrank the current one exactly as it can on the
real web). `fetch_page` returns exactly the document a URL addresses: its canonical URL or one of its
listed aliases (other renderings of the same RFC, the address an MDN page moved from). Anything else is
a 404. There is no closest-match substitution. Long documents are read a window at a time with
`offset`, or by jumping to a phrase with `find`.

The scorer reads the same files. A quote counts as evidence only if it has at least six consecutive
words (an ellipsis may shorten a quote, not assemble one), occurs word for word in the page it cites,
that page was opened by a successful `fetch_page` during the run, and one of the run's tool
calls displayed that passage: a window it read, a `find` context or a search snippet, with at most five
words running past the edge of what was shown. A sentence recalled from memory does not count, even from
a page the run opened. The scorer replays the tool journal against the corpus to know what was shown (see
`packages/tasks/src/research/citations.ts`).

## Integrity

The corpus is frozen. `Corpus.load` verifies every document against its manifest checksum and refuses
a hand-edited file, because every research run records the hash of the documents its task could see
(`scoreMetadata.corpus.hash`), and that hash must describe the text the run actually read.

The tests in `packages/tasks/test/researchCorpus.test.ts` check that the manifest matches the curated
source list, that every document is credited in `NOTICE.md`, and, for every task, that each rubric
claim's supporting passage and each gold-key quote is present in that task's corpus, inside the section
the key points at.

## Rebuilding

```bash
npx tsx scripts/build-corpus.ts                  # refetch everything (one request at a time)
npx tsx scripts/build-corpus.ts --only rfc9110   # refetch some documents, keep the rest
npx tsx scripts/build-corpus.ts --verify         # refetch and compare with the snapshot; writes nothing
npm run check
```

`--verify` is the reproducibility check: it rebuilds every document from its source with the committed
extractor and reports which no longer match the manifest checksum; it exits 1 if any differ. When
version 2 was committed, all 26 documents rebuilt byte for byte. A difference later means a source page
has changed since the snapshot, not that the corpus was edited (`Corpus.load` refuses an edited file).

The source list, with each document's URL, licence and extraction rule, lives in
`packages/tasks/src/research/sources.ts`. A rebuild is a new snapshot: standards and documentation
change, so run the tests afterwards. If the sufficiency tests fail, a gold answer no longer matches the
web it is graded against, and the task has to be re-keyed before it can be scored. The script writes
nothing until every fetch has succeeded, so a failed rebuild leaves the committed corpus intact.

## Licensing

These documents are third-party works and are **not** covered by the repository's MIT licence. Sources
were chosen for redistributability: IETF RFCs (IETF Trust Legal Provisions), NIST publications (U.S.
Government works), the WHATWG HTML Standard and web.dev articles (CC BY 4.0), and MDN Web Docs and OWASP
cheat sheets (CC BY-SA, redistributed under the same licence). `NOTICE.md` lists each one.
