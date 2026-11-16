// Regression coverage for issue #208: the SWE-bench openswarm arm points
// OPENSWARM_PI_BIN at harness/pi_shim.sh, and swrm's pi_bin() only accepts a
// path that is executable ("missing or not executable is an error"). The shim
// was committed with mode 100644, so a fresh checkout produced a
// non-executable shim and every openswarm cell died in ~1s with status
// `unroutable` ("no working pi binary") — 0/6, an infrastructure failure
// rather than a model signal.
//
// This test pins three things: the shim's repo mode (100755, so a checkout
// restores the exec bit), its on-disk exec bit, and the OPENSWARM_PI_BIN
// wiring in harness/arms.py that hands the shim path to swrm.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { accessSync, constants, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const SHIM_REL = 'bench/swebench/harness/pi_shim.sh';
const SHIM_PATH = resolve(REPO_ROOT, SHIM_REL);
const ARMS_PATH = resolve(REPO_ROOT, 'bench/swebench/harness/arms.py');

function gitAvailable() {
  return spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
}

describe('swebench pi shim is executable (issue #208)', () => {
  test('shim has the exec bit on disk', () => {
    accessSync(SHIM_PATH, constants.X_OK);
  });

  test('shim is committed with mode 100755', { skip: gitAvailable() ? false : 'git not available' }, () => {
    const result = spawnSync('git', ['ls-files', '-s', SHIM_REL], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(
      result.stdout.trim(),
      /^100755 [0-9a-f]+ \d+\tbench\/swebench\/harness\/pi_shim\.sh$/,
      `pi_shim.sh must be tracked with mode 100755, got: ${result.stdout.trim()}`
    );
  });

  test('shim keeps a shebang so the exec bit is meaningful', () => {
    assert.match(readFileSync(SHIM_PATH, 'utf8'), /^#!\/usr\/bin\/env bash\n/);
  });

  test('arms.py hands the executable shim to swrm as OPENSWARM_PI_BIN', () => {
    const arms = readFileSync(ARMS_PATH, 'utf8');
    assert.match(arms, /shim\s*=\s*Path\(__file__\)\.resolve\(\)\.parent\s*\/\s*"pi_shim\.sh"/);
    assert.match(arms, /OPENSWARM_PI_BIN\s*=\s*str\(shim\)/);
    accessSync(SHIM_PATH, constants.X_OK);
  });
});
