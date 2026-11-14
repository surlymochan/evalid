/**
 * live-claims — M15 slice 2 (#195): verify an agent's claims while its
 * session is still running.
 *
 * Slice 1 wrapped a session and checked tool pairing live; it never judged
 * what the agent *said*. This module closes that gap for the two claim
 * kinds the audit already understands:
 *
 *   - test-run claims: "ran `npm test`, 12 passed" — extracted with the
 *     audit's own `extractClaims` and replayed with the audit's match
 *     semantics (exit code, then pass/fail counts when both sides state
 *     them). The replay is async (spawn, not spawnSync) so a long test
 *     run never blocks the agent's stdout passthrough. An unqualified
 *     "all tests pass" with no command named is checked against the
 *     repo's default test command (`npm test`, when package.json
 *     defines a test script): the words assert the whole suite, so the
 *     whole suite is what gets replayed.
 *   - file-created claims: "created `src/foo.js`" — checked against the
 *     filesystem in the session cwd.
 *
 * Verdicts (one per claim, never invented):
 *   - `confirmed` — the evidence matches what the agent said.
 *   - `breach`    — the evidence contradicts the claim (a replay exits
 *     non-zero where the agent claimed green, counts disagree, or a
 *     claimed file does not exist).
 *   - `unknown`   — the evidence could not be obtained (the claimed
 *     command is missing, the replay timed out, counts could not be
 *     parsed from the replay while the claim states counts, or the
 *     claimed path escapes the workdir). Unknown is not a breach: a
 *     missing runner is an environment gap, not a lie.
 *
 * Only `message_end` text is ever read — the agent's own words. Tool
 * output (a test's stdout saying "npm test passed") is not the agent's
 * claim and is never harvested. Message text is truncated to 2048 chars
 * by the normalizer, so claims past that window are not seen; that is a
 * documented blind spot, not silent coverage.
 *
 * Checks run sequentially (one replay at a time) behind a queue so the
 * live session is never hammered while the agent works. The same
 * command/path claimed twice in one session is verified once.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, relative, isAbsolute, join } from 'node:path';

import { extractClaims, isTestCommand, parseReplayCounts } from './audit.js';
import { normalizeAgentEvents } from './agent-stream.js';

export const LIVE_CLAIM_CHECK_TIMEOUT_MS = 120_000;
/** Wall-clock cap for draining pending checks after the agent exits. */
export const LIVE_CLAIM_DRAIN_MS = 300_000;

/**
 * Quote-aware argv split — same semantics as the audit's splitCommand
 * (kept local so the live path never depends on an unexported helper).
 */
