"""Per-phase usage bucketing for the SWE-bench harness (M18 slice 2, #224).

Why this exists: the M16 matrix could not be broken down by workflow phase
after the fact. Each cell's runs-jsonl row carries one aggregate usage for
the whole agent session, and the per-run raw tree that held the phase
boundaries (the workflow execution log inside the cell's repo) was deleted
with the rundir. Slice 1 of M18 (#223) had to fall back to proxy metrics
(turns / tool_calls / per-turn footprint) for exactly this reason.

This module closes the gap at generation time, while the cell's repo still
exists: read the workflow execution log (`.as-xflow/logs/execution.ndjson`)
for phase windows, then bucket the pi agent's per-message usage into the
phase that was active when each message completed. Pi `message_end` events
carry the usage on the message and an epoch-ms `timestamp` inside the
message object, which is what makes the join possible.

Rows are appended next to the runs jsonl (runs-<tag>.jsonl ->
phases-<tag>.jsonl), keyed by the cell's task id — the same id recorded in
the runs row's calls — so per-phase acceptance can join phases to cells
without resurrecting any raw tree. Stdlib only.

M19 slice 1 (#230) changes the window semantics and adds the executor
subsession channel: a phase window now runs from `phase_started` until
the next `phase_started` / `workflow_completed` / last log line
(`phase_completed` and `workflow_failed` no longer close it), and
`agent_event` / `agent_end` usage from the executor's codex/claude
sub-agents is bucketed into the phase row named by its own `phase`.
Reconciliation: phases_total − runs_total == subsession agent_end usage,
exactly zero for a pure bench cell.
"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

OUTSIDE_PHASE = "_outside_workflow"
USAGE_KEYS = ("input", "output", "cache_read", "cache_write")


def _iso_to_ms(ts: str) -> float:
    return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() * 1000.0


def phase_windows(execution_log: Path) -> list[dict]:
    """Phase spans from an execution ndjson log.

    Returns [{phase, workflow_run_id, start_ms, end_ms}] in log order. A
    window opens at `phase_started` and stays active until the next
    `phase_started`, at `workflow_completed`, or at the last log line —
    whichever comes first (M19 slice 1, #230 fix 1: the "active interval"
    semantics). `phase_completed` and `workflow_failed` no longer close a
    window: the engine's phase window used to be only the bookkeeping
    instant when the executor ran a local atom (measured 0.4 s for a whole
    phase), while the driver actually works after the human gate / outside
    the engine call, so messages never landed inside the window. Skipped
    phases never open a window (no agent time is spent inside them).
    Resumed runs simply produce more windows, grouped by their own
    workflow_run_id. Adjacent windows share their boundary timestamp; a
    message landing exactly on it is attributed to the earlier window.
    """
    windows: list[dict] = []
    open_window: dict | None = None
    last_ms: float | None = None

    def close(at_ms: float) -> None:
        nonlocal open_window
        if open_window is not None:
            open_window["end_ms"] = max(at_ms, open_window["start_ms"])
            windows.append(open_window)
            open_window = None

    try:
        lines = execution_log.read_text(errors="replace").splitlines()
    except OSError:
        return []
    for line in lines:
        try:
            entry = json.loads(line)
        except Exception:
            continue
        ts = entry.get("timestamp")
        if not ts:
            continue
        try:
            ms = _iso_to_ms(ts)
        except Exception:
            continue
        last_ms = ms
        kind = entry.get("kind")
        if kind == "phase_started":
            close(ms)
            open_window = {
                "phase": entry.get("phase_id") or "unknown",
                "workflow_run_id": entry.get("workflow_run_id"),
                "start_ms": ms,
            }
        elif kind == "workflow_completed":
            close(ms)
    if open_window is not None and last_ms is not None:
        close(last_ms)
    return windows


def _normalize_usage(usage: dict) -> dict:
    """Usage totals in the canonical snake_case keys.

    The pi channel reports camelCase cacheRead/cacheWrite; the executor
    subsession channel (agent_end) reports normalized snake_case
    cache_read/cache_write. Accept both spellings so neither channel is
    silently dropped; when both spellings are present the snake_case key
    wins.
    """
    if not isinstance(usage, dict):
        return {k: 0 for k in USAGE_KEYS}
    return {
        "input": usage.get("input", 0) or 0,
        "output": usage.get("output", 0) or 0,
        "cache_read": (usage.get("cache_read") if "cache_read" in usage
                       else usage.get("cacheRead", 0)) or 0,
        "cache_write": (usage.get("cache_write") if "cache_write" in usage
                        else usage.get("cacheWrite", 0)) or 0,
    }


def _add_to_buckets(buckets: dict, key: tuple, usage: dict) -> None:
    """Add one usage report to a bucket, counting it as one turn."""
    row = buckets.setdefault(key, {"turns": 0, **{k: 0 for k in USAGE_KEYS}})
    row["turns"] += 1
    for k, v in _normalize_usage(usage).items():
        row[k] += v


def bucket_usage(events_file: Path, windows: list[dict]) -> dict:
    """Aggregate pi assistant-message usage per (workflow_run_id, phase).

    Mirrors arms.pi_events_usage accounting (assistant `message_end`
    events only), split by the phase window containing the message's
    timestamp. Messages outside every window land in OUTSIDE_PHASE with a
    null run id. Returns {(run_id, phase): {turns, input, output,
    cache_read, cache_write}}.
    """
    buckets: dict[tuple, dict] = {}

    try:
        lines = events_file.read_text(errors="replace").splitlines()
    except OSError:
        return buckets
    for line in lines:
        try:
            event = json.loads(line)
        except Exception:
            continue
        if event.get("type") != "message_end":
            continue
        message = event.get("message") or {}
        if message.get("role") != "assistant":
            continue
        ts = message.get("timestamp")
        usage = message.get("usage") or {}
        key = (None, OUTSIDE_PHASE)
        if isinstance(ts, (int, float)):
            for window in windows:
                if window["start_ms"] <= ts <= window["end_ms"]:
                    key = (window["workflow_run_id"], window["phase"])
                    break
        _add_to_buckets(buckets, key, usage)
    return buckets


def bucket_subsession_usage(execution_log: Path, windows: list[dict]) -> dict:
    """Aggregate executor subsession usage per (workflow_run_id, phase).

    M19 slice 1 (#230 fix 2): the engine's `agent_invoke` atom runs a
    codex/claude sub-agent whose CLI output is streamed into this same
    execution log as `kind: 'agent_event'` records; each `agent_end`
    carries the invoking phase and a normalized usage dict. phase_usage
    never read that channel, so executor-path usage was invisible to the
    phase ledger. Each agent_end is bucketed into the phase row named by
    its own `phase` — the window with that name containing the event's
    timestamp, else the latest window of that name, else a standalone
    (None, phase) row so measured usage is never dropped. Returns the
    same {(run_id, phase): {...}} shape as bucket_usage so the two
    channels merge into one ledger.
    """
    buckets: dict[tuple, dict] = {}
    try:
        lines = execution_log.read_text(errors="replace").splitlines()
    except OSError:
        return buckets
    by_phase: dict[str, list[dict]] = {}
    for window in windows:
        by_phase.setdefault(window["phase"], []).append(window)
    for line in lines:
        try:
            entry = json.loads(line)
        except Exception:
            continue
        if entry.get("kind") != "agent_event" or entry.get("event") != "agent_end":
            continue
        usage = entry.get("usage")
        if not isinstance(usage, dict) or not usage:
            continue
        phase = entry.get("phase")
        if not phase:
            continue
        key: tuple = (None, phase)
        try:
            ms = _iso_to_ms(entry["timestamp"]) if entry.get("timestamp") else None
        except Exception:
            ms = None
        candidates = by_phase.get(phase) or []
        if ms is not None:
            for window in candidates:
                if window["start_ms"] <= ms <= window["end_ms"]:
                    key = (window["workflow_run_id"], phase)
                    break
            else:
                if candidates:
                    key = (candidates[-1]["workflow_run_id"], phase)
        elif candidates:
            key = (candidates[-1]["workflow_run_id"], phase)
        _add_to_buckets(buckets, key, usage)
    return buckets


def subsession_totals(buckets: dict) -> dict:
    """Sum one bucket dict (as returned by bucket_subsession_usage) per key."""
    totals = {"turns": 0, **{k: 0 for k in USAGE_KEYS}}
    for usage in buckets.values():
        totals["turns"] += usage.get("turns", 0) or 0
        for k in USAGE_KEYS:
            totals[k] += usage.get(k, 0) or 0
    return totals


def reconcile(phase_rows: list[dict], runs_usage: dict) -> dict:
    """Reconciliation (M19 slice 1, #230 fix 3).

    phases_total − runs_total must equal the subsession agent_end usage
    the executor reported: the pi channel (bucket_usage) counts exactly
    the assistant message_end events arms.pi_events_usage sums into the
    runs row, so any remainder is subsession usage by construction. A
    pure bench cell has no subsession traffic and must reconcile to
    exactly zero on every key. Returns {"phases": {...}, "runs": {...},
    "difference": {...}}; compare "difference" against
    subsession_totals(bucket_subsession_usage(...)) to verify.
    """
    phases = {"turns": 0, **{k: 0 for k in USAGE_KEYS}}
    for row in phase_rows:
        phases["turns"] += row.get("turns", 0) or 0
        for k in USAGE_KEYS:
            phases[k] += row.get(k, 0) or 0
    runs = {"turns": runs_usage.get("turns", 0) or 0,
            **{k: runs_usage.get(k, 0) or 0 for k in USAGE_KEYS}}
    return {
        "phases": phases,
        "runs": runs,
        "difference": {k: phases[k] - runs[k] for k in phases},
    }


def cell_phase_rows(task_id: str, instance_id: str, arm: str, rep: int,
                    repo: Path, events_dir: Path, label: str = "agent") -> list[dict]:
    """Ledger rows for one finished cell, or [] when metering is absent.

    Reads the execution log from the cell's repo (which the caller must
    still have on disk) and the pi events copy in the cell's events dir.
    Missing files are a normal outcome for arms that never run the
    workflow executor — not an error. The pi channel (message_end usage
    bucketed by phase window) and the executor subsession channel
    (agent_end usage bucketed by its own phase) merge into the same
    (run_id, phase) rows; a subsession report whose phase has no window
    still lands as its own (None, phase) row rather than being dropped.
    """
    execution_log = repo / ".as-xflow" / "logs" / "execution.ndjson"
    events_file = events_dir / f"{label}-events.jsonl"
    if not execution_log.exists() or not events_file.exists():
        return []
    windows = phase_windows(execution_log)
    buckets = bucket_usage(events_file, windows)
    for key, usage in bucket_subsession_usage(execution_log, windows).items():
        row = buckets.setdefault(key, {"turns": 0, **{k: 0 for k in USAGE_KEYS}})
        row["turns"] += usage["turns"]
        for k in USAGE_KEYS:
            row[k] += usage[k]
    if not buckets:
        return []
    rows = []
    for (run_id, phase), usage in sorted(buckets.items(), key=lambda item: (item[0][1], str(item[0][0]))):
        rows.append({
            "task_id": task_id,
            "instance_id": instance_id,
            "arm": arm,
            "rep": rep,
            "workflow_run_id": run_id,
            "phase": phase,
            **usage,
        })
    return rows


def phases_path_for(runs_out: Path) -> Path:
    """The phases ledger that belongs to a runs jsonl path."""
    name = runs_out.name
    if name.startswith("runs-"):
        return runs_out.parent / ("phases-" + name[len("runs-"):])
    if name == "runs.jsonl":
        return runs_out.parent / "phases.jsonl"
    return runs_out.parent / ("phases-" + name)
