# evalid Quality Assessment

Date: 2026-05-23

## Verdict

`evalid` is strong enough to present as a serious open-source agent delivery
runtime today. The core engine is no longer the weak point: yolo and corps both
have executable workflow data, verification gates, and release checks.

The remaining gap for an industry splash is distribution proof: publish the
package and show a polished external demo. Fixture-only adoption proof has been
replaced with a reviewable maintainer release-hardening record, while broader
third-party adoption remains the next ecosystem win.

In readiness terms, the current state is:

- `source_checkout`: ready
- `open_source_launch`: blocked by `published_package`
- `industry_splash`: blocked by `published_package` and `third_party_adoption`

## Objective Audit

- `goal_vs_codex`: proven at the project layer
- `yolo_delivery`: proven from source checkout
- `corps_delivery`: proven from source checkout
- `skill_family_open_source_credibility`: ready from source checkout
- `open_source_launch`: blocked by `published_package`
- `industry_splash`: blocked by `published_package` and `third_party_adoption`

## Can evalid Beat Codex Native Goal?

Yes, but only in a specific way.

Codex native goal is better for one active thread: it is close to the model,
cheap to update, and useful for completion accounting. `xflow:goal` is better
for project delivery when `.xflow/GOAL.md` becomes a durable artifact that yolo,
corps, Ralph, handoff, and takein all read and audit.

That distinction is the product claim:

```text
Codex goal = thread memory
evalid goal = project alignment evidence
```

## Scorecard

| Surface | Grade | Current Evidence | Next Win |
| --- | --- | --- | --- |
| `xflow:goal` | A | `.xflow/GOAL.md`, `evalid goal set`, `evalid goal show --json`, `evalid goal audit --json`, `docs/goal-vs-codex.md` | Real examples where goal alignment changed review or handoff quality |
| `xflow:yolo` | A | YAML workflow, split TDD proof, quality review, archive order, drift tests | Tiny public bugfix demo from red proof to archive |
| `xflow:corps` | A | Governed corps entry, `evalid corps --explain`, `corps_proof.json`, visual benchmark gates, no-stub witnesses | Real product/UI adoption walkthrough backed by corps proof |
| Skill family | A- | `evalid quickstart`, `evalid guide`, `evalid assess`, `evalid score`, tooling matrix, skill sync/diff, `docs/adoption/openflow-release-hardening.md` | Public npm publish plus third-party adoption evidence |

## Public Proof Path

```bash
evalid objective
evalid objective --json
evalid assess
evalid assess --json
evalid evaluate
evalid evaluate --json
evalid compare codex-goal --json
evalid compare superpowers --json
evalid compare super-assistant --json
evalid compare gstack --json
evalid demo launch
evalid demo launch --json
evalid launch dossier
evalid launch claims --json
evalid launch copy --json
evalid launch audit
evalid launch audit --json
evalid launch audit --strict --json
evalid adoption kit --name <team-or-project> --source <tracker-or-pr> --track yolo
evalid adoption init --name <team-or-project> --source <tracker-or-pr> --track yolo
evalid adoption status --json
evalid adoption validate --json
evalid adoption validate --splash --json
evalid package status --json
evalid package preflight --check-registry --check-auth --json
evalid launch audit --pre-publish --strict --json
evalid launch audit --splash --strict --json
evalid package audit --check-registry --json
evalid score --json
evalid goal show --json
evalid goal audit --json
evalid corps --explain --json
npm run drift:scan
npm run release:pack
```

`evalid assess` is the human-facing assessment. `evalid score` is the repository
evidence gate. `release:pack` proves the shipped package includes the current
docs, CLI, workflows, atoms, and skill sources.
`docs/npm-publish-handoff.md` is the last-mile publish checklist once npm auth
is restored.

## Completion Boundary

Internal quality is ready: `evalid score --json` is 100/100, `evalid goal audit
--json` proves the Codex-goal comparison at the project layer, and
`npm run release:pack` proves the package contents. The remaining blockers are
external proof, not hidden engine work:

- `npm_auth_and_publish`: requires release-owner npm auth, preflight, real
  `npm publish --access public`, and registry audit.
- `third_party_adoption`: requires a real third-party project or public PR
  started from `evalid adoption kit`, captured with
  `docs/adoption/<team-or-project>.md`, and validated by `evalid adoption
  validate --splash --json`.

`evalid evaluate --json` reports both ordinary launch readiness and stricter
`splash_launch` readiness, plus ordinary `claims` and stricter `splash_claims`,
so evaluators can distinguish source-checkout quality, post-publish package
proof, and broad ecosystem claims.

## Open-Source Launch Bar

Before calling the launch story excellent rather than merely ready:

1. Publish the npm package from the verified tarball only after `evalid package preflight --check-registry --check-auth --json` confirms npm identity and package-name/version availability, and `evalid launch audit --pre-publish --strict --json` confirms score plus adoption evidence are not being bypassed.
2. Keep `evalid adoption validate --json` green with at least one non-fixture
   adoption record. The current maintainer release-hardening record proves the
   gate works and names the remaining npm-publication failure; the next
   ecosystem upgrade is a third-party project or public PR using
   `evalid adoption kit` before converting trial results into the same
   evidence shape.
3. Keep `docs/launch-demo.md`, `docs/launch-dossier.md`,
   `docs/corps-operator-guide.md`, and `evalid demo launch` current as the
   canonical walkthrough for `goal -> yolo` and `goal -> corps proof`, and keep
   `evalid launch dossier` aligned as the concise public-facing summary.
4. Make `published_package` disappear from `evalid launch audit --strict --json` only
   after `evalid package audit --check-registry --json` confirms the npm
   registry reports the expected package name and version.
5. Keep the scorecard honest: if any public claim lacks a runnable command,
   checked artifact, or drift test, downgrade it until evidence exists.
