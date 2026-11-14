/**
 * live-session — M15 slice 1 (#193): wrap a real agent CLI run and verify
 * tool_use/tool_result pairing while the session is still running.
 *
 * `xflow live -- <agent cmd...>` spawns the agent, passes its stdout through
 * byte-for-byte, and feeds every stream-json line through the M14 pairing
 * state machine (`createPairingTracker` from agent-stream.js — reused, never
 * re-implemented or re-tuned). Each normalized event is appended to the live
 * ledger (JSONL) the moment it is seen, so a killed session still leaves a
 * ledger behind; the raw stream is saved beside it (`stream.ndjson`) so the
 * session can be replayed afterwards.
 *
 * Ledger line (one per normalized event, in stream order):
 *   { seq, ts, event, event_type?, tool?, tool_call_id?, status?, exit_code?,
 *     pairing, violation_kind? }
 * where `pairing` is one of:
 *   - `open`      tool_start opened a call (no violation yet)
 *   - `paired`    tool_end closed the call it names
 *   - `violation` the event committed a pairing breach (`violation_kind` names it)
 *   - `n/a`       the event carries no tool_call_id to pair (agent_start,
 *                 message_end, raw, agent_end with nothing left open)
 *
 * M15 slice 2 (#195) adds claim checks: every `message_end` text is
 * scanned for test-run and file-created claims (live-claims.js) and each
 * claim is verified as the session runs. A completed check appends one
 * extra ledger line — `{ seq, ts, event: 'claim_check', pairing: 'n/a',
 * claim_kind, claim, verdict, note? }` — so ledger lines = normalized
 * events + claim checks, and the summary gains a `claims` object
 * ({checked, confirmed, breaches, unknown, enforced, enforcement,
 * checks}). With `--enforce`, the first confirmed breach kills the
 * child (SIGTERM, SIGKILL after a 2s grace) and the session ends
 * non-zero; a breach confirmed after the agent already exited cleanly
 * still forces exit code 1 in enforce mode.
 *
 * Post-hoc proof, same caliber (`summarizePairing`): replay the saved raw
 * stream through `normalizeAgentEvents` + `checkPairing`; when the stream
 * never emitted `agent_end` (killed session), a synthetic `agent_end` with
 * seq = events.length is appended first, so calls left open are reported as
 * `unpaired_at_agent_end` exactly as the live tracker reports them. The live
 * summary's `pairing` object is built from the same fields — `tool_starts`,
 * `tool_ends`, `paired`, `violations` ({kind, tool_call_id, seq}), `open_at_exit`
 * ({tool_call_id, tool}), `verdict` (`paired` | `violations`) — so live and
 * post-hoc conclusions are comparable field by field.
 *
 * Exit code: the child's exit code is passed through; death by signal maps to
 * 128 + signal number (SIGKILL → 137, SIGTERM → 143). The summary goes to
 * stderr (never stdout: stdout belongs to the agent) and to summary.json.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import {
  checkPairing,
  createLineSplitter,
  createPairingTracker,
  normalizeAgentEvents,
} from './agent-stream.js';
import { createClaimChecker, LIVE_CLAIM_DRAIN_MS } from './live-claims.js';

export const LIVE_LEDGER_VERSION = 1;

const SIGNAL_EXIT_CODES = Object.freeze({
  SIGHUP: 129,
  SIGINT: 130,
  SIGQUIT: 131,
  SIGKILL: 137,
  SIGTERM: 143,
});

const ADAPTER_ALIASES = Object.freeze({
  codex: 'codex_cli',
  claude: 'claude_cli',
  pi: 'pi_cli',
  auto: 'unknown',
});

export function defaultLiveLedgerPath(agentRunId, cwd = process.cwd()) {
  return resolve(cwd, '.xflow', 'live', agentRunId, 'ledger.jsonl');
}

function newAgentRunId() {
  return `live_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}

function verdictFor(event, violations) {
  if (event.event === 'tool_start') {
    return violations.length
      ? { pairing: 'violation', violation_kind: violations[0].kind }
      : { pairing: 'open' };
  }
  if (event.event === 'tool_end') {
    return violations.length
      ? { pairing: 'violation', violation_kind: violations[0].kind }
      : { pairing: 'paired' };
  }
  if (event.event === 'agent_end') {
    return violations.length
      ? { pairing: 'violation', violation_kind: 'unpaired_at_agent_end' }
      : { pairing: 'n/a' };
  }
  return { pairing: 'n/a' };
}

/**
 * Pairing summary for an already-normalized event list — the post-hoc proof.
 * Same fields and same判定语义 as the live summary: violations come from
 * `checkPairing` (the M14 state machine), with a synthetic `agent_end`
 * appended when the stream never emitted one, so a killed run's open calls
 * are reported as `unpaired_at_agent_end` instead of silently vanishing.
 */
