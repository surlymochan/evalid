#!/usr/bin/env python3
"""Tests for the M16 slice 1 (#205) per-cell $/task cost field and the
wall-clock truncation protocol.

- run.py records cost_usd + cost_price_row on every cell, computed from the
  recorded token counts at the prices.json minimax-m31-flash row
  (MiniMax-M3.1-Flash list prices, fetched 2026-11-15; closest published
  pay-as-you-go price for the bench model MiniMax-M3.1-Flash-Preview).
- report.py prefers the recorded cost for the matching row and falls back
  to recomputation for older rows without the field.
- report.py reports the wall-clock median over uncensored cells only, with
  n, alongside the truncated count (CAP_S 1200s truncates ~93% of cells,
  so the median over all cells is a cap artifact).

Stdlib only, like test_planner_prompt.py: run.py's top-level imports are
stdlib-only (arms/swe_env are imported lazily inside main), so it can be
imported directly.
"""
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
PRICES = json.loads((HERE / "prices.json").read_text())


def _load_run():
    spec = importlib.util.spec_from_file_location("bench_run", HERE / "run.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


RUN = _load_run()


def _row(instance_id, arm, rep, wall_s, timed_out, resolved, tokens, cost_usd=None):
    r = {"instance_id": instance_id, "arm": arm, "rep": rep, "wall_s": wall_s,
         "timed_out": timed_out, "resolved": resolved, "tokens": tokens,
         "calls": [], "errors": [], "model": ["minimax-cn/MiniMax-M3.1-Flash-Preview"]}
    if cost_usd is not None:
        r["cost_usd"] = cost_usd
        r["cost_price_row"] = "minimax-m31-flash"
    return r


class CostFieldTests(unittest.TestCase):
    def test_price_row_present(self):
        row = next(r for r in PRICES["rows"] if r["id"] == "minimax-m31-flash")
        self.assertEqual((row["in"], row["out"], row["cache_read"], row["cache_write"]),
                         (0.15, 0.60, 0.015, 0.0))
        self.assertEqual(row["source"], "https://platform.minimax.io/docs/pricing/overview")
        self.assertEqual(row["fetched"], "2026-11-15")

    def test_cost_formula(self):
        # 1,000,000 in + 500,000 out + 2,000,000 cache_read at 0.15/0.60/0.015
        # = 0.15 + 0.30 + 0.03 = $0.48
        tok = {"input": 1_000_000, "output": 500_000, "cache_read": 2_000_000, "cache_write": 0}
        self.assertAlmostEqual(RUN.cost_usd(tok), 0.48, places=6)

    def test_cost_row_id_matches_prices(self):
        self.assertEqual(RUN.COST_ROW_ID, "minimax-m31-flash")
        self.assertEqual(RUN.COST_ROW["in"], 0.15)

    def test_report_prefers_recorded_cost(self):
        # One row carries a recorded cost that deliberately differs from what
        # its tokens imply: the report must use the recorded value.
        rows = [
            _row("sympy__sympy-17630", "baseline", 1, 1203.0, True, True,
                 {"input": 100_000, "output": 50_000, "cache_read": 2_000_000, "cache_write": 0},
                 cost_usd=9.99),
            _row("sympy__sympy-14248", "baseline", 1, 889.0, False, False,
                 {"input": 100_000, "output": 50_000, "cache_read": 2_000_000, "cache_write": 0}),
        ]
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            runs = td / "runs.jsonl"
            runs.write_text("\n".join(json.dumps(r) for r in rows) + "\n")
            raw = td / "raw"
            raw.mkdir()
            out = td / "out"
            cp = subprocess.run([sys.executable, str(HERE / "report.py"), str(runs),
                                 "--out", str(out), "--raw", str(raw)],
                                capture_output=True, text=True)
            self.assertEqual(cp.returncode, 0, cp.stderr)
            summary = json.loads((out / "summary.json").read_text())
        s = summary["arms"]["baseline"]
        # recorded 9.99 + recomputed 0.075 (0.015+0.03+0.03) -> median 5.0325
        self.assertAlmostEqual(s["cost"]["minimax-m31-flash"]["median_per_run"], 5.0325, places=4)

    def test_report_uncensored_wall_stats(self):
        rows = [
            _row("sympy__sympy-17630", "baseline", 1, 1203.0, True, True,
                 {"input": 1, "output": 1, "cache_read": 1, "cache_write": 0}),
            _row("sympy__sympy-14248", "baseline", 1, 800.0, False, False,
                 {"input": 1, "output": 1, "cache_read": 1, "cache_write": 0}),
            _row("pytest-dev__pytest-5787", "baseline", 1, 1000.0, False, True,
                 {"input": 1, "output": 1, "cache_read": 1, "cache_write": 0}),
        ]
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            runs = td / "runs.jsonl"
            runs.write_text("\n".join(json.dumps(r) for r in rows) + "\n")
            raw = td / "raw"
            raw.mkdir()
            out = td / "out"
            cp = subprocess.run([sys.executable, str(HERE / "report.py"), str(runs),
                                 "--out", str(out), "--raw", str(raw)],
                                capture_output=True, text=True)
            self.assertEqual(cp.returncode, 0, cp.stderr)
            summary = json.loads((out / "summary.json").read_text())
            tables = (out / "tables.md").read_text()
        s = summary["arms"]["baseline"]
        self.assertEqual(s["timed_out"], 1)
        self.assertEqual(s["wall_s_uncensored_n"], 2)
        self.assertEqual(s["wall_s_uncensored_q1_med_q3"][1], 900.0)
        self.assertIn("uncensored cells only", tables)


if __name__ == "__main__":
    unittest.main()
