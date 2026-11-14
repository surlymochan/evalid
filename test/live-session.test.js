import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Writable } from 'node:stream';

import { checkPairing, normalizeAgentEvents } from '../src/core/agent-stream.js';
import { runLiveSession, summarizePairing } from '../src/core/live-session.js';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const FIXTURES = resolve(REPO_ROOT, 'test', 'fixtures', 'agent-stream');
const codexRealNormalLs = readFileSync(join(FIXTURES, 'codex-real-normal-ls.ndjson'), 'utf8');
const codexRealNormalRead = readFileSync(join(FIXTURES, 'codex-real-normal-read.ndjson'), 'utf8');
const codexRealKilledSleep = readFileSync(join(FIXTURES, 'codex-real-killed-sleep.ndjson'), 'utf8');
// M15 slice 1 (#193): verbatim recording of a real codex run wrapped by xflow live (gocc, 2026-11-14).
const codexRealLiveM15s1 = readFileSync(join(FIXTURES, 'codex-real-live-m15s1.ndjson'), 'utf8');

const FIXED_TS = '2026-11-14T09:00:00.000Z';

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'evalid-live-session-'));
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

/**
 * Post-hoc proof, computed independently of the live tracker: replay the saved
 * raw stream through normalizeAgentEvents + checkPairing, appending a
 * synthetic agent_end when the stream never emitted one (the documented rule).
 */
function proveStream(streamText, adapter = 'codex') {
  const events = [];
  for (const line of streamText.split('\n')) {
    if (!line.trim()) continue;
    events.push(...normalizeAgentEvents(line, { adapter: adapter === 'codex' ? 'codex_cli' : 'claude_cli', seq: events.length }));
  }
  return summarizePairing(events);
}

