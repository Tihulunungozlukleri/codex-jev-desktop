#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
const files = git('ls-files', '--cached', '-z').split('\0').filter(Boolean);
const permitted = file => file === '.gitignore' || file === 'README.md' || file === 'package.json' || file === 'package-lock.json' ||
  /^(?:src|bin|scripts|test)\/[a-z0-9.-]+\.(?:mjs|ps1|cs)$/.test(file) ||
  /^docs\/(?:ARCHITECTURE|SHARING)\.md$/.test(file);
const checks = [
  ['absolute Windows user path', /[A-Za-z]:[\\/]Users[\\/][^\\/\s"'<>]+/i],
  ['home user path', /\/(?:home|Users)\/[a-z0-9._-]+\//i],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/],
  ['OpenAI-style API key', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\b/],
  ['email address', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
];
const dataDirectory = join(process.env.LOCALAPPDATA ?? '', 'CodexJevDesktop');
const knownSecrets = ['typesafe-key', 'admin-token', 'capability-token'].flatMap(file => {
  try { const value = readFileSync(join(dataDirectory, file), 'utf8').trim(); return value.length >= 8 ? [[file, value]] : []; }
  catch { return []; }
});
const issues = [];
if (!files.length) issues.push('No staged or tracked files to check');
for (const file of files) {
  if (!permitted(file)) { issues.push(`${file}: file type is not on the publish allowlist`); continue; }
  const source = git('show', `:${file}`);
  for (const [label, pattern] of checks) if (pattern.test(source)) issues.push(`${file}: ${label}`);
  for (const [label, value] of knownSecrets) if (source.includes(value)) issues.push(`${file}: contains local ${label}`);
}
if (issues.length) {
  process.stderr.write(`Publish check rejected ${issues.length} item(s):\n${issues.map(item => `- ${item}`).join('\n')}\n`);
  process.exitCode = 1;
} else process.stdout.write(`Publish check passed: ${files.length} staged/tracked source files; no matched personal path, email, key, or local secret.\n`);
