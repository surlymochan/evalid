# evalid Competitive Benchmark

Date: 2026-04-19

## Goal

Make `evalid` stronger than adjacent agent workflow systems in every dimension that matters for serious delivery work: planning, execution, verification, portability, team handoff, and operator confidence.

This benchmark is intentionally stricter than a marketing comparison. A category is only considered won when `evalid` has a named project surface, a command or artifact operators can use, and local tests or drift scans that protect it.

## Reference Systems

- Superpowers: strong skill distribution, agent behavior shaping, and test-driven coding guidance.
- Super-Assistant: broad enterprise harness with team constraints, checkpoint notifications, plugin execution, experience indexing, and S3-backed sync.
- OpenSpec: strong spec-driven workflow, low-friction command surface, and cross-tool positioning.
- gstack: strong role-specialist command surface, browser QA, and host-native release rituals for Codex / Claude Code.
- spec-kit: strong specification-driven development lifecycle, broad public extension surface, and ecosystem credibility.

## Score Dimensions

| Dimension | Win Condition | Current evalid Surface | Current Status |
| --- | --- | --- | --- |
| Local delivery closure | One command family can move from plan through archive with verification evidence. | `xflow:plan`, `xflow:yolo`, `xflow:corps`, `workflows/*.yaml`, archive atoms | Strong |
| Goal alignment | Project direction survives across threads, tools, handoffs, and workflow tracks. | `evalid goal set`, `evalid goal audit`, `evalid compare codex-goal`, `xflow:goal`, `.xflow/GOAL.md`, `docs/goal-vs-codex.md`, yolo/corps/Ralph goal-alignment rules | Strong |
| Executable workflow data | Workflow order is data, validated by schema/tests, not only prose. | `workflows/yolo.yaml`, `workflows/corps.yaml`, `schemas/workflow.schema.json` | Strong |
| Verification rigor | Drift checks, tests, gates, and sync checks catch regressions before release. | `npm test`, `npm run drift:scan`, `npm run skill:diff`, deterministic gates | Strong |
| TDD / code quality push | Red runs before implementation, green runs after implementation, and changed tests are checked for quality anti-patterns. | `I6a.tdd.run`, `I6b.tdd.proof_validate`, `I6c.tdd.quality_review`, `test/tdd-proof.test.js`, `verify_proof.json` | Strong |
| Operator onboarding | First commands explain the human loop, initialize a project, and report whether the local install is ready. | `evalid quickstart`, `evalid guide`, `evalid init`, `evalid doctor`, `npm run doctor` | Strong |
| One-shot evaluation | External evaluators can see quality score, Codex goal / Superpowers / Super-Assistant positioning, plus OpenSpec / gstack comparisons, launch blockers, release-owner status, claim boundaries, next actions, and first-run path from one command family. | `evalid evaluate`, `evalid evaluate --json`, `evalid release status`, `evalid release status --json`, `evalid compare codex-goal --json`, `evalid compare superpowers --json`, `evalid compare super-assistant --json`, `evalid compare openspec --json`, `evalid compare gstack --json`, `evalid assess --json`, `evalid launch audit --json`, `evalid launch claims --json`, `evalid launch copy --json` | Strong |
| Spec durability | Plans, proposal artifacts, workflow deltas, AHA, and handoff survive thread changes. | `specs/changes/*`, `specs/workflow.md`, `AHA.md`, `HANDOFF.md` | Strong |
| Cross-tool portability | Skills and workflows can be installed without personal machine assumptions. | `docs/compatibility.md`, `.as-xflow/config.json`, skillhub sync wrapper, installed skill diff | Strong |
| Public product clarity | New users can understand the system without reading implementation internals. | README badges, `evalid quickstart`, `evalid guide`, `evalid evaluate`, `evalid assess`, `evalid demo launch`, `evalid launch dossier`, `evalid launch claims`, `evalid launch copy`, `evalid launch audit`, `evalid adoption status`, `evalid adoption trial`, `evalid package status`, `evalid package preflight`, `evalid package audit`, `evalid score`, `docs/quality-assessment.md`, `docs/launch-demo.md`, `docs/examples-gallery.md`, `docs/adoption/README.md`, `docs/methodology.md`, `docs/public-benchmark.md`, `RELEASE_NOTES.md`, `docs/fixtures/tracker-item.json`, this benchmark | Strong |
| Team collaboration | Issues, branches, PR/archive state, handoff, and reviewer checks are explicit and auditable. | `docs/reviewer-guide.md`, openissue/archive atoms, current-state handoff block | Strong |
| Control-plane observability | Operators can inspect run state, gates, orphaned runs, and aggregate signals. | `evalid serve`, server tests, timeline analytics | Strong |
| Ecosystem packaging | External users can install, initialize, upgrade, inspect package readiness, and import external tracker context with minimal manual wiring. | `docs/install-upgrade.md`, `docs/public-release.md`, `docs/demo-proof.md`, `docs/fixtures/tracker-item.json`, `.github/workflows/ci.yml`, `package.json` bin/files, `npm run publish:check`, `evalid adapter import-file`, `evalid adapter github-issue` | Strong |

