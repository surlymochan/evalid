/**
 * langsmith-bridge — M17 slice 1 (#216): evalid as LangSmith's external
 * deterministic judge.
 *
 * LangSmith evaluators score runs after the fact, mostly with an LLM
 * judge, and can only see what the run itself reported. evalid's verdicts
 * come from the opposite direction: claims are extracted from the agent's
 * own words and checked against ground truth (a replayed test run, the
 * filesystem). This bridge wires the two together without moving any
 * judging into LangSmith's sandbox:
 *
 *   listRuns (project root runs + their traces)
 *     -> map each trace to an evalid verification session
 *     -> run the existing claim pipeline (live-claims) locally
 *     -> createFeedback on the root run: key `evalid_claim_verified`,
 *        score = confirmed / checked claims, comment = per-claim
 *        verdicts with evidence pointers.
 *
 * Mapping rules (LangSmith run tree -> evalid verification input):
 *   1. One trace = one coding-agent session: the root run plus every run
 *      in the same trace, ordered by start_time (runs without a time
 *      keep fetch order, after the timed ones).
 *   2. Agent prose — the only claim source, mirroring live-claims' rule
 *      that only the agent's own message text is ever harvested — comes
 *      from textual run outputs (see extractRunText for the accepted
 *      shapes). Tool and retriever runs return environment data, not the
 *      agent speaking: their outputs are never treated as prose, and
 *      tool runs are carried along as evidence records only.
 *   3. Verification runs against a local cwd: test-run claims are
 *      replayed there, file claims are checked there. A trace recorded
 *      against a different workspace yields `unknown` verdicts from the
 *      pipeline, never invented ones — the pipeline's semantics are
 *      unchanged.
 *   4. Score = confirmed / checked (an `unknown` is not verified). A
 *      trace with no claims gets no feedback at all.
 *   5. Feedback targets the trace's ROOT run via the SDK's object-form
 *      createFeedback ({runId, sessionId, key, score, comment,
 *      feedbackSourceType: 'api'}). `traceId` is deliberately not
 *      passed: with it the SDK batches feedback in the background, so a
 *      failed write could vanish; without it the write is synchronous
 *      and a failure rejects here, where the caller records it and keeps
 *      the local results.
 *
 * Credentials: only env `LANGSMITH_API_KEY` (required — missing key is a
 * hard error, nothing is fabricated), optional `LANGSMITH_ENDPOINT`
 * (SDK apiUrl) and `LANGSMITH_PROJECT` (CLI-level default project). The
 * key is never written to disk or logged.
 */
import { createClaimChecker } from './live-claims.js';

export const LANGSMITH_FEEDBACK_KEY = 'evalid_claim_verified';
export const LANGSMITH_DEFAULT_LIMIT = 20;
/** Feedback comments are kept readable in the LangSmith UI. */
export const LANGSMITH_COMMENT_LIMIT = 3500;

export class LangSmithConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LangSmithConfigError';
  }
}

/**
 * Resolve a LangSmith client. Injection order (tests use the first two):
 *   options.client        — an already-built client (or fake)
 *   options.createClient  — factory ({apiKey, endpoint}) => client
 *   otherwise             — the official `langsmith` SDK, dynamically
 *                           imported so the rest of the CLI never loads it
 * The API key is read from options.env (default process.env) and is
 * required in every non-injected path — and also when a factory is
 * given, so a misconfigured run fails before any network shape exists.
 */
export async function createLangSmithClient(options = {}) {
  if (options.client) return options.client;
  const env = options.env || process.env;
  const apiKey = env.LANGSMITH_API_KEY;
  if (!apiKey) {
    throw new LangSmithConfigError(
      'LANGSMITH_API_KEY is not set: the LangSmith bridge needs an API key '
      + 'in the environment (Developer-tier keys are free). Refusing to '
      + 'fabricate results without one.',
    );
  }
  const endpoint = env.LANGSMITH_ENDPOINT || undefined;
  if (typeof options.createClient === 'function') {
    return options.createClient({ apiKey, endpoint });
  }
  const { Client } = await import('langsmith');
  return new Client({ apiKey, ...(endpoint ? { apiUrl: endpoint } : {}) });
}

