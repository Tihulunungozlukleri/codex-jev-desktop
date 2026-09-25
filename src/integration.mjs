import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { secureWrite } from './secrets.mjs';

const digest = text => createHash('sha256').update(text).digest('hex');
async function atomicReplace(path, value) {
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temp, value, { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}
const ROOT_START = '# BEGIN JEV-DESKTOP ROOT';
const ROOT_END = '# END JEV-DESKTOP ROOT';
const EXT_START = '# BEGIN JEV-DESKTOP EXTENSION';
const EXT_END = '# END JEV-DESKTOP EXTENSION';

function splitRoot(text) {
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex(line => /^\s*\[/.test(line));
  return index < 0 ? [lines, []] : [lines.slice(0, index), lines.slice(index)];
}

export function prepareConfig(original, { port, hookPath, token }) {
  if (original.includes(ROOT_START) || original.includes(EXT_START)) throw new Error('Router config already present');
  if (/^\s*\[model_providers\.jev_desktop\]/m.test(original)) throw new Error('Provider name jev_desktop is already used');
  const [root, rest] = splitRoot(original);
  const previous = [];
  const preserved = root.filter(line => {
    if (/^\s*(model|model_provider)\s*=/.test(line)) { previous.push(line); return false; }
    return true;
  });
  const rootBlock = [ROOT_START, 'model = "jev-auto"', 'model_provider = "jev_desktop"', ROOT_END];
  const command = `node "${hookPath}"`;
  const extension = [EXT_START,
    '[model_providers.jev_desktop]', 'name = "Jev Auto"', `base_url = "http://127.0.0.1:${port}"`,
    'wire_api = "responses"', 'requires_openai_auth = true', 'supports_websockets = false',
    `http_headers = { "x-jev-desktop-token" = ${JSON.stringify(token)} }`, '',
    '[[hooks.UserPromptSubmit]]', '[[hooks.UserPromptSubmit.hooks]]', 'type = "command"', `command = ${JSON.stringify(command)}`,
    EXT_END];
  const rootText = [...rootBlock, ...preserved].join('\n').trimEnd();
  const restText = rest.join('\n').trim();
  return { text: `${rootText}\n\n${restText ? `${restText}\n\n` : ''}${extension.join('\n')}\n`, previous };
}

export function removeConfig(current, previous) {
  if (!current.includes(ROOT_START) || !current.includes(EXT_START)) throw new Error('Managed config markers missing');
  const rootPattern = new RegExp(`^${ROOT_START}[\\s\\S]*?^${ROOT_END}\\r?\\n?`, 'm');
  const extPattern = new RegExp(`^${EXT_START}[\\s\\S]*?^${EXT_END}\\r?\\n?`, 'm');
  let remainder = current.replace(rootPattern, '').replace(extPattern, '');
  const [root] = splitRoot(remainder);
  if (root.some(line => /^\s*(model|model_provider)\s*=/.test(line))) throw new Error('Conflicting model/provider value added after installation');
  remainder = `${previous.join('\n')}${previous.length ? '\n' : ''}${remainder}`;
  return remainder;
}

export async function install({ configPath, dataDir, port, hookPath, preview = true, token: suppliedToken = null }) {
  const original = await readFile(configPath, 'utf8');
  const token = preview ? '<generated-local-token>' : suppliedToken ?? randomBytes(32).toString('hex');
  const plan = prepareConfig(original, { port, hookPath, token });
  if (preview) return { configPath, oldProvider: original.match(/^\s*model_provider\s*=\s*(.+)$/m)?.[1] ?? '(default)',
    oldModel: original.match(/^\s*model\s*=\s*(.+)$/m)?.[1] ?? '(default)',
    newProvider: 'jev_desktop', newModel: 'jev-auto', port, hookPath,
    backup: join(dataDir, 'config-before-jev.toml'), changes: ['root model/provider', 'custom Responses provider', 'UserPromptSubmit hook'],
    warning: 'The local relay must be running before Codex uses Jev Auto; a Desktop restart may be needed.' };
  await mkdir(dataDir, { recursive: true });
  const manifestPath = join(dataDir, 'install.json');
  try { const manifest = JSON.parse(await readFile(manifestPath, 'utf8')); if (!manifest.uninstalledAt) throw new Error('Already installed; uninstall first'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await secureWrite(dataDir, 'capability-token', token);
  const backupPath = join(dataDir, `config-before-jev-${Date.now()}-${randomBytes(4).toString('hex')}.toml`);
  let manifestPrepared = false;
  try {
    await writeFile(backupPath, original, { flag: 'wx', mode: 0o600 });
    const current = await readFile(configPath, 'utf8');
    if (digest(current) !== digest(original)) throw new Error('Codex config changed during installation');
    // The recovery manifest must exist before the live Codex config changes.
    await atomicReplace(manifestPath, JSON.stringify({ configPath, backupPath, originalHash: digest(original), installedHash: digest(plan.text), previous: plan.previous }, null, 2));
    manifestPrepared = true;
    await atomicReplace(configPath, plan.text);
    return { configPath, backupPath, installed: true };
  } catch (error) {
    try {
      if (digest(await readFile(configPath, 'utf8')) === digest(original)) {
        if (manifestPrepared) await rm(manifestPath, { force: true });
        await rm(join(dataDir, 'capability-token'), { force: true });
      }
    } catch { /* leave the manifest available for explicit recovery */ }
    throw error;
  }
}

export async function uninstall({ dataDir }) {
  const manifestPath = join(dataDir, 'install.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.uninstalledAt) return { configPath: manifest.configPath, alreadyUninstalled: true };
  const current = await readFile(manifest.configPath, 'utf8');
  const original = await readFile(manifest.backupPath, 'utf8');
  const alreadyRestored = digest(current) === manifest.originalHash;
  const restored = alreadyRestored ? current : digest(current) === manifest.installedHash ? original : removeConfig(current, manifest.previous);
  if (!alreadyRestored) await atomicReplace(manifest.configPath, restored);
  await rm(join(dataDir, 'capability-token'), { force: true });
  await atomicReplace(manifestPath, JSON.stringify({ ...manifest, uninstalledAt: new Date().toISOString() }, null, 2));
  return { configPath: manifest.configPath, exactRestore: restored === original };
}
