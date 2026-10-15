// Fails if tracked files contain things that must never ship in a public repo:
// personal e-mail addresses, absolute home paths, private keys, .env files.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && !f.startsWith('public/samples/') && f !== 'package-lock.json');

const rules = [
  [/(^|\/)\.env(\.|$)/, 'environment file', 'path'],
  [/[A-Za-z0-9._%+-]+@(?!example\.)[A-Za-z0-9-]+\.(com|fr|net|org|io|me)\b/, 'e-mail address'],
  [/(\/home\/[a-z][a-z0-9_-]*\/|\/Users\/[A-Za-z0-9_-]+\/|C:\\Users\\)/, 'absolute home path'],
  [/-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]{40,}/, 'private key'],
  [/\b(ghp|gho|github_pat|sk-ant|sk|xox[bap])[-_][A-Za-z0-9_-]{20,}/, 'API token'],
];

const hits = [];
for (const f of files) {
  for (const [re, what, scope] of rules) {
    if (scope === 'path') {
      if (re.test(f)) hits.push(`${f}: ${what}`);
      continue;
    }
    let text;
    try {
      text = readFileSync(f, 'utf8');
    } catch {
      continue; // deleted in the working tree
    }
    const m = text.match(re);
    if (m) hits.push(`${f}: ${what} → ${m[0].slice(0, 60)}`);
  }
}
// Commit metadata is public too: authors and committers must use no-reply addresses.
const people = execFileSync('git', ['log', '--format=%ae%n%ce'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);
for (const email of new Set(people)) {
  if (!/noreply|no-reply/i.test(email)) hits.push(`git history: non-noreply e-mail ${email}`);
}

if (hits.length) {
  console.error(`Privacy check failed:\n${hits.join('\n')}`);
  process.exit(1);
}
console.log(`Privacy check: ${files.length} tracked files clean.`);
