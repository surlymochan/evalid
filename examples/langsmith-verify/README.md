# LangSmith verify — runnable example

Runs the full `evalid langsmith verify` chain end to end **without a
LangSmith account, API key, or network access**. The traces are
recorded shapes (`runs.json`, the same payloads the bridge tests use
in `test/fixtures/langsmith/runs.json`); the LangSmith client is an
in-memory fake with the same surface the bridge uses (`listRuns` +
`createFeedback`); the claims are verified for real — test runs are
actually replayed in `workspace/`, file claims actually checked
there — and the feedback write is recorded in memory on the trace's
root run.

## Run it

From the repo root:

```bash
node examples/langsmith-verify/run.mjs
```

## What it proves

- **Trace A** (4 runs): the agent claims a passing test run and a
  created file — both true in `workspace/` (`pass.test.mjs` passes,
  `real.txt` exists) — then claims a failing run passed and a file
  that does not exist — both breaches (`fail.test.mjs` fails on
  replay, `ghost.txt` is absent). The tool run's output contains a
  claim-shaped sentence on purpose; tool output is environment data,
  not the agent's words, and is never harvested.
- **Trace B** (1 run): errored before saying anything checkable, so
  it gets no feedback at all.

Observed output (2026-11-19, Node v24.22.1):

```text
evalid langsmith verify — project "fixture-agents"
trace trace-a (4 runs) — 4 claims: 2 confirmed, 2 breach, 0 unknown
  feedback: written (evalid_claim_verified = 0.5)
trace trace-b (1 runs) — 0 claims: 0 confirmed, 0 breach, 0 unknown
  feedback: skipped (no claims in agent prose)
total: 2 traces, 4 claims checked, 1 feedback written.

feedback recorded on root run run-a-root:
  key: evalid_claim_verified (expected evalid_claim_verified)
  score: 0.5
  comment:
    evalid claim verification — deterministic replay, zero-judge.
    trace trace-a · root run run-a-root
    claims: 4 checked — 2 confirmed, 2 breach, 0 unknown (score = confirmed/checked = 0.5)
    - [confirmed] test_run `node --test pass.test.mjs` — source: "Ran `node --test pass.test.mjs`, 1 passed, 0 failed"
    - [confirmed] file_created real.txt — source: "Ran `node --test pass.test.mjs`, 1 passed, 0 failed. Created `real.txt` for the harness."
    - [breach] test_run `node --test fail.test.mjs` — exit: claimed 0, replayed 1 — source: "Ran `node --test fail.test.mjs`, 1 passed, 0 failed"
    - [breach] file_created ghost.txt — file not found: ghost.txt — source: "Ran `node --test fail.test.mjs`, 1 passed, 0 failed. Also created `ghost.txt`."
```

`test/langsmith-example.test.js` spawns this script in CI and
asserts the exit code and the lines above, so the example cannot
silently rot.

## Against a real project

The only difference is the client — same chain, same feedback key
and format:

```bash
LANGSMITH_API_KEY=... evalid langsmith verify --project <name>
```

Add `--dry-run` first to print what would be written without
writing anything. See the LangSmith section in the repo README for
setup, the feedback format, and how each failure mode degrades.
