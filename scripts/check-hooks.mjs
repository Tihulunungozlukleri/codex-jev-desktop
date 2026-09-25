import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolveCodexExecutable } from '../src/codex-runtime.mjs';

const child = spawn(await resolveCodexExecutable(), ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const send = message => child.stdin.write(`${JSON.stringify(message)}\n`);
const timer = setTimeout(() => { child.kill(); process.stderr.write('hooks/list timed out\n'); process.exitCode = 1; }, 10000);
function finish() { clearTimeout(timer); child.kill(); }
createInterface({ input: child.stdout }).on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === 0) {
    if (message.error) { process.stderr.write(`${message.error.message}\n`); process.exitCode = 1; return finish(); }
    send({ method: 'initialized', params: {} });
    send({ method: 'hooks/list', id: 1, params: { cwds: [process.cwd()] } });
  } else if (message.id === 1) {
    if (message.error) { process.stderr.write(`${message.error.message}\n`); process.exitCode = 1; return finish(); }
    const found = [];
    function walk(value) {
      if (Array.isArray(value)) { value.forEach(walk); return; }
      if (!value || typeof value !== 'object') return;
      if (Object.values(value).some(item => typeof item === 'string' && item.includes('jev-hook.mjs'))) {
        found.push({ keys: Object.keys(value), trust: value.trust ?? value.trustStatus ?? value.trusted ?? null,
          enabled: value.enabled ?? null, status: value.status ?? null, source: value.source ?? null });
      }
      Object.values(value).forEach(walk);
    }
    walk(message.result);
    process.stdout.write(JSON.stringify({ responseKeys: Object.keys(message.result ?? {}), matchingHooks: found }, null, 2) + '\n');
    finish();
  }
});
send({ method: 'initialize', id: 0, params: { clientInfo: { name: 'jev_desktop_diagnostic', title: 'JEV Desktop Diagnostic', version: '0.1.0' } } });
