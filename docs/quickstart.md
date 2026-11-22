# evalid Quickstart

Use this path when you want a project to adopt evalid without reading the implementation first.

## 0. See The Delivery Loop

Use the published package path when `evalid` is available from npm:

```bash
npm install -g @surlymochan/evalid
evalid quickstart
evalid guide
evalid evaluate
evalid assess
evalid demo clean
evalid demo launch
evalid launch dossier
```

Use source checkout mode before npm publication:

```bash
git clone <repo-url> evalid
cd evalid
npm install
npm run release:pack
node bin/evalid.js quickstart
node bin/evalid.js evaluate
node bin/evalid.js assess
node bin/evalid.js demo clean
node bin/evalid.js compare codex-goal
node bin/evalid.js launch dossier
```

This shows the human-facing loop and the current quality scorecard for goal,
yolo, corps, and the overall skill family. The demo command shows the public
goal-to-yolo and goal-to-corps proof story; the launch audit names any missing
evidence before public promotion; the launch dossier turns the same evidence
into a one-page public narrative.

Release-owner checks are deliberately separate from this first-run path:

```bash
evalid release status --json
evalid adoption trial --name first-team --source first-tracker --track yolo
evalid adoption kit --name first-team --source first-tracker --track yolo
evalid adoption init --name first-team --source first-tracker --track yolo
evalid adoption status --json
evalid adoption validate --json
evalid adoption validate --splash --json
evalid package status --json
evalid package preflight --check-registry --check-auth --json
evalid launch audit --pre-publish --strict --json
evalid launch audit --splash --strict --json
evalid package audit --check-registry --json
```

`evalid adoption status` summarizes ordinary and splash adoption blockers without
failing the release-owner checklist. `evalid adoption trial` previews the external team's copy-paste command sequence
and evidence checklist without writing files. `evalid adoption kit` creates a
shareable trial packet for an external project.
`evalid adoption init` creates only a draft that must be filled from that real
trial before `evalid adoption validate --json` can pass. Package preflight blocks
the irreversible publish when npm identity or package availability is missing;
`evalid package status --json` summarizes that package state without failing;
package audit fails until the npm registry reports the expected public package
name and version. Splash validation is stricter than ordinary adoption
validation: it requires third-party adoption evidence beyond maintainer
dogfooding before broad ecosystem claims are allowed.

## 1. Initialize

```bash
evalid init --project-root .
evalid goal set "Ship the next verified change" --project-root .
evalid goal audit --project-root . --json
```

This writes `.as-xflow/config.json` with portable defaults for workflow paths, skill paths, and issue routing.
Workflow aliases such as `yolo` and `corps` read this config when `--project-root` points at the initialized project. Issue setup and installed skill sync can also read their defaults from this file.
The goal command writes `.xflow/GOAL.md`, the project direction anchor consumed by `xflow:goal`, `xflow:yolo`, `xflow:corps`, `xflow:ralph`, `xflow:handoff`, and `xflow:takein`. The audit command fails if the project has no durable goal or if the packaged skill family stops declaring that goal as an intake and proof input.

## 2. Check Readiness

```bash
evalid doctor --project-root .
```

Doctor checks package scripts, workflow YAML validity, skill topology, and the project root used by execution.

## 3. Validate The Lite Workflow

```bash
evalid workflow validate yolo
```

Use `corps` instead of `yolo` when validating the heavy workflow.
Validation is preflight only; run the heavy track through `evalid corps` and
confirm final completion with `evalid proof --track corps`.

## 4. Run A Lite Change

```bash
evalid workflow run yolo --title "<中文标题>" --change-type backend \
  --tdd-red-command "npm test -- --grep new-failing-case" \
  --tdd-green-command "npm test"
```

For real project work, run this from a branch whose name can derive a `CHANGE_ID`, or pass `--change-id <id>`.
The red command runs before implementation and must fail. After the execute step, the green command must pass, and evalid writes `quality-0.json` to prove code changes came with meaningful changed tests instead of empty assertions, snapshot-only tests, or mock-heavy smoke.

## 5. Run A Heavy Corps Change

```bash
evalid serve &
evalid corps --title "<产品标题>" --change-type frontend --change-id <id>
evalid proof --track corps --change-id <id>
```

The conversation AI should not manually emulate `xflow:corps`; it clarifies
requirements, handles human-gate acknowledgements, and inspects
`corps_proof.json`. The proof only passes when the built-in corps manifest,
hash-linked phase/atom/gate witnesses, required artifacts, product contracts,
and no stubbed runtime fallback all pass together.

## Release Checks

```bash
npm run drift:scan
npm run verify
npm run skill:sync
npm run skill:diff
npm run release:pack
evalid host status --json
```

Use `npm run release:local` when you intentionally want verification followed by installed skill sync.
By default, `npm run skill:sync` refreshes `~/.codex/skills`, and falls back to
`~/.agents/skills` only when the Codex install root does not exist. `xmem`
follows the same target selection. Set `SKILL_SYNC_TARGET_DIRS` when you want
an explicit multi-target sync.

For a clean adoption example, use the minimal temporary project flow shown in [docs/demo-proof.md](./demo-proof.md).

Low-friction spec and QA helpers:

```bash
evalid spec start --title "example change" --change-type backend
evalid qa capture --url http://127.0.0.1:3000 --platform-profile mobile_h5
```

## Team Adoption

For a team rollout, use [docs/team-adoption.md](./team-adoption.md) before the
first shared PR. It defines the operator/reviewer/release-owner roles, required
CI checks, PR acceptance checklist, and the 95 percent public-promotion gate.
