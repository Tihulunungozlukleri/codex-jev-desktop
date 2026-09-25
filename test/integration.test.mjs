import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { install, uninstall, prepareConfig } from '../src/integration.mjs';
import { secureWrite } from '../src/secrets.mjs';
import { StateStore } from '../src/state.mjs';

test('managed config restores exact original and supports idempotent uninstall', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-install-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dataDir = join(dir, 'state'), configPath = join(dir, 'config.toml');
  const original = 'model = "gpt-6-sol"\nmodel_provider = "openai"\n\n[features]\nfoo = true\n';
  await writeFile(configPath, original);
  const preview = await install({ configPath, dataDir, port: 4319, hookPath: 'C:\\my hook.mjs', preview: true });
  assert.equal(preview.newProvider, 'jev_desktop');
  assert.equal(await readFile(configPath, 'utf8'), original);
  await install({ configPath, dataDir, port: 4319, hookPath: 'C:\\my hook.mjs', preview: false });
  const installed = await readFile(configPath, 'utf8');
  assert.match(installed, /model = "jev-auto"/);
  assert.match(installed, /\[model_providers\.jev_desktop\]/);
  assert.match(installed, /\[\[hooks.UserPromptSubmit\]\]/);
  assert.equal((await uninstall({ dataDir })).exactRestore, true);
  assert.equal(await readFile(configPath, 'utf8'), original);
  assert.equal((await uninstall({ dataDir })).alreadyUninstalled, true);
});

test('rollback preserves unrelated user edits', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-install-edit-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dataDir = join(dir, 'state'), configPath = join(dir, 'config.toml');
  await writeFile(configPath, 'model = "gpt-6-sol"\nmodel_provider = "openai"\n\n[features]\nfoo = true\n');
  await install({ configPath, dataDir, port: 4319, hookPath: 'C:\\hook.mjs', preview: false });
  const modified = (await readFile(configPath, 'utf8')).replace('foo = true', 'foo = false\nbar = true');
  await writeFile(configPath, modified);
  const result = await uninstall({ dataDir });
  assert.equal(result.exactRestore, false);
  const restored = await readFile(configPath, 'utf8');
  assert.match(restored, /foo = false\nbar = true/);
  assert.match(restored, /model_provider = "openai"/);
  assert.doesNotMatch(restored, /jev_desktop/);
});

test('installation leaves native config intact if manifest cannot be prepared', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-install-blocked-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dataDir = join(dir, 'state'), configPath = join(dir, 'config.toml');
  const original = 'model = "gpt-6-sol"\n';
  await writeFile(configPath, original);
  await mkdir(join(dataDir, 'install.json'), { recursive: true });
  await assert.rejects(install({ configPath, dataDir, port: 4319, hookPath: 'C:\\hook.mjs', preview: false }));
  assert.equal(await readFile(configPath, 'utf8'), original);
});

test('rollback can finish when config was restored before manifest update', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-uninstall-retry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dataDir = join(dir, 'state'), configPath = join(dir, 'config.toml');
  const original = 'model = "gpt-6-sol"\n';
  await writeFile(configPath, original);
  await install({ configPath, dataDir, port: 4319, hookPath: 'C:\\hook.mjs', preview: false });
  await writeFile(configPath, original);
  assert.equal((await uninstall({ dataDir })).exactRestore, true);
  assert.equal((await uninstall({ dataDir })).alreadyUninstalled, true);
});

test('journal recovery separates a torn tail and loads later valid entries', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-journal-recovery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'sessions.jsonl'), '{"key":"first","value":{"route":{"model":"one"}}}\n{"key":');
  await writeFile(join(dir, 'memory.jsonl'), '{"id":"first"}\n{"id":');
  const store = new StateStore(dir);
  await store.init();
  await store.updateSession('second', { route: { model: 'two' } });
  await store.archive('second', 'user', 'later memory');
  const restarted = new StateStore(dir);
  await restarted.init();
  assert.equal(restarted.session('first').route.model, 'one');
  assert.equal(restarted.session('second').route.model, 'two');
  assert.equal(restarted.seen.size, 2);
});

test('secret writer stores a dedicated user-scoped file', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-secret-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = await secureWrite(join(dir, 'state'), 'typesafe-key', 'dummy-test-key');
  assert.equal((await readFile(path, 'utf8')).trim(), 'dummy-test-key');
  assert.throws(() => prepareConfig('[model_providers.jev_desktop]\n', { port: 4319, hookPath: 'x', token: 'x' }));
});
