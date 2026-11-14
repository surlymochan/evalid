import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Writable } from 'node:stream';

import { runLiveSession } from '../src/core/live-session.js';
import { normalizeAgentEvents } from '../src/core/agent-stream.js';
import {
  createClaimChecker,
  extractBareTestClaim,
  extractFileClaims,
  extractSessionClaims,
  verifyClaim,
  verifyClaimsFromStream,
  verifyFileClaim,
  verifyTestClaim,
} from '../src/core/live-claims.js';

const REPO_ROOT = resolve(import.meta.dirname, '..');

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'evalid-live-claims-'));
}

function collectStdout() {
  const chunks = [];
  const writable = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  return { writable, bytes: () => Buffer.concat(chunks) };
}

/** A fake agent CLI that writes `content` to stdout verbatim, then exits 0. */
function printerScript(dir, content) {
  const path = join(dir, `printer-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(path, `process.stdout.write(${JSON.stringify(content)});\n`);
  return path;
}

function codexMessage(text) {
  return JSON.stringify({
    type: 'item.completed',
    item: { id: 'm1', type: 'agent_message', text },
  });
}

function codexStream(...lines) {
  return ['{"type":"thread.started"}', ...lines, '{"type":"turn.completed","usage":{}}'].join('\n') + '\n';
}

/** Fake test-run replay: canned exit/output, no process spawned. */
function fakeRun({ exit = 0, output = '# pass 1\n# fail 0\n', timedOut = false, spawnError = null } = {}) {
  return async () => ({
    exit, timedOut, spawnError, output, outputTail: output, durationMs: 1,
  });
}

describe('extractFileClaims (M15 slice 2)', () => {
  test('backticked created/wrote paths count; bare paths after a creation verb count', () => {
    assert.deepEqual(
      extractFileClaims('Created `src/foo.js` and wrote `docs/notes.md`.').map((claim) => claim.path),
      ['src/foo.js', 'docs/notes.md'],
    );
    assert.deepEqual(
      extractFileClaims('Created src/bar.js for the demo.').map((claim) => claim.path),
      ['src/bar.js'],
    );
  });

  test('prose without a path, or a path without a creation verb, is not a claim', () => {
    assert.deepEqual(extractFileClaims('Added tests and created a helper.'), []);
    assert.deepEqual(extractFileClaims('See src/foo.js for the failing test.'), []);
    assert.deepEqual(extractFileClaims('The fix lives in docs/notes.md.'), []);
  });

  test('duplicate paths collapse to one claim', () => {
    const claims = extractFileClaims('Created `src/foo.js`.\nLater I wrote `src/foo.js` again.');
    assert.equal(claims.length, 1);
    assert.equal(claims[0].path, 'src/foo.js');
  });
});

describe('verifyFileClaim (M15 slice 2)', () => {
  test('existing file confirms, missing file breaches', () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, 'real.js'), 'x');
      assert.equal(verifyFileClaim({ kind: 'file_created', path: 'real.js' }, { cwd: dir }).verdict, 'confirmed');
      const breach = verifyFileClaim({ kind: 'file_created', path: 'ghost.js' }, { cwd: dir });
      assert.equal(breach.verdict, 'breach');
      assert.match(breach.note, /file not found: ghost\.js/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('absolute paths and workdir escapes are unknown, never confirmed or breach', () => {
    const dir = makeTempDir();
    try {
      assert.equal(
        verifyFileClaim({ kind: 'file_created', path: '/etc/hostname' }, { cwd: dir }).verdict,
        'unknown',
      );
      assert.equal(
        verifyFileClaim({ kind: 'file_created', path: '../outside.js' }, { cwd: dir }).verdict,
        'unknown',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('verifyTestClaim (M15 slice 2)', () => {
  const claim = {
    kind: 'test_run', command: 'npm test', claimedExit: 0, claimedPassed: 1, claimedFailed: 0, claimedTotal: 1,
  };

  test('exit + counts match → confirmed', async () => {
    const result = await verifyTestClaim(claim, { run: fakeRun({ exit: 0, output: '# pass 1\n# fail 0\n' }) });
    assert.equal(result.verdict, 'confirmed');
  });

  test('exit mismatch → breach with the exit note', async () => {
    const result = await verifyTestClaim(claim, { run: fakeRun({ exit: 1, output: '# pass 0\n# fail 1\n' }) });
    assert.equal(result.verdict, 'breach');
    assert.match(result.note, /exit: claimed 0, replayed 1/);
  });

  test('counts mismatch → breach with the counts note', async () => {
    const result = await verifyTestClaim(claim, { run: fakeRun({ exit: 0, output: '# pass 0\n# fail 1\n' }) });
    assert.equal(result.verdict, 'breach');
    assert.match(result.note, /passed count: claimed 1, replayed 0/);
  });

  test('spawn error and timeout are unknown, not breach', async () => {
    const missing = await verifyTestClaim(claim, { run: fakeRun({ spawnError: 'spawnSync pytest ENOENT' }) });
    assert.equal(missing.verdict, 'unknown');
    assert.match(missing.note, /could not run claimed command/);
    const timedOut = await verifyTestClaim(claim, { run: fakeRun({ timedOut: true }) });
    assert.equal(timedOut.verdict, 'unknown');
    assert.match(timedOut.note, /timed out/);
  });

  test('counts unparsed while the claim states counts → unknown; without claimed counts → confirmed', async () => {
    const unparsed = await verifyTestClaim(claim, { run: fakeRun({ exit: 0, output: 'no summary here\n' }) });
    assert.equal(unparsed.verdict, 'unknown');
    assert.match(unparsed.note, /counts_unparsed/);
    const bare = { kind: 'test_run', command: 'npm test', claimedExit: 0, claimedPassed: null, claimedFailed: null };
    const confirmed = await verifyTestClaim(bare, { run: fakeRun({ exit: 0, output: 'no summary here\n' }) });
    assert.equal(confirmed.verdict, 'confirmed');
  });
});

describe('createClaimChecker (M15 slice 2)', () => {
  test('same command claimed twice is verified once; checks arrive in order', async () => {
    const checker = createClaimChecker({
      run: fakeRun({ exit: 0, output: '# pass 1\n# fail 0\n' }),
    });
    checker.checkText('Ran `npm test`, 1 passed.\nRan `npm test`, 1 passed.');
    await checker.drain(5000);
    const summary = checker.summary();
    assert.equal(summary.checked, 1);
    assert.equal(summary.confirmed, 1);
    assert.equal(summary.breaches, 0);
  });

  test('a check that never finishes is unknown after the drain cap, not lost', async () => {
    const never = () => new Promise(() => {});
    const checker = createClaimChecker({ run: never });
    checker.checkText('Ran `npm test`, 1 passed.');
    await checker.drain(200);
    const summary = checker.summary();
    assert.equal(summary.checked, 1);
    assert.equal(summary.unknown, 1);
    assert.match(summary.checks[0].note, /did not finish before session end/);
  });
});

describe('live session claim checks (M15 slice 2)', () => {
  test('false test claim is a breach in the ledger + summary, session still exits 0 without enforce', async () => {
    const dir = makeTempDir();
    try {
      const stream = codexStream(codexMessage('Ran `npm test`, 1 passed, 0 failed. All green.'));
      const agent = printerScript(dir, stream);
      const out = collectStdout();
      const result = await runLiveSession({
        command: [process.execPath, agent],
        adapter: 'codex',
        agentRunId: 'live_claims_test',
        ledgerPath: join(dir, 'ledger.jsonl'),
        stdout: out.writable,
        printSummary: false,
        claims: {
          cwd: dir,
          run: fakeRun({ exit: 1, output: '# pass 0\n# fail 1\n' }),
        },
      });
      assert.equal(result.exitCode, 0);
      assert.deepEqual(
        { checked: result.summary.claims.checked, breaches: result.summary.claims.breaches },
        { checked: 1, breaches: 1 },
      );
      assert.equal(result.summary.claims.enforced, false);
      const ledger = readFileSync(result.ledgerPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      const checkLines = ledger.filter((entry) => entry.event === 'claim_check');
      assert.equal(checkLines.length, 1);
      assert.equal(checkLines[0].verdict, 'breach');
      assert.equal(checkLines[0].claim, 'npm test');
      assert.match(checkLines[0].note, /exit: claimed 0, replayed 1/);
      // Live claim verdicts equal a post-hoc replay of the saved stream.
      const proof = await verifyClaimsFromStream(readFileSync(result.streamPath, 'utf8'), {
        cwd: dir,
        run: fakeRun({ exit: 1, output: '# pass 0\n# fail 1\n' }),
      });
      assert.deepEqual(
        proof.checks.map(({ verdict }) => verdict),
        result.summary.claims.checks.map(({ verdict }) => verdict),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('file claim confirms when the file exists, breaches when it does not', async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, 'made.js'), 'x');
      const stream = codexStream(codexMessage('Created `made.js` and created `ghost.js`.'));
      const agent = printerScript(dir, stream);
      const out = collectStdout();
      const result = await runLiveSession({
        command: [process.execPath, agent],
        adapter: 'codex',
        agentRunId: 'live_claims_test',
        ledgerPath: join(dir, 'ledger.jsonl'),
        stdout: out.writable,
        printSummary: false,
        claims: { cwd: dir, run: fakeRun() },
      });
      assert.deepEqual(
        result.summary.claims.checks.map((check) => `${check.path}:${check.verdict}`),
        ['made.js:confirmed', 'ghost.js:breach'],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('enforce kills a running agent on breach and ends non-zero', async () => {
    const dir = makeTempDir();
    try {
      const agent = join(dir, 'slow-agent.mjs');
      writeFileSync(agent, [
        `process.stdout.write(${JSON.stringify(codexStream(codexMessage('Ran `npm test`, 1 passed, 0 failed.')))});`,
        'setTimeout(() => {}, 60000);',
        '',
      ].join('\n'));
      const out = collectStdout();
      const started = Date.now();
      const result = await runLiveSession({
        command: [process.execPath, agent],
        adapter: 'codex',
        agentRunId: 'live_claims_enforce',
        ledgerPath: join(dir, 'ledger.jsonl'),
        stdout: out.writable,
        printSummary: false,
        claims: {
          cwd: dir,
          enforce: true,
          run: fakeRun({ exit: 1, output: '# pass 0\n# fail 1\n' }),
        },
      });
      assert.equal(result.summary.claims.breaches, 1);
      assert.equal(result.summary.claims.enforced, true);
      assert.equal(result.signal, 'SIGTERM');
      assert.equal(result.exitCode, 143);
      assert.ok(Date.now() - started < 30000, 'enforce must kill promptly, not wait out the 60s sleep');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('enforce forces exit 1 when the breach is confirmed after a clean agent exit', async () => {
    const dir = makeTempDir();
    try {
      const stream = codexStream(codexMessage('Ran `npm test`, 1 passed, 0 failed.'));
      const agent = printerScript(dir, stream);
      const out = collectStdout();
      const result = await runLiveSession({
        command: [process.execPath, agent],
        adapter: 'codex',
        agentRunId: 'live_claims_enforce_late',
        ledgerPath: join(dir, 'ledger.jsonl'),
        stdout: out.writable,
        printSummary: false,
        claims: {
          cwd: dir,
          enforce: true,
          run: async () => {
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
            return { exit: 1, timedOut: false, spawnError: null, output: '# pass 0\n# fail 1\n', outputTail: '', durationMs: 300 };
          },
        },
      });
      assert.equal(result.summary.claims.breaches, 1);
      assert.equal(result.exitCode, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('extractBareTestClaim (M15 slice 2)', () => {
  test('"All tests pass" infers npm test when the repo defines a test script', () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
      const claims = extractBareTestClaim('All tests pass.', { cwd: dir });
      assert.equal(claims.length, 1);
      assert.equal(claims[0].command, 'npm test');
      assert.equal(claims[0].inferred, true);
      assert.equal(claims[0].claimedFailed, 0);
      assert.equal(claims[0].claimedPassed, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('no test script, or an explicit command claim, yields no inferred claim', () => {
    const dir = makeTempDir();
    try {
      assert.deepEqual(extractBareTestClaim('All tests pass.', { cwd: dir }), []);
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
      const claims = extractSessionClaims('Ran `node --test` and all tests pass.', { cwd: dir });
      assert.equal(claims.filter((claim) => claim.inferred).length, 0);
      assert.equal(claims.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a bare pass claim over a failing suite is a breach via the default command', async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
      writeFileSync(join(dir, 'fail.test.js'), [
        "import { test } from 'node:test';",
        "import assert from 'node:assert/strict';",
        "test('always fails', () => assert.equal(1, 2));",
        '',
      ].join('\n'));
      const stream = codexStream(codexMessage('All tests pass.'));
      const agent = printerScript(dir, stream);
      const out = collectStdout();
      const result = await runLiveSession({
        command: [process.execPath, agent],
        adapter: 'codex',
        agentRunId: 'live_bare_claim',
        ledgerPath: join(dir, 'ledger.jsonl'),
        stdout: out.writable,
        printSummary: false,
        claims: { cwd: dir },
      });
      assert.equal(result.summary.claims.checked, 1);
      assert.equal(result.summary.claims.breaches, 1);
      assert.equal(result.summary.claims.checks[0].inferred, true);
      assert.equal(result.summary.claims.checks[0].command, 'npm test');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('pi adapter (M15 slice 2)', () => {
  const piReal = readFileSync(join(REPO_ROOT, 'test', 'fixtures', 'agent-stream', 'pi-real-list-files.ndjson'), 'utf8');

  test('maps a real pi stream: assistant text + one executed tool call, no double count', () => {
    const events = [];
    for (const line of piReal.split('\n')) {
      if (!line.trim()) continue;
      events.push(...normalizeAgentEvents(line, { adapter: 'pi_cli', seq: events.length }));
    }
    assert.deepEqual(events.map((event) => event.event), [
      'agent_start', 'message_end', 'tool_start', 'tool_end', 'agent_end',
    ]);
    assert.equal(events[1].text, "I'll list the files in src/ using the read tool.");
    assert.equal(events[2].tool, 'bash');
    assert.equal(events[2].tool_call_id, events[3].tool_call_id);
    assert.equal(events[3].status, 'completed');
    assert.equal(events[3].exit_code, 0);
  });

  test('live session over the real pi fixture: pairing clean, message text feeds claims', async () => {
    const dir = makeTempDir();
    try {
      const agent = printerScript(dir, piReal);
      const out = collectStdout();
      const result = await runLiveSession({
        command: [process.execPath, agent],
        adapter: 'pi',
        agentRunId: 'live_pi_test',
        ledgerPath: join(dir, 'ledger.jsonl'),
        stdout: out.writable,
        printSummary: false,
        claims: { cwd: dir, run: fakeRun() },
      });
      assert.equal(result.exitCode, 0);
      assert.deepEqual(result.summary.pairing, {
        tool_starts: 1,
        tool_ends: 1,
        paired: 1,
        violations: [],
        open_at_exit: [],
        verdict: 'paired',
      });
      assert.equal(result.summary.claims.checked, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('CLI: xflow live --enforce (M15 slice 2)', () => {
  test('--help documents --enforce and --no-claims', () => {
    const result = spawnSync('node', ['bin/xflow.js', 'live', '--help'], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 15000,
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /--enforce/);
    assert.match(result.stdout, /--no-claims/);
    assert.match(result.stdout, /claim_check/);
  });

  test('end-to-end: a real failing replay behind a false claim is caught and --enforce exits non-zero', async () => {
    const dir = makeTempDir();
    try {
      // A genuinely failing test file: the replay really runs it.
      writeFileSync(join(dir, 'fail.test.js'), [
        "import { test } from 'node:test';",
        "import assert from 'node:assert/strict';",
        "test('always fails', () => assert.equal(1, 2));",
        '',
      ].join('\n'));
      const stream = codexStream(
        codexMessage('Ran `node --test fail.test.js`, 1 passed, 0 failed. All green.'),
      );
      const agent = printerScript(dir, stream);
      const result = spawnSync('node', [join(REPO_ROOT, 'bin', 'xflow.js'), 'live', '--enforce', '--', process.execPath, agent], {
        cwd: dir, encoding: 'utf8', timeout: 60000,
      });
      assert.notEqual(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stderr, /claims: 1 checked, 0 confirmed, 1 breaches, 0 unknown/);
      assert.match(result.stderr, /exit: claimed 0, replayed 1/);
      const ledgerPath = result.stderr.match(/ledger: (.*)/)[1].trim();
      assert.ok(existsSync(ledgerPath));
      const summary = JSON.parse(readFileSync(join(dir, '.xflow', 'live', result.stderr.match(/live session (\S+) finished/)[1], 'summary.json'), 'utf8'));
      assert.equal(summary.claims.breaches, 1);
      assert.equal(summary.claims.checks[0].kind, 'test_run');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
