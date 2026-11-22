# Public Release Gate

This page defines the final public-release boundary for evalid. It is intentionally stricter than local development because distribution is part of the product surface.

## Current Registry Status

The package name `evalid` was checked against the npm public registry during the release-hardening pass and returned `404 Not Found`, meaning no published package with that name was visible at that time.

Do not treat this as permanent ownership. Re-check before publishing.

```bash
npm view @surlymochan/evalid name version --json
```

## Release Check

Run:

```bash
npm run publish:check
evalid evaluate --json
evalid release status --json
evalid launch dossier --output docs/launch-dossier.md
evalid launch claims --json
evalid launch copy --json
evalid adoption trial --name <team-or-project> --source <tracker-or-pr> --track yolo --json
evalid goal audit --json
evalid adoption status --json
evalid package status --json
evalid package preflight --check-registry --check-auth --json
evalid launch audit --pre-publish --strict --json
evalid package audit --check-registry --json
evalid launch audit --strict
```

For the exact last-mile command sequence and current auth boundary, use
[npm Publish Handoff](./npm-publish-handoff.md).

This expands to:

```bash
npm run release:pack
npm publish --dry-run --access public
```

Expected proof:

- full test suite passes
- active-surface drift scan passes
- installed evalid skill diff is clean
- npm package dry-run excludes local config, tests, Python caches, and Finder metadata
- npm publish dry-run can construct the public package without mutating the registry
- evaluate gives a single machine-readable brief with score, Codex goal / Superpowers positioning, launch blockers, package evidence, release-owner status, safe claims, and the recommended first-run path
- launch dossier gives reviewers one concise, audit-backed summary of quality, goal comparison, yolo/corps proof paths, release gate, and blockers
- launch claims lists public claims that are safe now and claims that must wait for missing evidence
- launch copy generates announcement text, evaluation commands, and forbidden phrases from the same claim boundary
- launch audit includes `next_actions` so the release owner can see the exact commands needed to clear missing evidence
- launch audit embeds package preflight/audit `next_actions` under
  `package_evidence` so automation can diagnose npm auth or registry blockers
  without a second CLI call
- launch audit separates `available_surfaces` from `ready_surfaces` so runnable checks are not mistaken for evidence that has already passed
- goal audit proves `.xflow/GOAL.md` exists and the core skill family still consumes it before goal superiority claims are published
- package preflight confirms npm identity and package-name/version availability before the irreversible publish
- npm publish handoff records the current auth boundary and exact stop conditions
- pre-publish launch audit confirms the release is ready for the irreversible publish step, while still refusing to hide missing adoption or package proof
- package audit confirms the public npm registry reports the expected name and version
- launch audit separates verified engine/adoption/package evidence from missing registry proof

## Authentication Check

The real publish requires an authenticated npm session:

```bash
npm whoami
```

If this returns `E401 Unauthorized`, stop at `npm run publish:check`; the package is dry-run ready but cannot be published from this machine until npm auth is restored.

## Actual Publish Boundary

Only run the real publish after the release check is green and version ownership is confirmed.

```bash
npm publish --access public
```

## Required Pre-Publish Evidence

Record these in the release note or PR:

- `npm run release:pack`
- `npm run publish:check`
- `evalid evaluate --json`
- `evalid release status --json`
- `evalid launch dossier --output docs/launch-dossier.md`
- `evalid launch claims --json`
- `evalid launch copy --json`
- `evalid adoption trial --name <team-or-project> --source <tracker-or-pr> --track yolo --json`
- `evalid goal audit --json`
- `evalid adoption status --json`
- `evalid package status --json`
- `evalid package preflight --check-registry --check-auth --json`
- `evalid launch audit --pre-publish --strict --json`
- `evalid adoption validate --json`
- `evalid adoption validate --splash --json`
- `evalid package audit --check-registry --json`
- `evalid launch audit --strict --json`
- `evalid launch audit --splash --strict --json`
- `docs/adoption/README.md` reviewed, with at least one real adoption record before splash launch
- `docs/adoption/openflow-release-hardening.md` reviewed as the current non-fixture adoption record
- `docs/npm-publish-handoff.md` reviewed before real publish
- `evalid score`
- `evalid compare superpowers`
- `evalid compare super-assistant`
- `evalid compare openspec`
- `evalid compare gstack`
- `evalid compare spec-kit`
- `docs/team-adoption.md` 95 percent readiness gate reviewed
- `git status --short --branch`

## Failure Rules

- If `npm view @surlymochan/evalid` returns an existing package not owned by this project, choose a new package name before publishing.
- If `evalid package preflight --check-registry --check-auth --json` fails, do not run the real publish.
- If `evalid goal audit --json` fails, do not claim evalid goal is stronger than Codex native goal.
- If `evalid launch claims --json` lists a claim under `blocked_claims`, do not use that claim in launch copy.
- If `evalid launch copy --json` lists a phrase under `forbidden_phrases`, do not use that phrase in launch posts, README badges, or release notes.
- If `evalid launch audit --pre-publish --strict --json` fails, do not run the real publish; strict pre-publish mode runs the same npm identity and registry checks as package preflight, then combines them with score and adoption evidence.
- If `evalid package audit --check-registry --json` fails after publish, do not claim public package availability.
- If `npm publish --dry-run` includes `test/`, `.claude/`, `__pycache__`, `.pyc`, or local `.as-xflow/` state, fix package inclusion before publishing.
- If `evalid score` falls below `100/100`, fix score evidence before publishing.
- If `evalid launch audit --strict --json` lists `real_external_adoption` as missing,
  publish can still be dry-run ready, but do not claim an industry-splash
  launch until a real adoption artifact exists under `docs/adoption/` or a
  linked public PR provides equivalent evidence. The audit removes this gap
  only when the adoption validator passes.
- If `evalid launch audit --splash --strict --json` lists `third_party_adoption`
  as missing, do not claim broad third-party adoption or industry-splash
  readiness; maintainer dogfooding can support quality claims, but not ecosystem
  adoption claims.
- If `evalid compare spec-kit` points to missing docs, do not publish a superiority claim.
- If `evalid compare gstack` cannot clearly explain where gstack is stronger, do not publish a fair comparison claim.
- If `evalid compare superpowers` cannot explain where Superpowers is stronger, do not publish a fair comparison claim.
- If `evalid compare super-assistant` cannot explain where Super-Assistant keeps stronger enterprise connector breadth, do not publish a fair comparison claim.
- If the team adoption operating model is not linked from README or reviewer docs, do not promote the package for multi-person adoption.
