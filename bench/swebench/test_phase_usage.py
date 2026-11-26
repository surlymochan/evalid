#!/usr/bin/env python3
"""Tests for harness/phase_usage.py (M18 slice 2, evalid #224).

The M16 matrix could not be broken down by workflow phase after the fact
because the per-run raw tree holding the phase boundaries was deleted;
phase_usage buckets pi message usage into execution-log phase windows at
generation time. These tests pin that join: window construction (incl.
resume runs and unterminated phases), usage bucketing (assistant
message_end only, epoch-ms message timestamps), the outside bucket, and
the runs->phases file naming. M19 slice 1 (#230) adds: active-interval
windows (phase_completed / workflow_failed no longer close), the
executor subsession channel (agent_end usage joins its own phase row),
and the phases − runs == subsession reconciliation. Stdlib only.
"""
import importlib.util
import json
import unittest
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory

SPEC = importlib.util.spec_from_file_location(
    "phase_usage", Path(__file__).resolve().parent / "harness" / "phase_usage.py")
PU = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PU)

BASE = datetime(2026, 11, 23, 0, 0, 0, tzinfo=timezone.utc)


def iso(offset_s):
    return datetime.fromtimestamp(BASE.timestamp() + offset_s, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def ms(offset_s):
    return int((BASE.timestamp() + offset_s) * 1000)


def log_line(offset_s, kind, **fields):
    return json.dumps({"timestamp": iso(offset_s), "kind": kind, **fields})


def message(offset_s, usage, role="assistant"):
    return json.dumps({"type": "message_end", "message": {"role": role, "timestamp": ms(offset_s), "usage": usage}})


class PhaseWindowsTest(unittest.TestCase):
    def test_windows_open_and_close_on_phase_events(self):
        with TemporaryDirectory() as d:
            log = Path(d) / "execution.ndjson"
            log.write_text("\n".join([
                log_line(0, "workflow_started", workflow_run_id="wf_1"),
                log_line(1, "phase_started", phase_id="plan", workflow_run_id="wf_1"),
                log_line(5, "phase_completed", phase_id="plan", workflow_run_id="wf_1"),
                log_line(5, "phase_started", phase_id="execute", workflow_run_id="wf_1"),
                log_line(9, "workflow_completed", workflow_run_id="wf_1"),
            ]))
            windows = PU.phase_windows(log)
            self.assertEqual([w["phase"] for w in windows], ["plan", "execute"])
            self.assertEqual(windows[0]["start_ms"], ms(1))
            self.assertEqual(windows[0]["end_ms"], ms(5))
            self.assertEqual(windows[1]["end_ms"], ms(9))
            self.assertTrue(all(w["workflow_run_id"] == "wf_1" for w in windows))

    def test_unterminated_phase_closes_at_last_log_line(self):
        with TemporaryDirectory() as d:
            log = Path(d) / "execution.ndjson"
            log.write_text("\n".join([
                log_line(0, "phase_started", phase_id="plan", workflow_run_id="wf_1"),
                log_line(3, "gate_check", phase_id="plan"),
            ]))
            windows = PU.phase_windows(log)
            self.assertEqual(len(windows), 1)
            self.assertEqual(windows[0]["end_ms"], ms(3))

    def test_missing_log_yields_no_windows(self):
        self.assertEqual(PU.phase_windows(Path("/nonexistent/execution.ndjson")), [])


class BucketUsageTest(unittest.TestCase):
    def _windows(self, d):
        log = Path(d) / "execution.ndjson"
        log.write_text("\n".join([
            log_line(1, "phase_started", phase_id="plan", workflow_run_id="wf_1"),
            log_line(5, "phase_completed", phase_id="plan", workflow_run_id="wf_1"),
            log_line(5, "phase_started", phase_id="execute", workflow_run_id="wf_1"),
            log_line(9, "workflow_completed", workflow_run_id="wf_1"),
        ]))
        return PU.phase_windows(log)

    def test_messages_bucket_into_their_phase(self):
        with TemporaryDirectory() as d:
            events = Path(d) / "agent-events.jsonl"
            events.write_text("\n".join([
                message(0, {"input": 1, "output": 1, "cacheRead": 1}),  # before any window
                message(2, {"input": 10, "output": 5, "cacheRead": 100, "cacheWrite": 0}),
                message(3, {"input": 20, "output": 5, "cacheRead": 200, "cacheWrite": 0}),
                message(7, {"input": 30, "output": 7, "cacheRead": 300, "cacheWrite": 1}),
                message(7, {"input": 999, "output": 999, "cacheRead": 999}, role="user"),
                json.dumps({"type": "tool_execution_start", "toolName": "bash"}),
            ]))
            buckets = PU.bucket_usage(events, self._windows(d))
            plan = buckets[("wf_1", "plan")]
            self.assertEqual(plan, {"turns": 2, "input": 30, "output": 10, "cache_read": 300, "cache_write": 0})
            execute = buckets[("wf_1", "execute")]
            self.assertEqual(execute, {"turns": 1, "input": 30, "output": 7, "cache_read": 300, "cache_write": 1})
            outside = buckets[(None, PU.OUTSIDE_PHASE)]
            self.assertEqual(outside["turns"], 1)
            self.assertEqual(outside["cache_read"], 1)

    def test_cell_rows_join_on_task_id(self):
        with TemporaryDirectory() as d:
            root = Path(d)
            repo = root / "repo"
            (repo / ".as-xflow" / "logs").mkdir(parents=True)
            (repo / ".as-xflow" / "logs" / "execution.ndjson").write_text("\n".join([
                log_line(1, "phase_started", phase_id="plan", workflow_run_id="wf_9"),
                log_line(4, "workflow_completed", workflow_run_id="wf_9"),
            ]))
            events = root / "events"
            events.mkdir()
            (events / "agent-events.jsonl").write_text(
                message(2, {"input": 10, "output": 5, "cacheRead": 100, "cacheWrite": 0}))
            rows = PU.cell_phase_rows("tid-1", "sympy__sympy-1", "openflow", 1, repo, events)
            self.assertEqual(len(rows), 1)
            row = rows[0]
            self.assertEqual(row["task_id"], "tid-1")
            self.assertEqual(row["workflow_run_id"], "wf_9")
            self.assertEqual(row["phase"], "plan")
            self.assertEqual(row["turns"], 1)
            self.assertEqual(row["cache_read"], 100)
            # No workflow evidence -> no rows, not an error.
            self.assertEqual(PU.cell_phase_rows("tid-2", "x", "baseline", 1, root / "nope", events), [])


class PhasesPathTest(unittest.TestCase):
    def test_runs_name_maps_to_phases_name(self):
        self.assertEqual(PU.phases_path_for(Path("results/runs-m16s2-full.jsonl")),
                         Path("results/phases-m16s2-full.jsonl"))
        self.assertEqual(PU.phases_path_for(Path("results/runs.jsonl")), Path("results/phases.jsonl"))


def agent_end(offset_s, phase, usage, event="agent_end"):
    record = {"timestamp": iso(offset_s), "kind": "agent_event",
              "event": event, "phase": phase}
    if usage is not None:
        record["usage"] = usage
    return json.dumps(record)


class PhaseWindowActiveIntervalTest(unittest.TestCase):
    """M19 slice 1 (#230 fix 1): windows are active intervals."""

    def test_phase_completed_does_not_close_window(self):
        with TemporaryDirectory() as d:
            log = Path(d) / "execution.ndjson"
            log.write_text("\n".join([
                log_line(0, "workflow_started", workflow_run_id="wf_1"),
                log_line(1, "phase_started", phase_id="plan", workflow_run_id="wf_1"),
                log_line(5, "phase_completed", phase_id="plan", workflow_run_id="wf_1"),
                log_line(7, "gate_check", phase_id="plan"),
                log_line(9, "workflow_completed", workflow_run_id="wf_1"),
            ]))
            windows = PU.phase_windows(log)
            self.assertEqual(len(windows), 1)
            self.assertEqual(windows[0]["phase"], "plan")
            self.assertEqual(windows[0]["start_ms"], ms(1))
            self.assertEqual(windows[0]["end_ms"], ms(9))

    def test_workflow_failed_does_not_close_window(self):
        with TemporaryDirectory() as d:
            log = Path(d) / "execution.ndjson"
            log.write_text("\n".join([
                log_line(1, "phase_started", phase_id="plan", workflow_run_id="wf_1"),
                log_line(5, "workflow_failed", workflow_run_id="wf_1"),
                log_line(7, "gate_check", phase_id="plan"),
                log_line(9, "workflow_completed", workflow_run_id="wf_1"),
            ]))
            windows = PU.phase_windows(log)
            self.assertEqual(len(windows), 1)
            self.assertEqual(windows[0]["end_ms"], ms(9))

    def test_message_after_phase_completed_still_buckets_into_phase(self):
        with TemporaryDirectory() as d:
            log = Path(d) / "execution.ndjson"
            log.write_text("\n".join([
                log_line(1, "phase_started", phase_id="plan", workflow_run_id="wf_1"),
                log_line(5, "phase_completed", phase_id="plan", workflow_run_id="wf_1"),
                log_line(9, "workflow_completed", workflow_run_id="wf_1"),
            ]))
            windows = PU.phase_windows(log)
            events = Path(d) / "agent-events.jsonl"
            events.write_text(message(7, {"input": 10, "output": 5, "cacheRead": 100}))
            buckets = PU.bucket_usage(events, windows)
            self.assertEqual(buckets[("wf_1", "plan")]["input"], 10)
            self.assertNotIn((None, PU.OUTSIDE_PHASE), buckets)


class SubsessionBucketTest(unittest.TestCase):
    """M19 slice 1 (#230 fix 2): agent_end usage joins its own phase row."""

    def _cell(self, d):
        root = Path(d)
        repo = root / "repo"
        (repo / ".as-xflow" / "logs").mkdir(parents=True)
        (repo / ".as-xflow" / "logs" / "execution.ndjson").write_text("\n".join([
            log_line(1, "phase_started", phase_id="plan", workflow_run_id="wf_9"),
            agent_end(2, "plan", {"input": 100, "output": 50, "cache_read": 1000, "cache_write": 10}),
            agent_end(3, "execute", {"input": 7, "output": 3, "cache_read": 70, "cache_write": 0}),
            json.dumps({"timestamp": iso(3), "kind": "agent_event", "event": "tool_start",
                        "phase": "plan", "tool": "shell"}),
            agent_end(3, "plan", None),  # no usage reported: skipped
            log_line(4, "workflow_completed", workflow_run_id="wf_9"),
        ]))
        events = root / "events"
        events.mkdir()
        (events / "agent-events.jsonl").write_text(
            message(2, {"input": 10, "output": 5, "cacheRead": 100, "cacheWrite": 0}))
        return repo, events

    def test_agent_end_merges_into_same_named_phase_row(self):
        with TemporaryDirectory() as d:
            repo, events = self._cell(d)
            rows = PU.cell_phase_rows("tid-1", "sympy__sympy-1", "openflow", 1, repo, events)
            by_phase = {r["phase"]: r for r in rows}
            plan = by_phase["plan"]
            self.assertEqual(plan["workflow_run_id"], "wf_9")
            self.assertEqual(plan["turns"], 2)  # 1 pi message + 1 agent_end
            self.assertEqual(plan["input"], 110)
            self.assertEqual(plan["output"], 55)
            self.assertEqual(plan["cache_read"], 1100)
            self.assertEqual(plan["cache_write"], 10)
            # Phase with no window still lands as its own (None, phase) row.
            execute = by_phase["execute"]
            self.assertIsNone(execute["workflow_run_id"])
            self.assertEqual(execute["turns"], 1)
            self.assertEqual(execute["input"], 7)

    def test_subsession_totals_and_reconcile(self):
        with TemporaryDirectory() as d:
            repo, events = self._cell(d)
            log = repo / ".as-xflow" / "logs" / "execution.ndjson"
            windows = PU.phase_windows(log)
            subs = PU.bucket_subsession_usage(log, windows)
            self.assertEqual(PU.subsession_totals(subs),
                             {"turns": 2, "input": 107, "output": 53,
                              "cache_read": 1070, "cache_write": 10})
            rows = PU.cell_phase_rows("tid-1", "sympy__sympy-1", "openflow", 1, repo, events)
            runs_usage = {"turns": 1, "input": 10, "output": 5,
                          "cache_read": 100, "cache_write": 0}
            rec = PU.reconcile(rows, runs_usage)
            self.assertEqual(rec["difference"], PU.subsession_totals(subs))

    def test_pure_bench_cell_reconciles_to_zero(self):
        with TemporaryDirectory() as d:
            root = Path(d)
            repo = root / "repo"
            (repo / ".as-xflow" / "logs").mkdir(parents=True)
            (repo / ".as-xflow" / "logs" / "execution.ndjson").write_text("\n".join([
                log_line(1, "phase_started", phase_id="plan", workflow_run_id="wf_9"),
                log_line(4, "workflow_completed", workflow_run_id="wf_9"),
            ]))
            events = root / "events"
            events.mkdir()
            (events / "agent-events.jsonl").write_text(
                message(2, {"input": 10, "output": 5, "cacheRead": 100, "cacheWrite": 0}))
            rows = PU.cell_phase_rows("tid-1", "x", "baseline", 1, repo, events)
            rec = PU.reconcile(rows, {"turns": 1, "input": 10, "output": 5,
                                      "cache_read": 100, "cache_write": 0})
            self.assertEqual(rec["difference"],
                             {"turns": 0, "input": 0, "output": 0,
                              "cache_read": 0, "cache_write": 0})


if __name__ == "__main__":
    unittest.main()
