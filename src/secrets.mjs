import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, rename, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import readline from 'node:readline';

const exec = promisify(execFile);

async function userSid() {
  const { stdout } = await exec('whoami.exe', ['/user', '/fo', 'csv', '/nh']);
  const match = stdout.match(/S-1-\d+(?:-\d+)+/);
  if (!match) throw new Error('Cannot identify Windows user SID');
  return match[0];
}

export async function secureWrite(directory, name, value) {
  if (!/^[a-z-]+$/.test(name)) throw new Error('Invalid secret name');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let sid;
  if (process.platform === 'win32') {
    sid = await userSid();
    await exec('icacls.exe', [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`]);
  } else await chmod(directory, 0o700);
  const path = join(directory, name), temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temp, `${value.trim()}\n`, { mode: 0o600, flag: 'wx' });
    if (sid) await exec('icacls.exe', [temp, '/inheritance:r', '/grant:r', `*${sid}:F`]);
    else await chmod(temp, 0o600);
    await rename(temp, path);
  } catch (error) { await rm(temp, { force: true }); throw error; }
  return path;
}

export async function hiddenInput(label = 'TypeSafe API key: ') {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    let value = ''; for await (const chunk of process.stdin) value += chunk;
    return value.trim();
  }
  process.stdout.write(label);
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    function finish(error) {
      process.stdin.off('keypress', onKey);
      process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n');
      if (error) reject(error); else resolve(value.trim());
    }
    function onKey(str, key) {
      if (key?.ctrl && key.name === 'c') return finish(new Error('Cancelled'));
      if (key?.name === 'return' || key?.name === 'enter') return finish();
      if (key?.name === 'backspace') { value = value.slice(0, -1); return; }
      if (str && !key?.ctrl && !key?.meta) value += str;
    }
    process.stdin.on('keypress', onKey);
  });
}