export function splitClaimCommand(command) {
  const parts = [];
  let current = '';
  let quote = null;
  for (const char of String(command)) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) { parts.push(current); current = ''; }
    } else {
      current += char;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/** A token that looks like a repo-relative file path, not prose. */
function looksLikePath(token) {
  const text = String(token || '').trim().replace(/^[`'"]+|[`'".,;:]+$/g, '');
  if (!text || /\s/.test(text)) return null;
  if (text.startsWith('-') || text.includes('://') || text.includes('=')) return null;
  // A path has a directory separator or a file extension.
  if (!text.includes('/') && !/\.[A-Za-z0-9]{1,10}$/.test(text)) return null;
  return text;
}

/**
 * Extract "I created/wrote/added this file" claims from agent prose.
 * Only backticked spans and path-like bare tokens count; "added tests"
 * or "created a helper" (no path) yields nothing. Returns
 *   [{ kind: 'file_created', path, source }]
 */
export function extractFileClaims(text) {
  const claims = [];
  const seen = new Set();
  const lines = String(text || '').split('\n');
  for (const line of lines) {
    const candidates = [];
    for (const span of line.matchAll(/`([^`]+)`/g)) {
      const path = looksLikePath(span[1]);
      if (path) candidates.push(path);
    }
    // Bare prose: "created src/foo.js" — only right after a creation verb.
    const bare = line.match(/\b(?:created|wrote|added|introduced)\s+(?:the\s+|a\s+|new\s+)?(?:file\s+)?([A-Za-z0-9_@./-]+\.[A-Za-z0-9]{1,10})\b/i);
    if (bare) {
      const path = looksLikePath(bare[1]);
      if (path) candidates.push(path);
    }
    if (candidates.length === 0) continue;
    // The line must actually assert creation — a bare path in a sentence
    // about something else ("see src/foo.js for the test") is not a claim.
    if (!/\b(?:created|wrote|added|introduced)\b/i.test(line)) continue;
    for (const path of candidates) {
      if (seen.has(path)) continue;
      seen.add(path);
      claims.push({ kind: 'file_created', path, source: line.trim().slice(0, 200) });
    }
  }
  return claims;
}

/** Both claim kinds found in one message. */
export function extractSessionClaims(text, options = {}) {
  const test = extractClaims(text).map((claim) => ({ kind: 'test_run', ...claim }));
  const files = extractFileClaims(text);
  const bare = test.length === 0 ? extractBareTestClaim(text, options) : [];
  return [...test, ...bare, ...files];
}

/**
 * An unqualified "all tests pass" names no command, but it still asserts
 * the whole suite — so it is checked against the repo's default test
 * command (`npm test`, when package.json defines a test script that
 * counts as a test command). Returns [] when the message already names
 * a command, when there is no such sentence, or when the repo defines
 * no runnable test script. The claim states failed: 0 (what "all pass"
 * means) and no pass count (the agent never stated one).
 */
const BARE_PASS_PATTERNS = [
  /\b(all|every)\b[^.\n]{0,60}\btests?\b[^.\n]{0,60}\b(pass(?:ed|es|ing)?|green)\b/i,
  /\btests?\s+(pass(?:ed|es|ing)?|are\s+green)\b/i,
];

export function defaultTestCommand(cwd) {
  try {
    const pkg = JSON.parse(readFileSync(join(resolve(cwd || process.cwd()), 'package.json'), 'utf8'));
    const script = pkg?.scripts?.test;
    if (typeof script === 'string' && script.trim() && isTestCommand(script)) return 'npm test';
  } catch {
    // No package.json, unparsable, or no test script: nothing to infer.
  }
  return null;
}

export function extractBareTestClaim(text, options = {}) {
  const sentence = String(text || '').split('\n')
    .find((line) => BARE_PASS_PATTERNS.some((pattern) => pattern.test(line)));
  if (!sentence) return [];
  const command = defaultTestCommand(options.cwd);
  if (!command) return [];
  return [{
    kind: 'test_run',
    command,
    claimedExit: 0,
    claimedPassed: null,
    claimedFailed: 0,
    claimedTotal: null,
    source: sentence.trim().slice(0, 200),
    inferred: true,
  }];
}

/**
 * Async command runner (audit's runShell, but non-blocking): the child
 * env strips NODE_TEST_CONTEXT / NODE_TEST_WORKER_ID for the same reason
 * (a replay under `node --test` must really run). Returns
 *   { exit, timedOut, spawnError, output, outputTail, durationMs }
 */
export function runCommandAsync(argv, cwd, timeoutMs = LIVE_CLAIM_CHECK_TIMEOUT_MS) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_TEST_WORKER_ID;
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, env });
    } catch (error) {
      resolvePromise({
        exit: null, timedOut: false, spawnError: String(error?.message || error),
        output: '', outputTail: '', durationMs: Date.now() - started,
      });
      return;
    }
    let output = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolvePromise({
        exit: null, timedOut: true, spawnError: null, output,
        outputTail: output.split('\n').slice(-40).join('\n'),
        durationMs: Date.now() - started,
      });
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (chunk) => { output += String(chunk); });
    child.stderr?.on('data', (chunk) => { output += String(chunk); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        exit: null, timedOut: false, spawnError: String(error?.message || error),
        output, outputTail: output.split('\n').slice(-40).join('\n'),
        durationMs: Date.now() - started,
      });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        exit: code, timedOut: false, spawnError: null, output,
        outputTail: output.split('\n').slice(-40).join('\n'),
        durationMs: Date.now() - started,
      });
    });
  });
}

/**
 * Verify one test-run claim (audit match semantics, live verdicts).
 * `run` is injectable: async (argv, cwd, timeoutMs) => replay result.
 */
export async function verifyTestClaim(claim, options = {}) {
  const cwd = options.cwd || process.cwd();
  const timeoutMs = options.timeoutMs ?? LIVE_CLAIM_CHECK_TIMEOUT_MS;
  const run = options.run || runCommandAsync;
  const argv = splitClaimCommand(claim.command);
  const base = {
    kind: 'test_run', command: claim.command, source: claim.source ?? null,
    ...(claim.inferred ? { inferred: true } : {}),
  };
  if (argv.length === 0) {
    return { ...base, verdict: 'unknown', note: 'empty command' };
  }
  const replay = await run(argv, cwd, timeoutMs);
  const counts = parseReplayCounts(replay.output || '', claim.command);
  const expectedExit = claim.claimedExit ?? 0;
  if (replay.timedOut) {
    return { ...base, verdict: 'unknown', note: `replay timed out after ${timeoutMs}ms`, replay };
  }
  if (replay.spawnError) {
    return { ...base, verdict: 'unknown', note: `could not run claimed command: ${replay.spawnError}`, replay };
  }
  if (replay.exit !== expectedExit) {
    return {
      ...base, verdict: 'breach',
      note: `exit: claimed ${expectedExit}, replayed ${replay.exit}`,
      replay: { ...replay, counts },
    };
  }
  if (counts) {
    if (claim.claimedPassed !== null && claim.claimedPassed !== undefined
      && counts.passed !== null && counts.passed !== claim.claimedPassed) {
      return {
        ...base, verdict: 'breach',
        note: `passed count: claimed ${claim.claimedPassed}, replayed ${counts.passed}`,
        replay: { ...replay, counts },
      };
    }
    if (claim.claimedFailed !== null && claim.claimedFailed !== undefined
      && counts.failed !== null && counts.failed !== claim.claimedFailed) {
      return {
        ...base, verdict: 'breach',
        note: `failed count: claimed ${claim.claimedFailed}, replayed ${counts.failed}`,
        replay: { ...replay, counts },
      };
    }
  } else if (claim.claimedPassed !== null || claim.claimedFailed !== null) {
    return {
      ...base, verdict: 'unknown',
      note: 'counts_unparsed: exit matches, counts could not be parsed from replay output',
      replay: { ...replay, counts },
    };
  }
  return { ...base, verdict: 'confirmed', replay: { ...replay, counts } };
}

/**
 * Verify one file-created claim against the session cwd. A path that is
 * absolute or escapes the workdir is `unknown` (the checker must not
 * vouch for files outside the agent's tree).
 */
export function verifyFileClaim(claim, options = {}) {
  const cwd = resolve(options.cwd || process.cwd());
  const base = { kind: 'file_created', path: claim.path, source: claim.source ?? null };
  if (isAbsolute(claim.path)) {
    return { ...base, verdict: 'unknown', note: 'absolute path outside workdir' };
  }
  const target = resolve(cwd, claim.path);
  if (relative(cwd, target).startsWith('..')) {
    return { ...base, verdict: 'unknown', note: 'path escapes workdir' };
  }
  if (existsSync(target)) return { ...base, verdict: 'confirmed' };
  return { ...base, verdict: 'breach', note: `file not found: ${claim.path}` };
}

/** Verify any one claim by kind. */
export async function verifyClaim(claim, options = {}) {
  if (claim.kind === 'file_created') return verifyFileClaim(claim, options);
  return verifyTestClaim(claim, options);
}

/**
 * Sequential claim checker for one live session. `checkText` enqueues
 * (never blocks the caller); completed checks are delivered through
 * `onCheck` in completion order and recorded for the summary.
 *
 * Options: cwd, timeoutMs, run (test-run replay), onCheck(check),
 * onBreach(check).
 */
export function createClaimChecker(options = {}) {
  const cwd = options.cwd || process.cwd();
  const timeoutMs = options.timeoutMs ?? LIVE_CLAIM_CHECK_TIMEOUT_MS;
  const run = options.run || runCommandAsync;
  const onCheck = typeof options.onCheck === 'function' ? options.onCheck : null;
  const onBreach = typeof options.onBreach === 'function' ? options.onBreach : null;
  const seen = new Set();
  const checks = [];
  let queue = Promise.resolve();
  let pending = 0;
  let closed = false;

  function deliver(check) {
    // A check that lands after the drain deadline is dropped: the session
    // is over and its summary is already written.
    if (closed) return;
    checks.push(check);
    if (onCheck) onCheck(check);
    if (check.verdict === 'breach' && onBreach) onBreach(check);
  }

  function keyFor(claim) {
    return claim.kind === 'file_created' ? `file:${claim.path}` : `test:${claim.command}`;
  }

  function checkText(text) {
    const claims = extractSessionClaims(text, { cwd });
    for (const claim of claims) {
      const key = keyFor(claim);
      if (seen.has(key)) continue;
      seen.add(key);
      pending += 1;
      queue = queue
        .then(() => verifyClaim(claim, { cwd, timeoutMs, run }))
        .then((check) => { pending -= 1; deliver(check); })
        .catch((error) => {
          pending -= 1;
          deliver({ ...claim, verdict: 'unknown', note: `checker error: ${String(error?.message || error)}` });
        });
    }
    return claims.length;
  }

  /**
   * Wait for the queue to drain, or until the deadline passes; checks
   * still pending at the deadline are recorded as `unknown` (never as
   * confirmed, never as breach).
   */
  async function drain(deadlineMs = LIVE_CLAIM_DRAIN_MS) {
    const started = Date.now();
    while (pending > 0 && Date.now() - started < deadlineMs) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.race([queue, new Promise((resolvePromise) => setTimeout(resolvePromise, 100))]);
    }
    if (pending > 0) {
      // The queue promise cannot be cancelled mid-flight; record the
      // gap honestly, then close the checker so late deliveries are
      // dropped instead of landing after the summary is written.
      const pendingKeys = [...seen].filter((key) => !checks.some(
        (check) => keyFor(check) === key,
      ));
      for (const key of pendingKeys) {
        const colon = key.indexOf(':');
        const kind = key.slice(0, colon);
        const rest = key.slice(colon + 1);
        const claim = kind === 'file'
          ? { kind: 'file_created', path: rest }
          : { kind: 'test_run', command: rest };
        deliver({ ...claim, verdict: 'unknown', note: 'verification did not finish before session end' });
      }
      closed = true;
      pending = 0;
    }
  }

  function summary() {
    return {
      checked: checks.length,
      confirmed: checks.filter((check) => check.verdict === 'confirmed').length,
      breaches: checks.filter((check) => check.verdict === 'breach').length,
      unknown: checks.filter((check) => check.verdict === 'unknown').length,
      checks: checks.map((check) => {
        const entry = {
          kind: check.kind,
          verdict: check.verdict,
          ...(check.command ? { command: check.command } : {}),
          ...(check.path ? { path: check.path } : {}),
          ...(check.inferred ? { inferred: true } : {}),
          ...(check.source ? { source: check.source } : {}),
          ...(check.note ? { note: check.note } : {}),
        };
        if (check.replay) {
          entry.replay = {
            exit: check.replay.exit,
            timedOut: check.replay.timedOut,
            spawnError: check.replay.spawnError,
            durationMs: check.replay.durationMs,
            ...(check.replay.counts ? { counts: check.replay.counts } : {}),
          };
        }
        return entry;
      }),
    };
  }

  return { checkText, drain, summary, pendingCount: () => pending, results: () => [...checks] };
}

/**
 * Post-hoc claim proof: extract + verify every claim in a saved stream's
 * message_end text, with the same checker the live session used. Lets a
 * later reader confirm live and post-hoc claim verdicts agree.
 */
export async function verifyClaimsFromStream(streamText, options = {}) {
  const checker = createClaimChecker(options);
  const lines = String(streamText || '').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    for (const event of normalizeAgentEvents(line, { adapter: 'codex_cli', seq: 0 })) {
      if (event.event === 'message_end' && event.text) checker.checkText(event.text);
    }
  }
  await checker.drain(options.drainMs ?? LIVE_CLAIM_DRAIN_MS);
  return checker.summary();
}
