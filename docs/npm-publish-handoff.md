# npm Publish Handoff

Date: 2026-05-23

Use this page for the final irreversible public publish step. Everything here
is intentionally explicit because `npm publish --access public` changes public
distribution state.

## Automated publish (trusted publishing)

The registry-mutating step normally runs from GitHub Actions, not from a
local shell: `.github/workflows/npm-publish.yml` publishes via npm trusted
publishing (OIDC — no stored npm token anywhere) whenever a GitHub Release
is published, and can also be started manually (workflow_dispatch) to
publish the version in `package.json` if that version is not on npm yet.
Before publishing it runs the same `npm run release:pack` gate as the manual
sequence below, and for release events it refuses to publish when the
release tag does not match the `package.json` version. The manual sequence
below remains the fallback for when Actions or the trusted-publisher
registration on npmjs.com is unavailable.

## Current Verified State

- Package: `evalid@0.2.0`
- Registry name status: available in `evalid package preflight --check-registry --check-auth --json`
- Current machine auth: blocked by `npm whoami` with `ENEEDAUTH`
- Adoption gate: `evalid adoption validate --json` passes with
  `docs/adoption/openflow-release-hardening.md`
- Splash gate: `evalid release status --json` still reports
  `third_party_adoption` alongside `published_package`; use
  `evalid adoption brief --name <third-party-project> --source <public-pr-or-external-repo> --track yolo`
  to generate the outbound ask, then
  `evalid adoption trial --name <third-party-project> --source <public-pr-or-external-repo> --track yolo`
  before asking an external team to create reviewable evidence.
- Launch gate: `evalid launch audit --strict --json` still lists only
  `published_package`

Do not claim public installability until the registry reports `evalid@0.2.0`.

## Auth Recovery

```bash
npm login
npm whoami
evalid package status --json
evalid package preflight --check-registry --check-auth --json
```

The preflight must report:

- `ok: true`
- `registry_status: "available"` for a first publish
- a non-empty `npm_identity`
- no `registry already contains evalid@0.2.0` issue
- `next_actions` containing `run_pre_publish_gate` as the next release-owner
  command

## Final Publish Sequence

Run from the repository root after npm auth is restored:

```bash
npm run release:pack
npm run publish:check
evalid release status --json
evalid adoption brief --name <third-party-project> --source <public-pr-or-external-repo> --track yolo
evalid adoption trial --name <third-party-project> --source <public-pr-or-external-repo> --track yolo
evalid adoption validate --json
evalid goal audit --json
evalid package status --json
evalid package preflight --check-registry --check-auth --json
evalid launch audit --pre-publish --strict --json
npm publish --access public
evalid package audit --check-registry --json
evalid launch audit --strict --json
```

The real publish is allowed only after the pre-publish launch audit is green.
After publish, the strict launch audit is allowed to become green only when
`evalid package audit --check-registry --json` confirms the public registry
returns the expected name and version.

## Stop Conditions

- `npm whoami` fails: restore npm auth first.
- Registry already contains `evalid@0.2.0`: do not republish; bump version or
  verify ownership before continuing.
- `evalid package preflight --check-registry --check-auth --json` fails: follow
  its `next_actions` before retrying or publishing.
- `npm run release:pack` fails: fix local quality before publishing.
- `evalid adoption validate --json` fails: restore a non-fixture adoption record.
- `evalid launch audit --pre-publish --strict --json` fails: do not publish.
- `evalid package audit --check-registry --json` fails after publish: follow its
  `next_actions`; do not claim public installability until it passes.
- `npm publish --dry-run --access public` includes test fixtures, Python caches,
  local `.as-xflow/` state, or secrets: fix package inclusion before publishing.