export function summarizePairing(events) {
  const list = [...(events ?? [])];
  const hasAgentEnd = list.some((event) => event?.event === 'agent_end');
  if (!hasAgentEnd) list.push({ seq: list.length, event: 'agent_end' });
  const violations = checkPairing(list);

  const tracker = createPairingTracker();
  for (const event of events ?? []) tracker.observe(event);
  const openAtExit = tracker.drainOpen().map(([toolCallId, call]) => ({
    tool_call_id: toolCallId,
    tool: call.tool ?? null,
  }));

  const toolStarts = list.filter((event) => event.event === 'tool_start' && event.tool_call_id).length;
  const toolEnds = list.filter((event) => event.event === 'tool_end' && event.tool_call_id).length;
  const badEnds = violations.filter(
    (violation) => violation.kind === 'unpaired_tool_end' || violation.kind === 'duplicate_tool_end',
  ).length;

  return {
    tool_starts: toolStarts,
    tool_ends: toolEnds,
    paired: toolEnds - badEnds,
    violations: violations.map(({ kind, tool_call_id, seq }) => ({ kind, tool_call_id, seq })),
    open_at_exit: openAtExit,
    verdict: violations.length ? 'violations' : 'paired',
  };
}

/**
 * Wrap one agent CLI invocation. Options:
 *   command      [program, ...args] (required)
 *   adapter      'codex' | 'claude' | 'pi' | 'auto' (default 'auto')
 *   ledgerPath   live ledger file (default .xflow/live/<run-id>/ledger.jsonl)
 *   streamPath   raw stream file (default <ledger dir>/stream.ndjson)
 *   summaryPath  summary file (default <ledger dir>/summary.json)
 *   agentRunId   injectable run id (default generated)
 *   stdout/stderr writable sinks (default process.stdout / process.stderr)
 *   spawn        injectable spawn (default node:child_process spawn)
 *   clock        () => ISO timestamp string (default () => new Date().toISOString())
 *   printSummary true to print the summary to stderr (default true)
 *   jsonSummary  true to print the summary as JSON instead of human lines
 *   claims       { enabled, cwd, timeoutMs, enforce, run, drainMs } —
 *                live claim verification (M15 slice 2, #195). enabled
 *                defaults to true; cwd defaults to process.cwd();
 *                timeoutMs per claim defaults to 120_000; enforce
 *                (default false) kills the child on the first confirmed
 *                breach and forces a non-zero exit; run is an injectable
 *                test-command runner; drainMs caps the post-exit wait
 *                for pending checks (default 300_000).
 *
 * Resolves (never rejects for a child failure) with
 *   { exitCode, signal, agentRunId, ledgerPath, streamPath, summaryPath,
 *     events, summary, error? }
 * where `summary` is the object also written to summary.json.
 */
