import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = process.cwd();

describe('package entry point', () => {
  test('package.json main resolves to a file that exists', async () => {
    const { default: packageJson } = await import('../package.json', {
      with: { type: 'json' },
    });
    assert.equal(typeof packageJson.main, 'string');
    assert.ok(
      existsSync(resolve(REPO_ROOT, packageJson.main)),
      `package.json main "${packageJson.main}" does not exist on disk`,
    );
  });

  test('importing the package main exposes the server starter', async () => {
    const entry = await import('../src/index.js');
    assert.equal(typeof entry.default, 'function');
    assert.equal(typeof entry.startServer, 'function');
    assert.equal(entry.default, entry.startServer);
  });

  test('package.json exposes evalid as the primary bin and xflow as its alias', async () => {
    const { default: packageJson } = await import('../package.json', {
      with: { type: 'json' },
    });
    assert.equal(packageJson.bin.evalid, 'bin/evalid.js');
    assert.equal(packageJson.bin.xflow, 'bin/xflow.js');
    assert.ok(existsSync(resolve(REPO_ROOT, packageJson.bin.evalid)));
    assert.ok(existsSync(resolve(REPO_ROOT, packageJson.bin.xflow)));
    // The alias is a thin shim that delegates to the same entry
    // implementation, so both bin names run identical code.
    const shim = readFileSync(resolve(REPO_ROOT, packageJson.bin.xflow), 'utf8');
    assert.match(shim, /import '\.\/evalid\.js';/);
  });

  test('both bins print identical help that leads with the evalid name', () => {
    const options = { cwd: REPO_ROOT, encoding: 'utf8', timeout: 10000 };
    const primary = spawnSync('node', ['bin/evalid.js', '--help'], options);
    const alias = spawnSync('node', ['bin/xflow.js', '--help'], options);
    assert.equal(primary.status, 0, primary.stderr || primary.stdout);
    assert.equal(alias.status, 0, alias.stderr || alias.stdout);
    assert.equal(alias.stdout, primary.stdout);
    assert.match(primary.stdout, /evalid — unified workflow CLI/);
    assert.match(primary.stdout, /Usage:\n  evalid workflow run/);
    assert.match(primary.stdout, /legacy name 'xflow'/);
  });
});