function runField(run, snake, camel) {
  return run?.[snake] ?? run?.[camel] ?? null;
}

function runTime(run) {
  const raw = runField(run, 'start_time', 'startTime');
  const time = raw ? Date.parse(raw) : Number.NaN;
  return Number.isNaN(time) ? null : time;
}

/**
 * Textual prose from one run's outputs, or [] when the outputs carry no
 * agent words. Accepted shapes (LangSmith / LangChain conventions):
 *   - outputs itself a string
 *   - outputs.content / .output / .result / .response (string, or an
 *     array of content blocks with {type:'text', text} / {text})
 *   - outputs.generations[i][j].text (LLM runs)
 *   - outputs.message.kwargs.content, outputs.kwargs.content (serialized
 *     chat messages)
 * Structured payloads yield nothing: they are data, not the agent
 * speaking. Duplicate chunks (the same text under two shapes) are
 * returned once.
 */
export function extractRunText(run) {
  const chunks = [];
  const seen = new Set();
  const push = (value) => {
    const text = textValue(value);
    if (text && !seen.has(text)) {
      seen.add(text);
      chunks.push(text);
    }
  };
  const outputs = run?.outputs;
  if (outputs === null || outputs === undefined) return chunks;
  if (typeof outputs === 'string') {
    push(outputs);
    return chunks;
  }
  if (typeof outputs !== 'object') return chunks;
  push(outputs.content);
  push(outputs.output);
  push(outputs.result);
  push(outputs.response);
  if (Array.isArray(outputs.generations)) {
    for (const row of outputs.generations) {
      for (const generation of Array.isArray(row) ? row : [row]) {
        push(generation?.text);
        push(generation?.message?.kwargs?.content);
      }
    }
  }
  push(outputs.message?.kwargs?.content);
  push(outputs.kwargs?.content);
  return chunks;
}

function textValue(value) {
  if (typeof value === 'string') return value.trim() ? value : null;
  if (Array.isArray(value)) {
    const parts = [];
    for (const block of value) {
      if (typeof block === 'string') parts.push(block);
      else if (block && typeof block === 'object' && typeof block.text === 'string') parts.push(block.text);
    }
    const joined = parts.join('\n');
    return joined.trim() ? joined : null;
  }
  return null;
}

/**
 * Map one fetched trace (root run + descendants, any fetch order) to the
 * bridge's session shape — the verification input the pipeline consumes.
 * Fetch-level problems are not mapped here; see fetchProjectTraces.
 */
export function mapRunTreeToSession(runs, options = {}) {
  const list = Array.isArray(runs) ? [...runs] : [];
  const sorted = list
    .map((run, index) => ({ run, index, time: runTime(run) }))
    .sort((a, b) => {
      if (a.time === null && b.time === null) return a.index - b.index;
      if (a.time === null) return 1;
      if (b.time === null) return -1;
      return a.time - b.time || a.index - b.index;
    })
    .map((entry) => entry.run);
  const root = sorted.find((run) => !runField(run, 'parent_run_id', 'parentRunId')) || sorted[0] || null;
  const messages = [];
  const toolRuns = [];
  const errors = [];
  for (const run of sorted) {
    const runType = runField(run, 'run_type', 'runType');
    if (runType !== 'tool' && runType !== 'retriever') {
      for (const text of extractRunText(run)) {
        messages.push({ runId: run.id ?? null, runName: run.name ?? null, runType, text });
      }
    }
    if (runType === 'tool') {
      toolRuns.push({
        runId: run.id ?? null,
        name: run.name ?? null,
        inputs: run.inputs ?? null,
        outputs: run.outputs ?? null,
        error: run.error ? String(run.error) : null,
      });
    }
    if (run.error) {
      errors.push({ runId: run.id ?? null, name: run.name ?? null, error: String(run.error) });
    }
  }
  return {
    project: options.project ?? null,
    traceId: root ? (runField(root, 'trace_id', 'traceId') ?? root.id ?? null) : null,
    sessionId: root ? runField(root, 'session_id', 'sessionId') : null,
    rootRunId: root?.id ?? null,
    rootRunName: root?.name ?? null,
    startedAt: root ? runField(root, 'start_time', 'startTime') : null,
    runCount: sorted.length,
    messages,
    toolRuns,
    errors,
  };
}

