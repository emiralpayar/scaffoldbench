import {
  auditCitations,
  buildScore,
  createJournaledToolServer,
  fetchedUrlsFromTrace,
  medianOf,
  normalizeUrl,
  sampleJudge,
  truncate,
  type EnvironmentOptions,
  type JudgeRequest,
  type Penalty,
  type ScoreInput,
  type ScoreItem,
  type Task,
  type TaskEnvironment,
  type TaskScore,
  type ToolCall,
  type TraceEvent,
} from '@arena/core';
import { createWebTools, hostMatches } from './webTools';

/** A single fact the answer must contain, checkable from the answer text alone. */
export interface ResearchRubricItem {
  id: string;
  claim: string;
  weight: number;
}

export interface ResearchTaskSpec {
  id: string;
  title: string;
  question: string;
  difficulty: 'easy' | 'medium' | 'hard';
  tags: string[];
  maxTurns: number;
  rubric: ResearchRubricItem[];
  /** Domains a thorough answer should have consulted, scored as coverage. */
  requiredSources?: string[];
  /** When set, `fetch_page` refuses anything outside these domains. */
  allowedDomains?: string[];
}

export const RESEARCH_POLICY = [
  'Research rules:',
  '- The `search` and `fetch_page` tools are your only access to the web. Any other browsing tool is unavailable.',
  '- Search snippets are previews, not sources. Open a page with `fetch_page` before relying on what it says.',
  '- Cite the URL of every source you rely on, inline, next to the claim it supports.',
  '- Never cite a URL you did not open with `fetch_page`. A citation to an unopened page is scored as a fabrication.',
  '- When sources disagree, say so explicitly and attribute each position, instead of silently picking one.',
  '- State what the sources say. Do not pad the answer with unsupported general knowledge.',
].join('\n');

const SERVER_INSTRUCTIONS =
  'Read-only web research tools. `search` ranks candidate sources; `fetch_page` returns the readable ' +
  'text of one page. Only pages opened with `fetch_page` may be cited.';

/** Share of the rubric weight given to consulting the expected sources. */
const SOURCE_COVERAGE_SHARE = 0.2;
const MAX_ANSWER_CHARS = 20_000;
const MAX_EVIDENCE_CHARS = 300;

type VerdictStatus = 'met' | 'partial' | 'missing';

const STATUS_SCORE: Record<VerdictStatus, number> = { met: 1, partial: 0.5, missing: 0 };

interface Verdict {
  id: string;
  status: VerdictStatus;
  evidence: string;
}

const VERDICT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The rubric item id being graded.' },
          status: { type: 'string', enum: ['met', 'partial', 'missing'] },
          evidence: {
            type: 'string',
            description: 'Short verbatim quote from the answer, or an empty string when missing.',
          },
        },
        required: ['id', 'status', 'evidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdicts'],
  additionalProperties: false,
};

/**
 * Build a research task scored by two independent halves.
 *
 * The rubric half asks a judge whether specific, pre-declared facts appear in
 * the answer, sampled and reduced by median so one unlucky grading cannot move
 * a strategy's number. The citation half needs no model at all: because every
 * retrieval went through our own tools, the trace says exactly which URLs were
 * opened, and any citation outside that set is a fabrication.
 */
