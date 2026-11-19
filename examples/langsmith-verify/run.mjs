/**
 * langsmith-verify example — M17 slice 2 (#218).
 *
 * Runs the full LangSmith bridge chain end to end without a real API
 * key or any network access:
 *
 *   recorded traces (runs.json)
 *     -> fetch (in-memory fake client, same surface as the SDK)
 *     -> map each trace to a verification session
 *     -> verify with the existing claim pipeline (test runs are really
 *        replayed in workspace/, file claims really checked there)
 *     -> createFeedback recorded in memory on the trace's root run
 *
 * The traces and workspace are the same recorded shapes the bridge
 * tests use (see test/fixtures/langsmith/runs.json): trace A is an
 * agent that claims a passing test run and a created file (both true
 * here), then claims a failing run passed and a file that does not
 * exist (both breaches); trace B errored before saying anything
 * checkable, so it gets no feedback.
 *
 * Usage (from the repo root):
 *   node examples/langsmith-verify/run.mjs
 *
 * Against a real LangSmith project the same chain runs through the
 * CLI — the only difference is the client:
 *   LANGSMITH_API_KEY=... xflow langsmith verify --project <name>
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  LANGSMITH_FEEDBACK_KEY,
  renderLangSmithReport,
  runLangSmithVerify,
} from '../../src/core/langsmith-bridge.js';

const EXAMPLE_DIR = resolve(import.meta.dirname);
const WORKSPACE_DIR = join(EXAMPLE_DIR, 'workspace');

/**
 * The fake client the bridge tests use, trimmed to what this example
 * needs: an async-iterable listRuns (filtered like the server) and a
 * recording createFeedback. No network, no key.
 */
class InMemoryLangSmithClient {
  constructor(runs) {
    this.runs = runs;
    this.feedbackCalls = [];
  }

  async *listRuns(params = {}) {
    for (const run of this.runs) {
      if (params.projectName && run._project !== params.projectName) continue;
      if (params.isRoot && run.parent_run_id) continue;
      if (params.traceId && run.trace_id !== params.traceId) continue;
      yield run;
    }
  }

  async createFeedback(params) {
    this.feedbackCalls.push(params);
    return { id: `fb-${this.feedbackCalls.length}` };
  }
}

const fixture = JSON.parse(
  readFileSync(join(EXAMPLE_DIR, 'runs.json'), 'utf8'),
);
const client = new InMemoryLangSmithClient(fixture.runs);

const result = await runLangSmithVerify({
  client,
  project: fixture.project,
  cwd: WORKSPACE_DIR,
  env: {},
});

console.log(renderLangSmithReport(result));
console.log('');
for (const call of client.feedbackCalls) {
  console.log(`feedback recorded on root run ${call.runId}:`);
  console.log(`  key: ${call.key} (expected ${LANGSMITH_FEEDBACK_KEY})`);
  console.log(`  score: ${call.score}`);
  console.log(`  comment:\n${call.comment.split('\n').map((line) => `    ${line}`).join('\n')}`);
}
console.log('');
console.log(
  'No API key, no network: the traces came from runs.json and the '
  + 'feedback above was recorded in memory. Against a real project, '
  + 'run `LANGSMITH_API_KEY=... xflow langsmith verify --project <name>` '
  + 'and the same chain writes the same feedback to LangSmith.',
);