## Current Judgment

`evalid` now beats reference systems on executable workflow depth, local delivery closure, archive discipline, observable heavy-track control, first-run commands, split red/green TDD proof semantics, TDD test-quality review, deterministic requirements-level spec delta review, OpenSpec migration mapping, public release checks, real adapter seams, examples gallery, public benchmark proof, methodology guidance, and reviewer-facing collaboration guidance.

Against Superpowers, xflow should not claim behavior-guidance superiority.
Superpowers remains stronger as lightweight behavior discipline; xflow's
stronger claim is repo-local workflow evidence, cross-tool state, and launch
gates.

Against Super-Assistant, xflow should not claim broader concrete enterprise
connector inventory. Super-Assistant remains a useful reference for DingTalk,
plugin, checkpoint, experience, and S3 patterns. xflow's stronger claim is
absorbing those patterns as a policy overlay and thin atoms, keeping workflow
authority in local YAML, gates, and proof artifacts.

Against gstack, xflow should not claim better role choreography or browser
rituals. The stronger xflow claim is repo-owned workflow truth: checked-in YAML,
goal alignment, handoff/AHA continuity, and launch gates that can be audited
from source checkout without assuming a specific host command pack.

Against Codex native goal, xflow wins only at the project layer: Codex goal is
excellent thread memory, while `.xflow/GOAL.md` becomes stronger when yolo,
corps, Ralph, handoff, and takein all consume it and report alignment. The
score dimension above is intentionally product-facing: a public user should be
able to see why `xflow:goal` is not a duplicate prompt reminder.
CLI users should be able to prove the same story without knowing the skill
system first: `evalid goal set` writes the durable anchor, and `evalid goal show
--json` exposes it to any agent runtime. `evalid goal audit --json` then proves
the core skill family still consumes the anchor instead of leaving it as a
decorative file.

The remaining product moat work is no longer the core engine; it is distribution and ecosystem proof. The current repo now includes a root README with public badges, install/upgrade page, tooling matrix, demo proof page, walkthrough, integration matrix, public release gate, release notes, public benchmark, examples gallery, spec-kit benchmark, and CI-backed minimal adoption example so the external story is testable instead of aspirational.

The highest-leverage path is not more workflow phases. The next win is authenticated public registry publish plus third-party adoption data from real teams, recorded through `docs/adoption/README.md`.

## Proof Commands

```bash
evalid score
evalid quickstart
evalid evaluate --json
evalid assess --json
evalid demo launch --json
evalid launch dossier
evalid launch claims --json
evalid launch copy --json
evalid launch audit --strict --json
evalid adoption kit --name <team-or-project> --source <tracker-or-pr> --track yolo
evalid adoption init --name <team-or-project> --source <tracker-or-pr> --track yolo
evalid adoption validate --json
evalid package preflight --check-registry --check-auth --json
evalid launch audit --pre-publish --strict --json
evalid package audit --check-registry --json
evalid goal show --json
evalid goal audit --json
evalid corps --explain --json
evalid compare codex-goal
evalid compare gstack
evalid compare superpowers
evalid compare super-assistant
evalid compare openspec
evalid compare spec-kit
evalid adapter import-file --input docs/fixtures/tracker-item.json --json
evalid spec delta --change-id <change-id>
npm run release:pack
npm run publish:check
```

## Required Next Wins

1. Run `npm run publish:check`, confirm package ownership and npm identity with `evalid package preflight --check-registry --check-auth --json`, require `evalid launch audit --pre-publish --strict --json` before the irreversible publish, publish the package to the public registry, and verify it with `evalid package audit --check-registry --json`.
2. Extend the current non-fixture maintainer adoption record with at least one third-party tracker workflow using `evalid adoption status`, `evalid adoption trial`, `evalid adoption kit`, `evalid adoption init`, and `docs/adoption/README.md`, then gate it with `evalid adoption validate --json`.
