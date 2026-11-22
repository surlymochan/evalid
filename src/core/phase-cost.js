/**
 * Phase cost accounting (issue #5 P1-1).
 *
 * A workflow run records one entry per executed phase: how long the phase
 * took and, when an atom reported usage, how many tokens it burned. The
 * report compares the sum of phase durations against the run's wall clock;
 * the two must agree within tolerance (default 5%) or the accounting itself
 * is flagged as incomplete — an overhead number that cannot account for the
 * wall clock is not evidence.
 *
 * M18 slice 2 (#224): entries also carry turns / cache_read / cache_write,
 * the report carries the workflow run id, and `phaseCostLedgerRows`
 * flattens a report into one row per phase so a run can append its phases
 * to a durable per-phase ledger (`.as-xflow/phase-cost-ledger.jsonl`)
 * instead of leaving them only inside the per-run report artifact.
 */

export const PHASE_COST_TOLERANCE_PCT = 5;

const TOTAL_KEYS = ['total_tokens', 'totalTokens', 'tokens_total', 'tokens'];
const INPUT_KEYS = ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens'];
const OUTPUT_KEYS = ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens'];
const TURNS_KEYS = ['turns', 'turn_count', 'turnCount'];
const CACHE_READ_KEYS = ['cache_read', 'cacheRead', 'cache_read_tokens', 'cached_input_tokens', 'cache_read_input_tokens'];
const CACHE_WRITE_KEYS = ['cache_write', 'cacheWrite', 'cache_write_tokens', 'cache_creation_input_tokens'];

