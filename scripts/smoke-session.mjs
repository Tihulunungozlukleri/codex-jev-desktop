import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolveCodexExecutable } from '../src/codex-runtime.mjs';

const marker = 'amber-47';
const routes = [
  { model: 'gpt-6-luna', effort: 'low' },
  { model: 'gpt-6-sol', effort: 'high' },
  ...(process.argv.includes('--include-astra') ? [{ model: 'gpt-6-astra', effort: 'high' }] : []),
];
const results = [];
const child = spawn(await resolveCodexExecutable(), ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const send = message => child.stdin.write(`${JSON.stringify(message)}\n`);
let threadId = null, turnIndex = 0, lastAnswer = '';
const timer = setTimeout(() => { child.kill(); process.stderr.write('session smoke timed out\n'); process.exitCode = 1; }, 60000);
function finish(ok, message) {
  clearTimeout(timer);
  process.stdout.write(JSON.stringify({ ok, sameThread: Boolean(threadId), firstTurnCompleted: turnIndex >= 1,
    secondTurnCompleted: turnIndex >= 2, thirdTurnCompleted: routes.length < 3 ? null : turnIndex >= 3, recalledMarker: lastAnswer.includes(marker), results, detail: message }, null, 2) + '\n');
  if (!ok) process.exitCode = 1;
  child.kill();
}
function startTurn(text, id) {
  lastAnswer = '';
  send({ method: 'turn/start', id, params: { threadId, input: [{ type: 'text', text }], approvalPolicy: 'never',
    sandboxPolicy: { type: 'readOnly' }, model: 'jev-auto' } });
}
child.on('error', error => finish(false, error.message));
createInterface({ input: child.stdout }).on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.error && [0, 1, 2, 3, 4].includes(message.id)) return finish(false, message.error.message);
  if (message.id === 0) {
    send({ method: 'initialized', params: {} });
    send({ method: 'thread/start', id: 1, params: { model: 'jev-auto', cwd: process.cwd(), ephemeral: true,
      approvalPolicy: 'never', sandbox: 'read-only' } });
  } else if (message.id === 1) {
    threadId = message.result?.thread?.id;
    if (!threadId || !message.result?.thread?.ephemeral) return finish(false, 'ephemeral thread unsupported');
    startTurn(`Use ${routes[0].model} ${routes[0].effort}. Remember the marker ${marker}. Reply SAVED.`, 2);
  } else if (message.method === 'item/completed' && message.params?.item?.type === 'agentMessage') {
    lastAnswer += message.params.item.text ?? '';
  } else if (message.method === 'turn/completed') {
    if (message.params?.turn?.status !== 'completed') return finish(false, message.params?.turn?.error?.message ?? 'turn failed');
    const route = routes[turnIndex];
    const footer = `JEV route: ${route.model} · ${route.effort}`;
    const footerMatches = lastAnswer.trimEnd().endsWith(footer);
    const memoryMatches = turnIndex === 0 ? lastAnswer.includes('SAVED') : lastAnswer.includes(marker);
    results.push({ ...route, footerMatches, memoryMatches });
    if (!footerMatches || !memoryMatches) return finish(false, lastAnswer.slice(0, 250));
    turnIndex++;
    if (turnIndex < routes.length) {
      const next = routes[turnIndex];
      startTurn(`Use ${next.model} ${next.effort}. What exact marker did I ask you to remember? Reply briefly.`, turnIndex + 2);
    } else finish(true, lastAnswer.slice(0, 250));
  }
});
send({ method: 'initialize', id: 0, params: { clientInfo: { name: 'jev_desktop_diagnostic', title: 'JEV Desktop Diagnostic', version: '0.1.0' } } });