describe('live session (M15 slice 1)', () => {
  test('wraps a normal real codex stream: stdout is byte-identical, pairing is clean', async () => {
    const dir = makeTempDir();
    try {
      const agent = printerScript(dir, codexRealNormalLs);
      const out = collectStdout();
      const result = await runLiveSession({
        command: [process.execPath, agent],
        adapter: 'codex',
        agentRunId: 'live_test',
        ledgerPath: join(dir, 'ledger.jsonl'),
        stdout: out.writable,
        printSummary: false,
        clock: () => FIXED_TS,
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.signal, null);
      assert.deepEqual(out.bytes(), Buffer.from(codexRealNormalLs), 'agent output must pass through unmodified');
      assert.deepEqual(result.summary.pairing, {
        tool_starts: 2,
        tool_ends: 2,
        paired: 2,
        violations: [],
        open_at_exit: [],
        verdict: 'paired',
      });

      const ledgerLines = readFileSync(result.ledgerPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.equal(ledgerLines.length, result.summary.events);
      assert.ok(ledgerLines.every((entry) => entry.ts === FIXED_TS && Number.isInteger(entry.seq)));
      assert.deepEqual(ledgerLines.map((entry) => entry.pairing), [
        'n/a', 'n/a', 'open', 'paired', 'open', 'paired', 'n/a', 'n/a',
      ]);
      assert.equal(readFileSync(result.streamPath, 'utf8'), codexRealNormalLs);
      assert.deepEqual(JSON.parse(readFileSync(result.summaryPath, 'utf8')), result.summary);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('passes the child exit code through', async () => {
    const dir = makeTempDir();
    try {
      const agent = join(dir, 'exit3.mjs');
      writeFileSync(agent, 'process.stdout.write(\'{"type":"thread.started"}\\n\');\nprocess.exit(3);\n');
      const out = collectStdout();
      const result = await runLiveSession({
        command: [process.execPath, agent],
        adapter: 'codex',
        agentRunId: 'live_test',
        ledgerPath: join(dir, 'ledger.jsonl'),
        stdout: out.writable,
        printSummary: false,
        clock: () => FIXED_TS,
      });
      assert.equal(result.exitCode, 3);
      assert.equal(result.summary.exit_code, 3);
      assert.equal(result.summary.pairing.verdict, 'paired');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('kill scenario: a SIGKILLed child leaves the open call unpaired_at_agent_end', async () => {
    const dir = makeTempDir();
    try {
      const agent = join(dir, 'selfkill.mjs');
      writeFileSync(agent, [
        'const line = \'{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"sleep 45","status":"in_progress"}}\\n\';',
        'process.stdout.write(line, () => process.kill(process.pid, \'SIGKILL\'));',
        '',
      ].join('\n'));
      const out = collectStdout();
      const result = await runLiveSession({
        command: [process.execPath, agent],
        adapter: 'codex',
        agentRunId: 'live_test',
        ledgerPath: join(dir, 'ledger.jsonl'),
        stdout: out.writable,
        printSummary: false,
        clock: () => FIXED_TS,
      });
      assert.equal(result.signal, 'SIGKILL');
      assert.equal(result.exitCode, 137);
      assert.deepEqual(result.summary.pairing.violations, [
        { kind: 'unpaired_at_agent_end', tool_call_id: 'item_1', seq: 1 },
      ]);
      assert.deepEqual(result.summary.pairing.open_at_exit, [
        { tool_call_id: 'item_1', tool: 'shell' },
      ]);
      assert.equal(result.summary.pairing.verdict, 'violations');
      const ledgerLines = readFileSync(result.ledgerPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.equal(ledgerLines[0].pairing, 'open');
      assert.equal(ledgerLines[0].tool_call_id, 'item_1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('out-of-order stream: tool_end before tool_start is flagged exactly like post-hoc proof', async () => {
    const dir = makeTempDir();
    try {
      const stream = [
        '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"ls","exit_code":0,"status":"completed"}}',
        '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"ls","status":"in_progress"}}',
        '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}',
        '',
      ].join('\n');
      const agent = printerScript(dir, stream);
      const out = collectStdout();
      const result = await runLiveSession({
        command: [process.execPath, agent],
        adapter: 'codex',
        agentRunId: 'live_test',
        ledgerPath: join(dir, 'ledger.jsonl'),
        stdout: out.writable,
        printSummary: false,
        clock: () => FIXED_TS,
      });
      assert.deepEqual(out.bytes(), Buffer.from(stream));
      const proof = proveStream(readFileSync(result.streamPath, 'utf8'));
      assert.deepEqual(result.summary.pairing.violations, proof.violations);
      assert.deepEqual(result.summary.pairing.violations, [
        { kind: 'unpaired_tool_end', tool_call_id: 'item_1', seq: 0 },
        { kind: 'unpaired_at_agent_end', tool_call_id: 'item_1', seq: 2 },
      ]);
      assert.equal(result.summary.pairing.paired, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('live summary matches post-hoc proof for the three real codex recordings', async () => {
    const dir = makeTempDir();
    try {
      for (const [name, fixture] of [
        ['normal-ls', codexRealNormalLs],
        ['normal-read', codexRealNormalRead],
        ['killed-sleep', codexRealKilledSleep],
        ['live-m15s1', codexRealLiveM15s1],
      ]) {
        const agent = printerScript(dir, fixture);
        const out = collectStdout();
        const result = await runLiveSession({
          command: [process.execPath, agent],
          adapter: 'codex',
          agentRunId: `live_test_${name}`,
          // One ledger dir per run: stream.ndjson defaults beside the ledger,
          // so sharing a dir across runs would append streams together.
          ledgerPath: join(dir, name, 'ledger.jsonl'),
          stdout: out.writable,
          printSummary: false,
          clock: () => FIXED_TS,
        });
        assert.equal(readFileSync(result.streamPath, 'utf8'), fixture, `${name}: saved stream must be the fixture verbatim`);
        const proof = proveStream(readFileSync(result.streamPath, 'utf8'));
        assert.deepEqual(
          result.summary.pairing,
          proof,
          `${name}: live summary must equal post-hoc proof field by field`,
        );
        assert.deepEqual(
          result.summary.pairing.violations,
          checkPairing(result.events.concat(
            result.events.some((event) => event.event === 'agent_end')
              ? []
              : [{ seq: result.events.length, event: 'agent_end' }],
          )),
          `${name}: violations must equal a direct checkPairing replay`,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('summarizePairing appends a synthetic agent_end for streams that never end', () => {
    const events = [
      { seq: 0, event: 'tool_start', tool: 'shell', tool_call_id: 'item_1' },
    ];
    assert.deepEqual(summarizePairing(events).violations, [
      { kind: 'unpaired_at_agent_end', tool_call_id: 'item_1', seq: 1 },
    ]);
    assert.deepEqual(summarizePairing(events).open_at_exit, [
      { tool_call_id: 'item_1', tool: 'shell' },
    ]);
  });

  test('CLI: xflow live passes stdout through and reports the summary on stderr', async () => {
    const dir = makeTempDir();
    try {
      const agent = printerScript(dir, codexRealNormalLs);
      const result = spawnSync('node', [join(REPO_ROOT, 'bin', 'xflow.js'), 'live', '--', process.execPath, agent], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 15000,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(result.stdout, codexRealNormalLs);
      assert.match(result.stderr, /live session .* finished: exit 0/);
      assert.match(result.stderr, /pairing: 2 tool calls started, 2 ended, 2 paired, 0 violations, verdict paired/);
      assert.match(result.stderr, /ledger: .*ledger\.jsonl/);
      const ledgerPath = result.stderr.match(/ledger: (.*)/)[1].trim();
      assert.ok(existsSync(ledgerPath), 'default ledger must land under cwd/.xflow/live');
      assert.ok(existsSync(join(dir, '.xflow', 'live')), 'default live dir must be project-local');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('CLI: xflow live --help prints usage and exits 0', () => {
    for (const helpArg of ['--help', '-h', 'help']) {
      const result = spawnSync('node', ['bin/xflow.js', 'live', helpArg], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 15000,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /Usage: xflow live/);
    }
  });

  test('CLI: xflow live without an agent command exits 2', () => {
    const result = spawnSync('node', ['bin/xflow.js', 'live'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage: xflow live/);
  });
});
