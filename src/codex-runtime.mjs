import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export async function resolveCodexExecutable(env = process.env) {
  if (env.JEV_CODEX_EXECUTABLE) return env.JEV_CODEX_EXECUTABLE;
  if (process.platform !== 'win32' || !env.LOCALAPPDATA) return 'codex';
  const root = join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
  try {
    const candidates = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(root, entry.name, 'codex.exe');
      try { candidates.push({ path, modified: (await stat(path)).mtimeMs }); } catch {}
    }
    candidates.sort((left, right) => right.modified - left.modified);
    return candidates[0]?.path ?? 'codex';
  } catch { return 'codex'; }
}
