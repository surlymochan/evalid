import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  LANGSMITH_FEEDBACK_KEY,
  LangSmithConfigError,
  buildFeedbackComment,
  createLangSmithClient,
  extractRunText,
  mapRunTreeToSession,
  runLangSmithVerify,
  scoreForSummary,
} from '../src/core/langsmith-bridge.js';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const FIXTURE = JSON.parse(
  readFileSync(join(REPO_ROOT, 'test/fixtures/langsmith/runs.json'), 'utf8'),
);

/**
 * A fake LangSmith client with the surface the bridge uses: an async
 * iterable listRuns (filtered like the server: project / isRoot /
 * traceId) and a recording createFeedback that can be told to fail.
 */
class FakeLangSmithClient {
  constructor(runs, { failFeedback = false } = {}) {
    this.runs = runs;
    this.failFeedback = failFeedback;
    this.feedbackCalls = [];
    this.listCalls = [];
  }

  async *listRuns(params = {}) {
    this.listCalls.push(params);
    for (const run of this.runs) {
      if (params.projectName && run._project !== params.projectName) continue;
      if (params.isRoot && run.parent_run_id) continue;
      if (params.traceId && run.trace_id !== params.traceId) continue;
      yield run;
    }
  }

  async createFeedback(params) {
    this.feedbackCalls.push(params);
    if (this.failFeedback) throw new Error('fixture feedback outage');
    return { id: `fb-${this.feedbackCalls.length}` };
  }
}

function traceRuns(traceId) {
  return FIXTURE.runs.filter((run) => run.trace_id === traceId);
}

/** A temp workspace where trace A's true claims are actually true. */
function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'evalid-langsmith-'));
  writeFileSync(join(dir, 'pass.test.mjs'), [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "test('fixture pass', () => { assert.equal(1, 1); });",
    '',
  ].join('\n'));
  writeFileSync(join(dir, 'fail.test.mjs'), [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "test('fixture fail', () => { assert.equal(1, 2); });",
    '',
  ].join('\n'));
  writeFileSync(join(dir, 'real.txt'), 'fixture\n');
  return dir;
}

describe('langsmith bridge — run text extraction', () => {
  test('accepts the recorded output shapes, ignores structured payloads', () => {
    assert.deepEqual(extractRunText({ outputs: 'plain words' }), ['plain words']);
    assert.deepEqual(extractRunText({ outputs: { content: 'content words' } }), ['content words']);
    assert.deepEqual(
      extractRunText({ outputs: { content: [{ type: 'text', text: 'block one' }, { type: 'image', source: 'x' }] } }),
      ['block one'],
    );
    assert.deepEqual(
      extractRunText({ outputs: { generations: [[{ text: 'gen words' }]] } }),
      ['gen words'],
    );
    assert.deepEqual(
      extractRunText({ outputs: { message: { kwargs: { content: 'chat words' } } } }),
      ['chat words'],
    );
    assert.deepEqual(extractRunText({ outputs: { result: { nested: true } } }), []);
    assert.deepEqual(extractRunText({ outputs: null }), []);
    assert.deepEqual(extractRunText({}), []);
  });

  test('the same text under two shapes is returned once', () => {
    const run = { outputs: { content: 'same', output: 'same' } };
    assert.deepEqual(extractRunText(run), ['same']);
  });
});

describe('langsmith bridge — mapping', () => {
  test('one trace maps to one session: prose only from agent runs, in time order', () => {
    const shuffled = [...traceRuns('trace-a')].reverse();
    const session = mapRunTreeToSession(shuffled, { project: FIXTURE.project });
    assert.equal(session.traceId, 'trace-a');
    assert.equal(session.sessionId, 'sess-fixture');
    assert.equal(session.rootRunId, 'run-a-root');
    assert.equal(session.runCount, 4);
    assert.deepEqual(
      session.messages.map((message) => message.runId),
      ['run-a-root', 'run-a-llm-1', 'run-a-llm-2'],
    );
    // The tool run's output text is claim-shaped on purpose: it must not
    // appear as agent prose anywhere in the session.
    assert.ok(session.messages.every((message) => !message.text.includes('99 passed')));
    assert.equal(session.toolRuns.length, 1);
    assert.equal(session.toolRuns[0].name, 'shell');
    assert.deepEqual(session.errors, []);
  });

  test('an errored run is carried as a run error, not prose', () => {
    const session = mapRunTreeToSession(traceRuns('trace-b'), { project: FIXTURE.project });
    assert.equal(session.rootRunId, 'run-b-root');
    assert.equal(session.messages.length, 0);
    assert.equal(session.errors.length, 1);
    assert.match(session.errors[0].error, /provider timeout/);
  });
});

describe('langsmith bridge — client resolution', () => {
  test('missing LANGSMITH_API_KEY is a hard, named error', async () => {
    await assert.rejects(
      () => createLangSmithClient({ env: {} }),
      (error) => error instanceof LangSmithConfigError && /LANGSMITH_API_KEY/.test(error.message),
    );
  });

  test('an injected factory receives the key and endpoint from env', async () => {
    const seen = [];
    const client = await createLangSmithClient({
      env: { LANGSMITH_API_KEY: 'fixture-key', LANGSMITH_ENDPOINT: 'https://example.invalid' },
      createClient: (config) => { seen.push(config); return { fake: true }; },
    });
    assert.deepEqual(client, { fake: true });
    assert.deepEqual(seen, [{ apiKey: 'fixture-key', endpoint: 'https://example.invalid' }]);
  });

  test('score is confirmed/checked, null when nothing was checked', () => {
    assert.equal(scoreForSummary({ checked: 4, confirmed: 2 }), 0.5);
    assert.equal(scoreForSummary({ checked: 0, confirmed: 0 }), null);
    assert.equal(scoreForSummary(null), null);
  });
});