export async function runLiveSession(options = {}) {
  const command = options.command;
  if (!Array.isArray(command) || command.length === 0) {
    throw new Error('runLiveSession requires a non-empty command array');
  }
  const agentRunId = typeof options.agentRunId === 'string' && options.agentRunId
    ? options.agentRunId
    : newAgentRunId();
  const ledgerPath = resolve(options.ledgerPath || defaultLiveLedgerPath(agentRunId));
  const ledgerDir = dirname(ledgerPath);
  const streamPath = resolve(options.streamPath || resolve(ledgerDir, 'stream.ndjson'));
  const summaryPath = resolve(options.summaryPath || resolve(ledgerDir, 'summary.json'));
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const spawnFn = options.spawn || spawn;
  const clock = typeof options.clock === 'function' ? options.clock : () => new Date().toISOString();
  const printSummary = options.printSummary !== false;
  const jsonSummary = options.jsonSummary === true;
  const adapter = ADAPTER_ALIASES[options.adapter] || 'unknown';

  mkdirSync(ledgerDir, { recursive: true });

  const startedAt = new Date();
  const toolNames = new Map();
  const tracker = createPairingTracker();
  const events = [];
  const violations = [];
  const ledgerErrors = { ledger: 0, stream: 0 };
  let seq = 0;
  let lines = 0;
  let sawAgentEnd = false;

  function appendLedger(record) {
    try {
      appendFileSync(ledgerPath, `${JSON.stringify(record)}\n`);
    } catch {
      ledgerErrors.ledger += 1;
    }
  }

  function appendStream(chunk) {
    try {
      appendFileSync(streamPath, chunk);
    } catch {
      ledgerErrors.stream += 1;
    }
  }

  // M15 slice 2 (#195): live claim verification. The checker runs
  // asynchronously behind a queue; a completed check appends one
  // `claim_check` ledger line (seq drawn from the same counter, so the
  // ledger stays monotonic) and, in enforce mode, a confirmed breach
  // kills the child at once.
  const claimsOptions = options.claims || {};
  const claimsEnabled = claimsOptions.enabled !== false;
  const claimsEnforce = claimsOptions.enforce === true;
  let child = null;
  let enforced = false;
  let enforcement = null;
  let finished = false;
  const checker = claimsEnabled
    ? createClaimChecker({
      cwd: claimsOptions.cwd || process.cwd(),
      timeoutMs: claimsOptions.timeoutMs,
      run: claimsOptions.run,
      onCheck: (check) => {
        appendLedger({
          seq: seq++,
          ts: clock(),
          event: 'claim_check',
          pairing: 'n/a',
          claim_kind: check.kind,
          claim: check.command ?? check.path,
          verdict: check.verdict,
          ...(check.note ? { note: check.note } : {}),
        });
      },
      onBreach: (check) => {
        if (!claimsEnforce || finished || !child || child.killed) return;
        enforced = true;
        enforcement = {
          signal: 'SIGTERM',
          claim: check.command ?? check.path,
          note: check.note ?? null,
          at: clock(),
        };
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
        setTimeout(() => {
          try { if (!child.killed) child.kill('SIGKILL'); } catch { /* already gone */ }
        }, 2000).unref?.();
      },
    })
    : null;

  function onLine(line) {
    if (!line) return;
    lines += 1;
    for (const event of normalizeAgentEvents(line, { adapter, seq, toolNames })) {
      const eventSeq = seq;
      seq += 1;
      events.push(event);
      if (event.event === 'agent_end') sawAgentEnd = true;
      const eventViolations = tracker.observe(event);
      for (const violation of eventViolations) {
        violations.push({ ...violation, seq: eventSeq });
      }
      const record = { seq: eventSeq, ts: clock(), event: event.event, ...verdictFor(event, eventViolations) };
      for (const key of ['event_type', 'tool', 'tool_call_id', 'status', 'exit_code']) {
        if (event[key] !== undefined && event[key] !== null) record[key] = event[key];
      }
      appendLedger(record);
      // Only the agent's own words are claims: tool output is never read.
      if (checker && event.event === 'message_end' && typeof event.text === 'string' && event.text) {
        checker.checkText(event.text);
      }
    }
  }

  const splitter = createLineSplitter(onLine);

  return new Promise((resolvePromise) => {
    let finishing = null;
    try {
      child = spawnFn(command[0], command.slice(1), { stdio: ['inherit', 'pipe', 'inherit'] });
    } catch (error) {
      resolvePromise(finish(127, null, error));
      return;
    }

    child.stdout.on('data', (chunk) => {
      // Passthrough first, byte-for-byte: stdout belongs to the agent.
      try {
        stdout.write(chunk);
      } catch {
        // A broken pipe on our side must not kill the agent run.
      }
      appendStream(chunk);
      splitter.push(chunk);
    });
    child.stdout.on('end', () => splitter.flush());
    child.on('error', (error) => {
      resolvePromise(finish(127, null, error));
    });
    child.on('close', (code, signal) => {
      splitter.flush();
      const exitCode = code !== null && code !== undefined
        ? code
        : (SIGNAL_EXIT_CODES[signal] ?? 128);
      resolvePromise(finish(exitCode, signal, null));
    });

    function finish(exitCode, signal, error) {
      // 'error' (spawn failure) is followed by 'close': finish exactly once.
      if (finishing) return finishing;
      finishing = (async () => {
        finished = true;
        const endedAt = new Date();
        // Wait for in-flight claim checks so the summary reports every
        // claim the session made; checks still pending at the cap are
        // recorded `unknown` by the checker, never guessed.
        if (checker) {
          await checker.drain(claimsOptions.drainMs ?? LIVE_CLAIM_DRAIN_MS);
        }
        const claimsSummary = checker
          ? { ...checker.summary(), enforced, enforcement }
          : { checked: 0, confirmed: 0, breaches: 0, unknown: 0, enforced: false, enforcement: null, checks: [] };
        // Enforce mode guarantees a non-zero exit when a breach was
        // confirmed — even one confirmed after the agent already exited
        // cleanly. A child killed by enforcement already exits non-zero
        // (143 SIGTERM / 137 SIGKILL) and keeps that code.
        let finalExit = exitCode;
        if (claimsEnforce && claimsSummary.breaches > 0 && finalExit === 0) finalExit = 1;
        // A killed session never emits agent_end: close the run through the same
        // state machine so its open calls surface as unpaired_at_agent_end with
        // the same seq the post-hoc proof assigns (events.length).
        if (!sawAgentEnd) {
          const synthetic = { seq, event: 'agent_end' };
          for (const violation of tracker.observe(synthetic)) {
            violations.push({ ...violation, seq });
          }
          appendLedger({ seq, ts: clock(), event: 'agent_end', pairing: 'n/a', synthetic: true });
          seq += 1;
        }
        const openAtExit = tracker.drainOpen().map(([toolCallId, call]) => ({
          tool_call_id: toolCallId,
          tool: call.tool ?? null,
        }));
        const toolStarts = events.filter((event) => event.event === 'tool_start' && event.tool_call_id).length;
        const toolEnds = events.filter((event) => event.event === 'tool_end' && event.tool_call_id).length;
        const badEnds = violations.filter(
          (violation) => violation.kind === 'unpaired_tool_end' || violation.kind === 'duplicate_tool_end',
        ).length;
        const summary = {
          version: LIVE_LEDGER_VERSION,
          agent_run_id: agentRunId,
          command: [...command],
          adapter: options.adapter || 'auto',
          started_at: startedAt.toISOString(),
          ended_at: endedAt.toISOString(),
          duration_ms: endedAt - startedAt,
          exit_code: finalExit,
          signal: signal ?? null,
          ledger_path: ledgerPath,
          stream_path: streamPath,
          summary_path: summaryPath,
          lines,
          events: events.length,
          ledger_write_errors: ledgerErrors.ledger,
          stream_write_errors: ledgerErrors.stream,
          pairing: {
            tool_starts: toolStarts,
            tool_ends: toolEnds,
            paired: toolEnds - badEnds,
            violations: violations.map(({ kind, tool_call_id, seq: violationSeq }) => ({
              kind,
              tool_call_id,
              seq: violationSeq,
            })),
            open_at_exit: openAtExit,
            verdict: violations.length ? 'violations' : 'paired',
          },
          claims: claimsSummary,
        };
        if (error) summary.error = String(error?.message || error);
        try {
          writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
        } catch {
          ledgerErrors.ledger += 1;
        }
        if (printSummary) {
          const claimsLine = claimsEnabled
            ? `claims: ${claimsSummary.checked} checked, ${claimsSummary.confirmed} confirmed, `
              + `${claimsSummary.breaches} breaches, ${claimsSummary.unknown} unknown`
              + (claimsSummary.breaches > 0
                ? ` — first breach: ${claimsSummary.checks.find((check) => check.verdict === 'breach')?.note ?? ''}`
                : '')
              + (enforced ? ' — enforced: session killed on breach' : '')
            : 'claims: disabled';
          const text = jsonSummary
            ? JSON.stringify(summary)
            : [
              `live session ${agentRunId} finished: exit ${finalExit}${signal ? ` (signal ${signal})` : ''}`,
              `pairing: ${toolStarts} tool calls started, ${toolEnds} ended, ${toolEnds - badEnds} paired, `
                + `${violations.length} violations, verdict ${summary.pairing.verdict}`,
              claimsLine,
              `ledger: ${ledgerPath}`,
            ].join('\n');
          try {
            stderr.write(`${text}\n`);
          } catch {
            // Summary delivery must never change the exit code.
          }
        }
        return {
          exitCode: finalExit,
          signal: signal ?? null,
          agentRunId,
          ledgerPath,
          streamPath,
          summaryPath,
          events,
          summary,
          ...(error ? { error: String(error?.message || error) } : {}),
        };
      })();
      return finishing;
    }
  });
}