/**
 * Fetch up to `limit` root runs of a project plus each root's full
 * trace. Returns [{root, runs, fetchError}] — a trace whose child fetch
 * fails degrades to its root run alone, with the failure recorded
 * instead of silently dropping the children.
 */
export async function fetchProjectTraces(client, options = {}) {
  const project = options.project;
  const limit = options.limit ?? LANGSMITH_DEFAULT_LIMIT;
  const listParams = { projectName: project, order: 'desc' };
  if (options.startTime) listParams.startTime = options.startTime;
  const roots = [];
  for await (const run of client.listRuns({ ...listParams, isRoot: true })) {
    roots.push(run);
    if (roots.length >= limit) break;
  }
  const traces = [];
  for (const root of roots) {
    const traceId = runField(root, 'trace_id', 'traceId') ?? root.id;
    let runs = [root];
    let fetchError = null;
    try {
      const all = [];
      for await (const run of client.listRuns({ ...listParams, traceId })) {
        all.push(run);
      }
      if (all.length > 0) runs = all;
    } catch (error) {
      fetchError = String(error?.message || error);
    }
    traces.push({ root, runs, fetchError });
  }
  return traces;
}

/**
 * Verify one mapped session with the existing pipeline. Every message's
 * prose is fed to one claim checker (per-session dedup, exactly the live
 * session's semantics); options mirror the checker's: cwd, timeoutMs,
 * and an injectable replay `run`.
 */
export async function verifySession(session, options = {}) {
  const checker = createClaimChecker({
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    run: options.run,
  });
  for (const message of session?.messages || []) {
    checker.checkText(message.text);
  }
  await checker.drain(options.drainMs);
  return checker.summary();
}

/** confirmed / checked, to the 4 decimals the feedback API stores. */
export function scoreForSummary(summary) {
  if (!summary || !summary.checked) return null;
  return Math.round((summary.confirmed / summary.checked) * 10000) / 10000;
}

/**
 * The feedback comment: score line, then one line per claim with its
 * verdict, the pipeline's evidence note, and the claim's source text —
 * the pointer a reader follows back to the agent's own words.
 */
export function buildFeedbackComment(session, summary) {
  const lines = [
    'evalid claim verification — deterministic replay, zero-judge.',
    `trace ${session?.traceId ?? '?'} · root run ${session?.rootRunId ?? '?'}`,
    `claims: ${summary.checked} checked — ${summary.confirmed} confirmed, `
      + `${summary.breaches} breach, ${summary.unknown} unknown `
      + `(score = confirmed/checked = ${scoreForSummary(summary)})`,
  ];
  for (const check of summary.checks || []) {
    const subject = check.kind === 'file_created'
      ? `file_created ${check.path}`
      : `test_run \`${check.command}\``;
    const parts = [`- [${check.verdict}] ${subject}`];
    if (check.note) parts.push(check.note);
    if (check.source) parts.push(`source: "${check.source}"`);
    lines.push(parts.join(' — '));
  }
  const comment = lines.join('\n');
  if (comment.length <= LANGSMITH_COMMENT_LIMIT) return comment;
  return `${comment.slice(0, LANGSMITH_COMMENT_LIMIT)}\n… (truncated; full verdicts in the local results file)`;
}

/**
 * The full bridge run: fetch -> map -> verify -> (optionally) write
 * feedback. Always returns the complete local result — including when a
 * feedback write fails — so the caller can persist it before reporting
 * the failure. `options` accepts everything the pieces accept, plus:
 *   project (required), limit, startTime, dryRun, env, client,
 *   createClient.
 */
