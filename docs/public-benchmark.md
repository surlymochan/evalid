# Public Benchmark And Demo

This benchmark is the public, repeatable proof path for claims against OpenSpec, gstack, spec-kit, and prompt-only skill systems.

## Demo Scenario

A tracker item arrives from an external system. `evalid` imports the source context, turns it into local change artifacts, reviews spec deltas, and proves the release surface before any public claim or package publish.

## Commands

```bash
evalid init --project-root .
evalid spec start --title "release proof adapter" --change-type backend
evalid objective --json
evalid assess --json
evalid demo launch --json
evalid launch dossier
evalid launch claims --json
evalid launch copy --json
evalid goal audit --json
evalid corps --explain --json
evalid adoption trial --name <team-or-project> --source <tracker-or-pr> --track yolo
evalid launch audit --strict --json
evalid doctor --project-root .
evalid adapter import-file --project-root . --input docs/fixtures/tracker-item.json --json
evalid spec delta --change-id release-proof-adapter
evalid compare codex-goal
evalid compare gstack
evalid compare superpowers
evalid compare super-assistant
evalid compare openspec
evalid compare spec-kit
evalid score
npm run publish:check
evalid package preflight --check-registry --check-auth --json
evalid launch audit --pre-publish --strict --json
```

## Expected Artifacts

| Artifact | Meaning |
| --- | --- |
| `.as-xflow/config.json` | Project-local workflow defaults. |
| `specs/changes/release-proof-adapter/proposal.md` | Imported tracker context, now owned by repo-local xflow artifacts. |
| `specs/changes/release-proof-adapter/status.json` | Draft workflow state and adapter provenance. |
| `specs/changes/release-proof-adapter/spec_delta_review.json` | Requirements-level spec delta review. |
| `npm pack --dry-run` output | Package whitelist proof. |

## Scoring Method

| Dimension | Passing Evidence |
| --- | --- |
| Local engineering closure | `evalid workflow validate yolo`, `evalid workflow validate corps`, archive atoms, release pack. |
| TDD quality pressure | `I6a.tdd.run`, `I6b.tdd.proof_validate`, `I6c.tdd.quality_review`, and `test/tdd-proof.test.js`. |
| gstack comparison | `docs/gstack-comparison.md` and `evalid compare gstack --json`. |
| Superpowers comparison | `docs/superpowers-comparison.md` and `evalid compare superpowers --json`. |
| Super-Assistant comparison | `docs/super-assistant-comparison.md` and `evalid compare super-assistant --json`. |
| OpenSpec migration | `evalid spec openspec-map`, `docs/openspec-migration.md`, and `evalid spec delta`. |
| Spec authoring flow | `evalid spec start`, `docs/openspec-migration.md`, and generated `specs/changes/<id>/` artifacts. |
| spec-kit comparison | `docs/spec-kit-benchmark.md`, `docs/integrations.md`, and `evalid compare spec-kit --json`. |
| Public product readiness | README badges, `RELEASE_NOTES.md`, `docs/fixtures/tracker-item.json`, package whitelist, `npm run publish:check`, `evalid package status --json`, `evalid package preflight --check-registry --check-auth --json`, and `evalid package audit --check-registry --json`. |
| Quality assessment | `evalid assess --json`, `docs/quality-assessment.md`, `docs/goal-vs-codex.md`, `evalid compare codex-goal --json`, `evalid goal audit --json`, and `evalid score --json`. |
| Launch demo | `evalid demo launch --json`, `evalid corps --explain --json`, `evalid launch dossier`, `docs/launch-demo.md`, `docs/launch-dossier.md`, `docs/examples-gallery.md`, `docs/corps-operator-guide.md`, and goal-to-yolo / goal-to-corps proof paths. |
| Launch readiness | `evalid evaluate --json` with `splash_launch` and `splash_claims`, `evalid goal audit --json`, `evalid launch claims --json`, `evalid launch claims --splash --json`, `evalid launch copy --json`, `evalid launch copy --splash --json`, `evalid launch audit --pre-publish --strict --json`, `evalid launch audit --strict --json`, `evalid launch audit --splash --strict --json`, `evalid adoption status --json`, `evalid adoption trial`, `evalid adoption validate --json`, `evalid adoption validate --splash --json`, `evalid package status --json`, `evalid package preflight --check-registry --check-auth --json`, `evalid package audit --check-registry --json`, `docs/public-release.md`, `docs/npm-publish-handoff.md`, `docs/adoption/README.md`, `docs/adoption/openflow-release-hardening.md`, and explicit missing registry proof. |

## Current Result

`evalid` is designed to win the local delivery and verification benchmark because every superiority claim is backed by a runnable command or checked file. Public ecosystem breadth still needs third-party adoption, but the repo now ships the adapter seam, adoption validator, fixture-backed smoke path, and a non-fixture maintainer release-hardening adoption record.
