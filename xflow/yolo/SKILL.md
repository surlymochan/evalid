---
name: xflow:yolo
description: "轻量轨交付工作流：从 change-init 到 archive。适用于后端、文档、基础设施和小型 UI 改动。可复用 xflow:plan 产物，或在缺少 plan 时先补一轮通用规划。"
---

# Superflow Yolo — Track Execution Driver

This skill drives the lite workflow. It does not own a separate planning
track; planning is shared with `xflow:plan`.

## How to run

```bash
xflow workflow validate workflows/yolo.yaml
```

Then execute the workflow phases in order.

For a full run:

```bash
xflow workflow run workflows/yolo.yaml --title "<中文标题>" --change-type backend
```

Drive the run with one `workflow run` invocation per gate stop. Do not
step atoms one by one: every atom-by-atom round trip re-reads the whole
context, and the executor already runs each phase's atoms in one pass.

When `--change-id` is omitted and the current branch cannot provide one
(e.g. `main`), the run derives the change id from `--title` and prints it;
pass `--change-id` explicitly to override.

## Plan reuse rule

Planning rules (reuse, merged red-proof pass, boundaries) live in
`xflow:plan` and are not restated here. The yolo-specific duty: read
`.xflow/GOAL.md` before execution when present, and state in the final
verification summary whether the change
aligns with it, intentionally narrows it, or conflicts with it.

## State and context

- Project root: `process.env.XFLOW_PROJECT_ROOT || cwd`
- Project goal: `.xflow/GOAL.md` when present; use it as direction context only
- Change root: `specs/changes/${CHANGE_ID}/`
- Status file: `specs/changes/${CHANGE_ID}/status.json`

## Phase playbook

1. `change-init`
2. `brainstorm`
3. `design-check` if the change is frontend/UI
4. `proposal-freeze`
5. `proposal-consistency-check`
6. `plan`
7. `tdd` (red proof — sealed in the same pass as the plan, see below)
8. `openissue`
9. `set-in-progress`
10. `execute`
11. `verify-consistency`
12. `archive`

On the lite track, `brainstorm`, `proposal-freeze` and
`proposal-consistency-check` are skipped as ceremony (`lite_skip` in the
YAML): the proposal is scaffolded in `change-init` and consumed by `plan`
directly, direction decisions happen inside the plan pass, and no
human-gate stop is spent on brainstorm. The verification spine — tdd-red
and tdd-green seals, I6d, J1, J6 — is unchanged on both tracks.

On the lite track the red proof is sealed immediately after planning: the
pass that writes the plan also writes the failing test, so `tdd-red` only
runs and seals it — no second exploration pass, and the issue/branch
ceremony no longer sits between planning and the red proof.

In `verify-consistency`, run the deterministic gates first. The J6 proof
(`specs/changes/${CHANGE_ID}/cr/review-0.json`) carries a `seal_partition`:
files whose bytes still match the green proof's sealed hashes
(`sealed_unchanged`) are exactly what the TDD gate verified — the review
pass does not re-read them. Only `seal_drifted` files (changed after the
green seal, or never sealed) get a fresh read. When `seal_partition` is
null there is no green seal to trust, and the review re-reads everything.

The workflow YAML is the canonical execution source for atom order, gates, and
artifact checks. This skill only explains the contract.

## Guardrails

- Planning rules live in `xflow:plan`; this skill does not restate them
- Do not treat `.xflow/GOAL.md` as executable scope; it is alignment context
  that must be reflected in the final verification summary
- Do not enter `set-in-progress` or `execute` unless doctor confirms the linked branch and checkout are ready
- Do not expose deleted top-level xflow utility skills as entry points