export function defineResearchTask(spec: ResearchTaskSpec): Task {
  const rubricWeight = spec.rubric.reduce((total, item) => total + item.weight, 0);
  const coverageWeight = (rubricWeight > 0 ? rubricWeight : 1) * SOURCE_COVERAGE_SHARE;
  const requiredSources = (spec.requiredSources ?? []).map((domain) =>
    domain.trim().toLowerCase().replace(/^www\./, ''),
  );

  return {
    id: spec.id,
    category: 'research',
    world: 'web',
    title: spec.title,
    prompt: `${spec.question}\n\nResearch this with the provided web tools and write a complete, self-contained answer. Cite the URL of every source you rely on.`,
    policy: RESEARCH_POLICY,
    difficulty: spec.difficulty,
    tags: spec.tags,
    maxTurns: spec.maxTurns,

    createEnvironment(options: EnvironmentOptions): TaskEnvironment {
      const journal: ToolCall[] = [];
      const { createMcpServers, allowedTools } = createJournaledToolServer({
        name: 'web',
        instructions: SERVER_INSTRUCTIONS,
        journal,
        tools: createWebTools({
          fixtureMode: options.fixtureMode,
          fixtureDir: options.fixtureDir,
          ...(spec.allowedDomains ? { allowedDomains: spec.allowedDomains } : {}),
        }),
      });

      return {
        createMcpServers,
        allowedTools,
        // Research has nothing to mutate, so every tool is safe to hand to a
        // throwaway proposer. Equality here is what tells `propose-select` it can
        // skip a separate execute phase.
        readOnlyTools: [...allowedTools],
        state: { question: spec.question, requiredSources },
        journal,
      };
    },

    async score({ env, outcome, trace, deps }: ScoreInput): Promise<TaskScore> {
      const answer = outcome.finalText.trim();
      const metadata: Record<string, unknown> = {};

      const samples: Array<Map<string, Verdict>> = [];
      let judgeFailures = 0;

      if (answer === '') {
        // An empty answer cannot satisfy any rubric item, so skip paying the judge.
        metadata.emptyAnswer = true;
      } else {
        const { values, failures } = await sampleJudge<unknown>(
          deps.judge,
          buildJudgeRequest(spec, answer),
          deps.judgeSamples,
        );
        judgeFailures = failures;
        for (const value of values) samples.push(readVerdicts(value));
        if (samples.every((sample) => sample.size === 0)) metadata.judgeFailed = true;
      }
      metadata.judgeFailures = judgeFailures;

      const breakdown: ScoreItem[] = spec.rubric.map((item) => {
        const scores: number[] = [];
        let evidence = '';
        for (const sample of samples) {
          const verdict = sample.get(item.id);
          if (!verdict) continue;
          scores.push(STATUS_SCORE[verdict.status]);
          if (evidence === '' && verdict.evidence.trim() !== '') evidence = verdict.evidence.trim();
        }

        const detail =
          scores.length === 0
            ? samples.length > 0
              ? 'No judge returned a verdict for this item.'
              : undefined
            : truncate(evidence, MAX_EVIDENCE_CHARS) || undefined;

        return {
          id: item.id,
          label: item.claim,
          weight: item.weight,
          earned: medianOf(scores, 0),
          ...(detail ? { detail } : {}),
        };
      });

      const fetchedUrls = collectFetchedUrls(trace, env.journal);

      if (requiredSources.length > 0) {
        const hosts = fetchedUrls.map(hostOf).filter((host): host is string => host !== undefined);
        const missing = requiredSources.filter(
          (domain) => !hosts.some((host) => hostMatches(host, domain)),
        );
        const covered = requiredSources.length - missing.length;
        breakdown.push({
          id: 'source-coverage',
          label: `Consulted the expected sources (${requiredSources.join(', ')})`,
          weight: coverageWeight,
          earned: covered / requiredSources.length,
          detail:
            missing.length === 0
              ? 'All expected sources were opened.'
              : `Never opened: ${missing.join(', ')}`,
        });
        metadata.requiredSources = requiredSources;
        metadata.missingSources = missing;
      }

      const audit = auditCitations(outcome.finalText, fetchedUrls);
      const penalties: Penalty[] = [];
      if (audit.integrity < 1) {
        penalties.push({
          id: 'citation-integrity',
          label: 'Cited pages that were never opened',
          kind: 'hallucinated_citation',
          multiplier: 0.5 + 0.5 * audit.integrity,
          detail: `${audit.hallucinated.length} of ${audit.cited.length} cited URLs were never fetched: ${audit.hallucinated
            .slice(0, 5)
            .join(', ')}`,
        });
      }

      metadata.citedCount = audit.cited.length;
      metadata.verifiedCount = audit.verified.length;
      metadata.hallucinatedCount = audit.hallucinated.length;
      metadata.citationIntegrity = audit.integrity;
      metadata.hallucinatedUrls = audit.hallucinated;
      metadata.fetchedUrlCount = fetchedUrls.length;

      return buildScore({ breakdown, penalties, metadata });
    },
  };
}

function buildJudgeRequest(spec: ResearchTaskSpec, answer: string): JudgeRequest {
  const system = [
    'You grade research answers for a benchmark.',
    'Grade only what the answer actually says. Never use your own knowledge to fill a gap, and never',
    'give credit for something the answer merely implies or could plausibly have meant.',
    '"met" means the answer explicitly states the claim.',
    '"partial" means it states part of the claim but omits or garbles a required element.',
    '"missing" means the answer does not state it at all.',
    'Return exactly one verdict per rubric item, reusing the given ids verbatim.',
  ].join(' ');

  const prompt = [
    'QUESTION PUT TO THE AGENT',
    spec.question,
    '',
    'RUBRIC ITEMS TO GRADE',
    ...spec.rubric.map((item) => `- ${item.id}: ${item.claim}`),
    '',
    'ANSWER UNDER TEST (between the markers, grade nothing outside them)',
    '<<<ANSWER',
    truncate(answer, MAX_ANSWER_CHARS),
    'ANSWER>>>',
    '',
    'For each rubric item, return its id, a status of met/partial/missing, and evidence: a short',
    'verbatim quote from the answer supporting the status, or an empty string when the item is missing.',
  ].join('\n');

  return { system, prompt, schema: VERDICT_SCHEMA };
}

/** Defensive: a judge can return prose, a partial object, or duplicated ids. */
function readVerdicts(value: unknown): Map<string, Verdict> {
  const verdicts = new Map<string, Verdict>();
  const parsed = typeof value === 'string' ? tryParseJson(value) : value;
  if (typeof parsed !== 'object' || parsed === null) return verdicts;

  const raw = (parsed as { verdicts?: unknown }).verdicts;
  if (!Array.isArray(raw)) return verdicts;

  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const candidate = entry as Record<string, unknown>;
    const id = typeof candidate.id === 'string' ? candidate.id : undefined;
    const status = typeof candidate.status === 'string' ? candidate.status.toLowerCase() : undefined;
    if (!id || !isVerdictStatus(status) || verdicts.has(id)) continue;
    verdicts.set(id, {
      id,
      status,
      evidence: typeof candidate.evidence === 'string' ? candidate.evidence : '',
    });
  }
  return verdicts;
}

function isVerdictStatus(value: string | undefined): value is VerdictStatus {
  return value === 'met' || value === 'partial' || value === 'missing';
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/**
 * Every URL the agent opened, from the trace and from the tool journal.
 *
 * The two normally agree; the journal is the fallback for retrievals made
 * inside a subagent whose messages never surfaced in the parent trace.
 */
function collectFetchedUrls(
  trace: readonly TraceEvent[],
  journal: readonly ToolCall[],
): string[] {
  const urls = new Set(fetchedUrlsFromTrace(trace));
  for (const entry of journal) {
    if (entry.name !== 'fetch_page') continue;
    const url = entry.args.url;
    if (typeof url === 'string') urls.add(normalizeUrl(url));
  }
  return [...urls];
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return undefined;
  }
}
