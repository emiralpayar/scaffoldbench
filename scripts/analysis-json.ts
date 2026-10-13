// Dumps analyzeRunSet's full output for a run set as JSON, for the README figures and the site.
// Usage: tsx scripts/analysis-json.ts <runSetId> [out.json]
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeRunSet } from '../packages/core/src/analysis';

const id = process.argv[2];
if (!id) throw new Error('usage: analysis-json.ts <runSetId> [out.json]');
const dir = join('results', id, 'runs');
const records = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
const analysis = analyzeRunSet(records);
const out = JSON.stringify(analysis, null, 2);
if (process.argv[3]) writeFileSync(process.argv[3], out + '\n');
else process.stdout.write(out + '\n');
