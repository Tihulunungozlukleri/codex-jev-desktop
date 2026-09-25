import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolveCodexExecutable } from '../src/codex-runtime.mjs';

const args = process.argv.includes('--installed') ? ['app-server'] : [
  'app-server',
  '-c', 'model_provider="jev_desktop"',
  '-c', 'model="jev-auto"',
  '-c', 'model_providers.jev_desktop={ name = "Jev Auto", base_url = "http://127.0.0.1:4319", wire_api = "responses", requires_openai_auth = true, supports_websockets = false }',
];
const child = spawn(await resolveCodexExecutable(), args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const send = message => child.stdin.write(`${JSON.stringify(message)}\n`);
const timer = setTimeout(() => { child.kill(); process.stderr.write('model/list timed out\n'); process.exitCode = 1; }, 15000);
child.on('error', error => { clearTimeout(timer); process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
const lines = createInterface({ input: child.stdout });
lines.on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === 0) {
    if (message.error) { clearTimeout(timer); process.stderr.write(`initialize: ${message.error.message}\n`); child.kill(); process.exitCode = 1; return; }
    send({ method: 'initialized', params: {} });
    send({ method: 'model/list', id: 1, params: { limit: 100, includeHidden: false } });
  } else if (message.id === 1) {
    clearTimeout(timer);
    if (message.error) { process.stderr.write(`model/list: ${message.error.message}\n`); process.exitCode = 1; }
    else {
      const data = message.result?.data ?? [];
      const auto = data.find(model => model.id === 'jev-auto');
      process.stdout.write(JSON.stringify({ models: data.map(model => model.id),
        details: data.map(model => ({ id: model.id, defaultReasoningEffort: model.defaultReasoningEffort,
          supportedReasoningEfforts: (model.supportedReasoningEfforts ?? []).map(item => item.reasoningEffort ?? item) })),
        jevAutoVisible: Boolean(auto),
        auto: auto ? { defaultReasoningEffort: auto.defaultReasoningEffort, supportedReasoningEfforts: auto.supportedReasoningEfforts,
          inputModalities: auto.inputModalities, contextWindow: auto.contextWindow ?? null } : null }, null, 2) + '\n');
    }
    child.kill();
  }
});
send({ method: 'initialize', id: 0, params: { clientInfo: { name: 'jev_desktop_diagnostic', title: 'JEV Desktop Diagnostic', version: '0.1.0' } } });
