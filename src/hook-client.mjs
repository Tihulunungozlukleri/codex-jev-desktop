import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function runStartupTask() {
  if (process.platform !== 'win32') return false;
  try {
    await execFileAsync('schtasks.exe', ['/Run', '/TN', 'CodexJevDesktopRelay'], { windowsHide: true, timeout: 3000 });
    return true;
  } catch { return false; }
}

function headers(config) {
  return { 'content-type': 'application/json', ...(config.capabilityToken ? { 'x-jev-desktop-token': config.capabilityToken } : {}) };
}

export async function requestPreflight(event, config, { fetchImpl = fetch, startRelay = runStartupTask } = {}) {
  const url = `http://127.0.0.1:${config.port}/preflight`;
  const options = { method: 'POST', signal: AbortSignal.timeout(config.timeoutMs + 500), headers: headers(config),
    body: JSON.stringify({ session_id: event.session_id, prompt: event.prompt }) };
  try { return await fetchImpl(url, options); }
  catch {
    if (!await startRelay()) return null;
    for (let attempt = 0; attempt < 12; attempt++) {
      await pause(250);
      try { return await fetchImpl(url, { ...options, signal: AbortSignal.timeout(config.timeoutMs + 500) }); }
      catch { /* relay may still be starting */ }
    }
    return null;
  }
}
