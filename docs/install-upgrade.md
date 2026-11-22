# evalid Install And Upgrade

This document defines the public install and upgrade story for source checkouts and npm-style global installs.

## Source Checkout

```bash
git clone <repo-url> evalid
cd evalid
npm install
npm run doctor
```

Use source checkout mode when developing evalid itself or when testing workflow changes before publishing.

## Global CLI

```bash
npm install -g @surlymochan/evalid
evalid doctor
```

The package exposes `evalid` through `package.json` bin metadata.

For local source checkout testing before publication:

```bash
npm install -g .
evalid doctor
```

## Project Adoption

Inside a project that will use xflow:

```bash
evalid init --project-root .
evalid doctor --project-root .
evalid workflow validate yolo
```

This creates `.as-xflow/config.json` and verifies the local runtime before the first real workflow run.
The config is used by workflow aliases, issue routing defaults, and skill sync defaults where explicit CLI args or environment variables are not provided.

## Local Release

```bash
npm run drift:scan
npm run verify
npm run skill:sync
npm run skill:diff
evalid host status --json
```

Use `npm run release:local` when a local release should verify the repo, run the drift scan, refresh the installed `xflow` skill (the host skill keeps its original name), and confirm installed-skill drift is clean.

By default, `npm run skill:sync` refreshes only the Codex installed skill root
at `~/.codex/skills` so the local Codex surface stays canonical and duplicate
skill registration is avoided across multiple hosts. If `~/.codex/skills` does
not exist, it falls back to `~/.agents/skills`. `xmem` follows the same target
selection. Set `SKILL_SYNC_TARGET_DIRS` or
`.as-xflow/config.json -> skills.installed_dir` when you want an explicit
target list instead.

If you want a host-level wrapper instead of remembering shell scripts, use:

```bash
evalid host status --json
evalid host sync
evalid host diff
```

For package distribution readiness:

```bash
npm run release:pack
```

This runs verification, drift scan, installed-skill drift check, and `npm pack --dry-run`.

## Publication Readiness

A release is not ready to publish unless all of these pass:

```bash
npm run release:pack
evalid score
evalid goal audit --json
evalid launch audit
evalid launch audit --strict --json
evalid adoption validate --json
evalid package preflight --check-registry --check-auth --json
evalid launch audit --pre-publish --strict --json
evalid package audit --check-registry --json
evalid compare superpowers
evalid compare super-assistant
evalid compare openspec
evalid compare gstack
evalid compare spec-kit
```

For public publication readiness, use:

```bash
npm run publish:check
```

This adds `npm publish --dry-run --access public` after the local release-pack gate.
Run `evalid package preflight --check-registry --check-auth --json` before the
real publish to confirm npm identity and package-name/version availability
without mutating the registry.
Run `evalid launch audit --pre-publish --strict --json` when you want the same
pre-publish package check combined with score and adoption evidence.

The package dry-run must include `README.md`, `docs/`, `workflows/`, and `xflow/`, while excluding `test/`, local config, Python caches, and Finder metadata.

## Upgrade Checks

After pulling or installing a newer version:

```bash
evalid doctor
npm run drift:scan
npm run skill:diff
npm run release:pack
```

If `skill:diff` reports drift after source changes, run:

```bash
npm run skill:sync
npm run skill:diff
```
