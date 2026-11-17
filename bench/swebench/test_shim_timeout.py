#!/usr/bin/env python3
"""Tests for the openswarm SHIM_TIMEOUT in harness/arms.py.

Regression test for evalid #213 (M16 slice 2): SHIM_TIMEOUT was
``budget_min * 60 + 30`` while openswarm's own budget is ``budget_min * 60``
seconds, so whenever the executor ran the budget out, openswarm killed the
backend shim (attempt rc=124) before run_pi returned and the shim never
wrote executor-*-record.json / executor-*-events.jsonl. The 840s-budget /
870s-timeout validation cell (sympy__sympy-13878 r1, run
20261117-013602-da5999) lost 843s of executor work: no events file, executor
usage all 0, solution.diff 0 bytes.

Stdlib only, like test_planner_prompt.py: arms.py itself imports swe_env,
which pulls in pandas / swebench, so this test reads shim_timeout_s out of
the source with ast instead of importing the module. That keeps it runnable
by the CI node suite, which shells out here with plain python3.
"""
import ast
import unittest
from pathlib import Path

ARMS = Path(__file__).resolve().parent / "harness" / "arms.py"


def _shim_timeout_s():
    tree = ast.parse(ARMS.read_text())
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == "shim_timeout_s":
            src = ast.get_source_segment(ARMS.read_text(), node)
            ns = {}
            exec(src, ns)  # noqa: S102 - test-only, source is this repo's file
            return ns["shim_timeout_s"]
    raise AssertionError("shim_timeout_s not found in harness/arms.py")


def _arm_openswarm_source() -> str:
    tree = ast.parse(ARMS.read_text())
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == "arm_openswarm":
            return ast.get_source_segment(ARMS.read_text(), node)
    raise AssertionError("arm_openswarm not found in harness/arms.py")


class TestShimTimeout(unittest.TestCase):
    def test_below_openswarm_budget_for_all_budgets(self):
        f = _shim_timeout_s()
        for budget_min in range(1, 61):
            self.assertLess(
                f(budget_min), budget_min * 60,
                f"SHIM_TIMEOUT must stay below the openswarm budget "
                f"({budget_min} min)",
            )

    def test_validation_cell_budget(self):
        # The #213 validation cell: planner 286.2s -> budget_min=14
        # (840s budget); the old 870s timeout lost the events file.
        f = _shim_timeout_s()
        self.assertEqual(f(14), 780)
        self.assertLessEqual(f(14), 800)

    def test_small_budget_floor(self):
        f = _shim_timeout_s()
        self.assertEqual(f(1), 30)
        self.assertGreater(f(1), 0)

    def test_call_site_uses_helper(self):
        src = _arm_openswarm_source()
        self.assertIn("SHIM_TIMEOUT=str(shim_timeout_s(budget_min))", src)
        self.assertNotIn("budget_min * 60 + 30", ARMS.read_text())


if __name__ == "__main__":
    unittest.main()
