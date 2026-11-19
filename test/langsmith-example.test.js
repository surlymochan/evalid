/**
 * langsmith-example — M17 slice 2 (#218).
 *
 * The runnable example in examples/langsmith-verify/ must really run:
 * spawn it (no key, no network) and assert the exit code plus the
 * verdict lines the bridge produces for the recorded traces.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..');

describe('langsmith example — examples/langsmith-verify/run.mjs', () => {
  test('runs the full chain offline and records one feedback', () => {
    const result = spawnSync(
      process.execPath,
      [join(REPO_ROOT, 'examples/langsmith-verify/run.mjs')],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /trace trace-a \(4 runs\) — 4 claims: 2 confirmed, 2 breach, 0 unknown/);
    assert.match(result.stdout, /feedback: written \(evalid_claim_verified = 0\.5\)/);
    assert.match(result.stdout, /trace trace-b \(1 runs\) — 0 claims: 0 confirmed, 0 breach, 0 unknown/);
    assert.match(result.stdout, /feedback: skipped \(no claims in agent prose\)/);
    assert.match(result.stdout, /total: 2 traces, 4 claims checked, 1 feedback written\./);
    assert.match(result.stdout, /feedback recorded on root run run-a-root:/);
    assert.match(result.stdout, /key: evalid_claim_verified \(expected evalid_claim_verified\)/);
    assert.match(result.stdout, /score: 0\.5/);
    assert.match(result.stdout, /\[breach\] file_created ghost\.txt — file not found: ghost\.txt/);
    assert.match(result.stdout, /No API key, no network/);
  });
});