describe('langsmith bridge — full chain on fixtures', () => {
  test('dry-run verifies both traces and writes nothing back', async () => {
    const dir = makeWorkspace();
    try {
      const client = new FakeLangSmithClient(FIXTURE.runs);
      const result = await runLangSmithVerify({
        client, project: FIXTURE.project, cwd: dir, dryRun: true, env: {},
      });
      assert.equal(result.traces.length, 2);
      const [a, b] = result.traces;
      assert.equal(a.traceId, 'trace-a');
      assert.equal(a.claims.checked, 4);
      assert.equal(a.claims.confirmed, 2);
      assert.equal(a.claims.breaches, 2);
      assert.equal(a.claims.unknown, 0);
      assert.equal(a.score, 0.5);
      assert.equal(a.feedback.dryRun, true);
      assert.equal(a.feedback.wouldWrite.key, LANGSMITH_FEEDBACK_KEY);
      assert.equal(a.feedback.wouldWrite.runId, 'run-a-root');
      assert.equal(a.feedback.wouldWrite.score, 0.5);
      assert.match(a.feedback.wouldWrite.comment, /\[breach\] file_created ghost\.txt/);
      assert.match(a.feedback.wouldWrite.comment, /\[confirmed\] test_run `node --test pass\.test\.mjs`/);
      assert.equal(b.traceId, 'trace-b');
      assert.equal(b.score, null);
      assert.deepEqual(b.feedback, { written: false, reason: 'no_claims' });
      assert.equal(b.runErrors.length, 1);
      assert.equal(client.feedbackCalls.length, 0);
      assert.equal(result.writeFailures, 0);
      assert.equal(result.totals.feedbackWritten, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('write mode posts one feedback, on the root run, with the standard key', async () => {
    const dir = makeWorkspace();
    try {
      const client = new FakeLangSmithClient(FIXTURE.runs);
      const result = await runLangSmithVerify({
        client, project: FIXTURE.project, cwd: dir, env: {},
      });
      assert.equal(client.feedbackCalls.length, 1);
      const call = client.feedbackCalls[0];
      assert.equal(call.runId, 'run-a-root');
      assert.equal(call.sessionId, 'sess-fixture');
      assert.equal(call.key, LANGSMITH_FEEDBACK_KEY);
      assert.equal(call.score, 0.5);
      assert.equal(call.feedbackSourceType, 'api');
      assert.match(call.comment, /claims: 4 checked — 2 confirmed, 2 breach, 0 unknown/);
      const [a] = result.traces;
      assert.deepEqual(a.feedback, { written: true, id: 'fb-1' });
      assert.equal(result.totals.feedbackWritten, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a failed feedback write surfaces and the local result survives intact', async () => {
    const dir = makeWorkspace();
    try {
      const client = new FakeLangSmithClient(FIXTURE.runs, { failFeedback: true });
      const result = await runLangSmithVerify({
        client, project: FIXTURE.project, cwd: dir, env: {},
      });
      assert.equal(result.writeFailures, 1);
      const [a] = result.traces;
      assert.equal(a.feedback.written, false);
      assert.match(a.feedback.error, /fixture feedback outage/);
      // The verdicts are all still here for the caller to persist.
      assert.equal(a.claims.checked, 4);
      assert.equal(a.score, 0.5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an empty project yields no traces and no feedback', async () => {
    const client = new FakeLangSmithClient([]);
    const result = await runLangSmithVerify({
      client, project: 'nothing-here', cwd: process.cwd(), env: {},
    });
    assert.deepEqual(result.traces, []);
    assert.equal(result.totals.traces, 0);
    assert.equal(client.feedbackCalls.length, 0);
  });

  test('the feedback comment names every claim with its evidence note', () => {
    const session = mapRunTreeToSession(traceRuns('trace-a'), { project: FIXTURE.project });
    const comment = buildFeedbackComment(session, {
      checked: 1, confirmed: 0, breaches: 1, unknown: 0,
      checks: [{
        kind: 'test_run', verdict: 'breach', command: 'node --test fail.test.mjs',
        note: 'passed count: claimed 1, replayed 0', source: 'Ran it, 1 passed.',
      }],
    });
    assert.match(comment, /trace trace-a · root run run-a-root/);
    assert.match(comment, /\[breach\] test_run `node --test fail\.test\.mjs` — passed count: claimed 1, replayed 0 — source: "Ran it, 1 passed\."/);
  });
});

describe('langsmith bridge — CLI', () => {
  function runCli(args, envOverrides = {}) {
    const env = { ...process.env };
    delete env.LANGSMITH_API_KEY;
    delete env.LANGSMITH_PROJECT;
    Object.assign(env, envOverrides);
    return spawnSync(process.execPath, [join(REPO_ROOT, 'bin/xflow.js'), ...args], {
      cwd: REPO_ROOT, env, encoding: 'utf8', timeout: 30_000,
    });
  }

  test('verify without an API key exits 2 and names the missing env var', () => {
    const result = runCli(['langsmith', 'verify', '--project', 'fixture-agents']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /LANGSMITH_API_KEY/);
  });

  test('verify without a project exits 2', () => {
    const result = runCli(['langsmith', 'verify'], { LANGSMITH_API_KEY: 'fixture-key' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--project/);
  });

  test('bare `langsmith` prints its help and exits 0', () => {
    const result = runCli(['langsmith']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /langsmith verify/);
  });
});