export async function runLangSmithVerify(options = {}) {
  const project = options.project;
  if (!project) {
    throw new LangSmithConfigError(
      'no LangSmith project: pass a project name (CLI: --project or LANGSMITH_PROJECT).',
    );
  }
  const client = await createLangSmithClient(options);
  const fetched = await fetchProjectTraces(client, {
    project,
    limit: options.limit,
    startTime: options.startTime,
  });
  const traces = [];
  for (const item of fetched) {
    const session = mapRunTreeToSession(item.runs, { project });
    const summary = await verifySession(session, options);
    const score = scoreForSummary(summary);
    const entry = {
      traceId: session.traceId,
      rootRunId: session.rootRunId,
      rootRunName: session.rootRunName,
      sessionId: session.sessionId,
      startedAt: session.startedAt,
      runCount: session.runCount,
      fetchError: item.fetchError ?? null,
      runErrors: session.errors,
      claims: summary,
      score,
      feedback: null,
    };
    if (score === null) {
      entry.feedback = { written: false, reason: 'no_claims' };
    } else if (options.dryRun) {
      entry.feedback = {
        written: false,
        dryRun: true,
        wouldWrite: {
          runId: session.rootRunId,
          key: LANGSMITH_FEEDBACK_KEY,
          score,
          comment: buildFeedbackComment(session, summary),
        },
      };
    } else {
      try {
        const feedback = await client.createFeedback({
          runId: session.rootRunId,
          sessionId: session.sessionId,
          key: LANGSMITH_FEEDBACK_KEY,
          score,
          comment: buildFeedbackComment(session, summary),
          feedbackSourceType: 'api',
        });
        entry.feedback = { written: true, id: feedback?.id ?? null };
      } catch (error) {
        entry.feedback = { written: false, error: String(error?.message || error) };
      }
    }
    traces.push(entry);
  }
  const totals = {
    traces: traces.length,
    claimsChecked: traces.reduce((sum, trace) => sum + trace.claims.checked, 0),
    confirmed: traces.reduce((sum, trace) => sum + trace.claims.confirmed, 0),
    breaches: traces.reduce((sum, trace) => sum + trace.claims.breaches, 0),
    unknown: traces.reduce((sum, trace) => sum + trace.claims.unknown, 0),
    feedbackWritten: traces.filter((trace) => trace.feedback?.written).length,
  };
  return {
    project,
    dryRun: Boolean(options.dryRun),
    generatedAt: new Date().toISOString(),
    traces,
    totals,
    writeFailures: traces.filter((trace) => trace.feedback?.error).length,
  };
}

/** Human-readable rendering for the CLI (machine output uses --json). */
export function renderLangSmithReport(result) {
  const lines = [
    `evalid langsmith verify — project "${result.project}"${result.dryRun ? ' (dry-run: nothing written back)' : ''}`,
  ];
  if (result.traces.length === 0) {
    lines.push('no root runs found in this project.');
    return lines.join('\n');
  }
  for (const trace of result.traces) {
    const claims = trace.claims;
    const head = `trace ${trace.traceId} (${trace.runCount} runs) — `
      + `${claims.checked} claims: ${claims.confirmed} confirmed, ${claims.breaches} breach, ${claims.unknown} unknown`;
    lines.push(head);
    if (trace.score === null) {
      lines.push('  feedback: skipped (no claims in agent prose)');
    } else if (trace.feedback?.written) {
      lines.push(`  feedback: written (${LANGSMITH_FEEDBACK_KEY} = ${trace.score})`);
    } else if (trace.feedback?.dryRun) {
      lines.push(`  feedback: dry-run, would write ${LANGSMITH_FEEDBACK_KEY} = ${trace.score} on run ${trace.rootRunId}`);
    } else if (trace.feedback?.error) {
      lines.push(`  feedback: FAILED — ${trace.feedback.error}`);
    }
    if (trace.fetchError) lines.push(`  warning: trace fetch incomplete: ${trace.fetchError}`);
  }
  const totals = result.totals;
  lines.push(
    `total: ${totals.traces} traces, ${totals.claimsChecked} claims checked, `
    + `${totals.feedbackWritten} feedback written.`,
  );
  return lines.join('\n');
}
