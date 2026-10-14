// Tests for boxed --show-config, run as a command. It exits before MXC is needed.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const boxed = fileURLToPath(new URL('../bin/boxed.js', import.meta.url));
// Real path, because boxed resolves the current directory (/var is /private/var on macOS).
const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'boxed-test-')));
after(() => rmSync(dir, { recursive: true, force: true }));

function showConfig(config, env = {}) {
  const file = path.join(dir, 'config.json');
  writeFileSync(file, JSON.stringify(config));
  return execFileSync(process.execPath, [boxed, '--show-config', '--config', file], {
    cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, XDG_CACHE_HOME: path.join(dir, 'cache'), ...env },
  });
}

test('never prints the value of an ${env:NAME}', () => {
  const output = showConfig({
    process: {
      commandLine: 'exec env TOKEN=${env:SECRET} true',
      env: ['API_KEY=${env:SECRET}'],
      extra: '${env:SECRET}',
    },
    network: { egress: { default: 'deny' }, other: '${env:SECRET}' },
    seatbelt: { note: '${env:SECRET}' },
  }, { SECRET: 'hunter2' });
  assert.doesNotMatch(output, /hunter2/);
  assert.match(output, /command +exec env TOKEN=\$\{env:SECRET\} true/);
  assert.match(output, /from config +API_KEY/);
  assert.match(output, /seatbelt +\{"note":"\$\{env:SECRET\}"\}/);
});

test('still expands the other variables', () => {
  const output = showConfig({ process: { commandLine: 'cd ${CWD} && exec true' } });
  assert.match(output, new RegExp(`command +cd ${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('lists each variable once, where its value comes from', () => {
  const output = showConfig({
    process: { env: ['HOME=/elsewhere', 'EXTRA=1'] },
    boxed: { proxy: { loopbackPorts: [11434] } },
  });
  assert.match(output, /from host +PATH\n/);
  assert.match(output, /from config +HOME EXTRA\n/);
  assert.match(output, /from boxed +BOXED_RUN_ID .*\n +HTTP_PROXY HTTPS_PROXY ALL_PROXY /);
});
