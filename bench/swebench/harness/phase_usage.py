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
    window opens at `phase_started` and closes at the matching
    `phase_completed`, at the next `phase_started`, at
    `workflow_completed` / `workflow_failed`, or at the last log line —
    whichever comes first. Skipped phases never open a window (no agent
    time is spent inside them). Resumed runs simply produce more windows,
    grouped by their own workflow_run_id.
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
        elif kind == "phase_completed" and open_window is not None \
                and entry.get("phase_id") == open_window["phase"]:
            close(ms)
        elif kind in ("workflow_completed", "workflow_failed"):
            close(ms)
    if open_window is not None and last_ms is not None:
        close(last_ms)
    return windows


def bucket_usage(events_file: Path, windows: list[dict]) -> dict:
    """Aggregate pi assistant-message usage per (workflow_run_id, phase).

    Mirrors arms.pi_events_usage accounting (assistant `message_end`
    events only), split by the phase window containing the message's
    timestamp. Messages outside every window land in OUTSIDE_PHASE with a
    null run id. Returns {(run_id, phase): {turns, input, output,
    cache_read, cache_write}}.
    """
    buckets: dict[tuple, dict] = {}

    def add(key: tuple, usage: dict) -> None:
        row = buckets.setdefault(key, {"turns": 0, **{k: 0 for k in USAGE_KEYS}})
        row["turns"] += 1
        row["input"] += usage.get("input", 0) or 0
        row["output"] += usage.get("output", 0) or 0
        row["cache_read"] += usage.get("cacheRead", 0) or 0
        row["cache_write"] += usage.get("cacheWrite", 0) or 0

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
        add(key, usage)
    return buckets


def cell_phase_rows(task_id: str, instance_id: str, arm: str, rep: int,
                    repo: Path, events_dir: Path, label: str = "agent") -> list[dict]:
    """Ledger rows for one finished cell, or [] when metering is absent.

    Reads the execution log from the cell's repo (which the caller must
    still have on disk) and the pi events copy in the cell's events dir.
    Missing files are a normal outcome for arms that never run the
    workflow executor — not an error.
    """
    execution_log = repo / ".as-xflow" / "logs" / "execution.ndjson"
    events_file = events_dir / f"{label}-events.jsonl"
    if not execution_log.exists() or not events_file.exists():
        return []
    windows = phase_windows(execution_log)
    if not windows:
        return []
    buckets = bucket_usage(events_file, windows)
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
