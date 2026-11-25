// Detection-rate bench. Usage: node scripts/detect-bench.mjs
// Runs analyze() (src/core/analyze.ts) over the corpus (src/core/analyze.corpus.ts) and prints the
// detection rate and the false positives on clean files. A measurement, not a gate: exit 0 always.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'vite';

const ROOT = new URL('..', import.meta.url).pathname;
const vite = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
});
try {
  const { analyze } = await vite.ssrLoadModule('/src/core/analyze.ts');
  const { CORPUS } = await vite.ssrLoadModule('/src/core/analyze.corpus.ts');

  let hit = 0;
  let total = 0;
  let falsePositives = 0;
  const failed = [];

  for (const entry of CORPUS) {
    const path = join(ROOT, 'public/samples', entry.file);
    if (!existsSync(path)) {
      failed.push(`${entry.file}: missing`);
      console.log(`SKIPPED   ${entry.file} - ${entry.technique} (file missing)`);
      continue;
    }
    let result;
    try {
      result = await analyze(new Uint8Array(readFileSync(path)), entry.file);
    } catch (e) {
      failed.push(`${entry.file}: ${e instanceof Error ? e.message : e}`);
      console.log(
        `ERROR     ${entry.file} - ${entry.technique} (${e instanceof Error ? e.message : e})`,
      );
      if (!entry.clean) total++;
      continue;
    }
    const { findings } = result;
    if (entry.clean) {
      const fp = findings.filter((f) => f.confidence === 'confirmed');
      falsePositives += fp.length;
      console.log(
        `${fp.length ? 'FALSE-POS ' : 'CLEAN     '} ${entry.file} - ${entry.technique}` +
          (fp.length ? ` (${fp.map((f) => f.kind).join(', ')})` : ''),
      );
      continue;
    }
    total++;
    const exp = entry.expect;
    const ok =
      'flag' in exp
        ? findings.some(
            (f) =>
              f.flag === exp.flag ||
              (f.detail ?? '').includes(exp.flag) ||
              (f.title ?? '').includes(exp.flag),
          )
        : findings.some(
            (f) =>
              f.kind === exp.kind && (f.confidence === 'probable' || f.confidence === 'confirmed'),
          );
    if (ok) hit++;
    console.log(`${ok ? 'DETECTED  ' : 'MISSED    '} ${entry.file} - ${entry.technique}`);
  }

  const pct = total ? Math.round((hit / total) * 100) : 0;
  console.log(`DETECTION: ${hit}/${total} (${pct}%) | false-positives: ${falsePositives}`);
  if (failed.length) console.log(`FAILED TO LOAD: ${failed.join('; ')}`);
} finally {
  await vite.close();
}