function pickNumber(source, keys) {
  if (!source || typeof source !== 'object') return null;
  for (const key of keys) {
    const value = Number(source[key]);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

// Bare `input` / `output` are the normalized agent-stream usage shape
// ({ input, output, cache_read, cache_write }), but on an atom result those
// same field names usually hold payload text — only accept real numbers so
// a result like { output: "42" } is never misread as token usage.
function pickBareNumber(source, key) {
  if (!source || typeof source !== 'object') return null;
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Extract a normalized token usage from an atom result, looking at the
 * result itself and at common nested containers (`usage`, `token_usage`,
 * `metrics`). Returns null when the atom reported nothing usable.
 *
 * M18 slice 2 (#224): the normalized shape also carries `turns`,
 * `cache_read` and `cache_write` — the two factors the M18 metering needs
 * per phase (cache_read is ~95% of the openflow arm's tokens, and it
 * decomposes as turns x per-turn footprint). When no explicit total is
 * reported, the total follows the bench caliber: input + output +
 * cache_read + cache_write.
 */
export function extractTokenUsage(result) {
  if (!result || typeof result !== 'object') return null;
  const containers = [result, result.usage, result.token_usage, result.metrics];
  for (const container of containers) {
    if (!container || typeof container !== 'object') continue;
    const input = pickNumber(container, INPUT_KEYS) ?? pickBareNumber(container, 'input');
    const output = pickNumber(container, OUTPUT_KEYS) ?? pickBareNumber(container, 'output');
    const cacheRead = pickNumber(container, CACHE_READ_KEYS);
    const cacheWrite = pickNumber(container, CACHE_WRITE_KEYS);
    const turns = pickNumber(container, TURNS_KEYS);
    let total = pickNumber(container, TOTAL_KEYS);
    if (total === null && (input !== null || output !== null || cacheRead !== null || cacheWrite !== null)) {
      total = (input || 0) + (output || 0) + (cacheRead || 0) + (cacheWrite || 0);
    }
    if (total !== null || input !== null || output !== null) {
      return {
        input: input || 0,
        output: output || 0,
        cache_read: cacheRead || 0,
        cache_write: cacheWrite || 0,
        turns: turns || 0,
        total: total || 0,
      };
    }
  }
  return null;
}

export function emptyTokenUsage() {
  return { input: 0, output: 0, cache_read: 0, cache_write: 0, turns: 0, total: 0 };
}

export function addTokenUsage(accumulator, usage) {
  if (!usage) return accumulator;
  accumulator.input += usage.input || 0;
  accumulator.output += usage.output || 0;
  accumulator.cache_read = (accumulator.cache_read || 0) + (usage.cache_read || 0);
  accumulator.cache_write = (accumulator.cache_write || 0) + (usage.cache_write || 0);
  accumulator.turns = (accumulator.turns || 0) + (usage.turns || 0);
  accumulator.total += usage.total || 0;
  return accumulator;
}

/**
 * Build the per-phase cost report for one workflow run.
 *
 * phases: [{ phase_id, status, duration_ms, tokens? }]
 * wallClockMs: measured wall clock of the whole run.
 */
export function buildPhaseCostReport({ phases = [], wallClockMs = null, tolerancePct = PHASE_COST_TOLERANCE_PCT, recordedAt = null, workflowRunId = null, changeId = null } = {}) {
  const entries = phases.map((phase) => {
    const durationMs = Number.isFinite(Number(phase.duration_ms)) ? Math.max(0, Math.round(Number(phase.duration_ms))) : 0;
    return {
      phase_id: phase.phase_id || phase.id || 'unknown',
      status: phase.status || 'completed',
      duration_ms: durationMs,
      tokens: phase.tokens
        ? {
            input: phase.tokens.input || 0,
            output: phase.tokens.output || 0,
            cache_read: phase.tokens.cache_read || 0,
            cache_write: phase.tokens.cache_write || 0,
            turns: phase.tokens.turns || 0,
            total: phase.tokens.total || 0,
          }
        : null,
    };
  });

  const totalPhaseMs = entries.reduce((sum, entry) => sum + entry.duration_ms, 0);
  const wall = Number.isFinite(Number(wallClockMs)) && Number(wallClockMs) >= 0 ? Math.round(Number(wallClockMs)) : null;
  const unaccountedMs = wall === null ? null : wall - totalPhaseMs;
  const driftPct = wall !== null && wall > 0
    ? Math.round((Math.abs(unaccountedMs) / wall) * 10000) / 100
    : null;

  for (const entry of entries) {
    entry.duration_share = totalPhaseMs > 0
      ? Math.round((entry.duration_ms / totalPhaseMs) * 10000) / 100
      : 0;
  }

  const tokens = entries.reduce(
    (acc, entry) => (entry.tokens ? addTokenUsage(acc, entry.tokens) : acc),
    emptyTokenUsage(),
  );
  const anyTokens = entries.some((entry) => entry.tokens && entry.tokens.total > 0);

  return {
    workflow_run_id: workflowRunId || null,
    change_id: changeId || null,
    phases: entries,
    total_phase_ms: totalPhaseMs,
    wall_clock_ms: wall,
    unaccounted_ms: unaccountedMs,
    drift_pct: driftPct,
    tolerance_pct: tolerancePct,
    within_tolerance: driftPct === null ? null : driftPct <= tolerancePct,
    tokens: anyTokens ? tokens : null,
    recorded_at: recordedAt || new Date().toISOString(),
  };
}

/**
 * Flatten a phase cost report into ledger rows: one row per phase, keyed
 * by the workflow run id so rows can be joined back to the run (and, in
 * the bench harness, to the runs jsonl row of the same run). Phases whose
 * atoms reported no usage still get a row, with zeroed token fields — the
 * phase boundary itself is metering evidence.
 */
export function phaseCostLedgerRows(report) {
  if (!report || !Array.isArray(report.phases)) return [];
  return report.phases.map((phase) => ({
    workflow_run_id: report.workflow_run_id || null,
    change_id: report.change_id || null,
    phase: phase.phase_id,
    status: phase.status,
    duration_ms: phase.duration_ms,
    turns: phase.tokens?.turns || 0,
    input: phase.tokens?.input || 0,
    output: phase.tokens?.output || 0,
    cache_read: phase.tokens?.cache_read || 0,
    cache_write: phase.tokens?.cache_write || 0,
    total: phase.tokens?.total || 0,
    recorded_at: report.recorded_at || null,
  }));
}
