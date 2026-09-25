import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';

export const AUTO_MODEL = 'jev-auto';
export const DEFAULT_CHATGPT = 'https://chatgpt.com/backend-api/codex';
export const DEFAULT_API = 'https://api.openai.com/v1';
export const DEFAULT_JEV = 'https://api.typesafe.ai/v1/systemone';

export function configFromEnv(env = process.env, base = process.cwd()) {
  const port = Number(env.JEV_DESKTOP_PORT ?? 4319);
  const timeoutMs = Number(env.JEV_DESKTOP_TIMEOUT_MS ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000) throw new Error('Invalid JEV timeout');
  const upstreamChatgpt = env.JEV_DESKTOP_CHATGPT_URL ?? DEFAULT_CHATGPT;
  const upstreamApi = env.JEV_DESKTOP_API_URL ?? DEFAULT_API;
  const jevUrl = env.JEV_DESKTOP_JEV_URL ?? DEFAULT_JEV;
  const custom = Boolean(env.JEV_DESKTOP_ALLOW_CUSTOM_ENDPOINTS === '1');
  for (const [value, expected] of [[upstreamChatgpt, DEFAULT_CHATGPT], [upstreamApi, DEFAULT_API], [jevUrl, DEFAULT_JEV]]) {
    const url = new URL(value);
    if (!custom && value !== expected) throw new Error('Custom endpoints require JEV_DESKTOP_ALLOW_CUSTOM_ENDPOINTS=1');
    if (custom && url.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('Custom endpoint must use HTTPS or loopback');
  }
  const dataDir = env.JEV_DESKTOP_DATA_DIR ?? (process.platform === 'win32' ? join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'CodexJevDesktop') : join(base, '.data'));
  const fromFile = file => { try { return readFileSync(join(dataDir, file), 'utf8').trim(); } catch { return ''; } };
  return {
    host: '127.0.0.1', port, timeoutMs, upstreamChatgpt, upstreamApi, jevUrl,
    jevKey: env.TYPESAFE_API_KEY ?? env.JEV_API_KEY ?? fromFile('typesafe-key'),
    dataDir,
    mode: env.JEV_DESKTOP_MODE === 'active' ? 'active' : 'shadow',
    capabilityToken: env.JEV_DESKTOP_TOKEN ?? fromFile('capability-token'),
    adminToken: fromFile('admin-token'),
    maxRequestBytes: 32 * 1024 * 1024,
  };
}

export const codexConfigPath = (env = process.env) => join(env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml');
