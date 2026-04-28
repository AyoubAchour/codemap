# Task 001: Project setup

**Status:** done
**Phase:** Phase 0 — Setup
**Estimate:** 3–5 hours
**Depends on:** —
**Blocks:** all subsequent tasks (M1 spike, M2 implementation)

## Goal

Scaffold an empty Codemap project with a working dev environment, free-tier CI, and the dependencies declared in `TECH_SPEC.md` §1. After this task: `bun test` runs, `bun run typecheck` passes, and pushing to GitHub triggers green CI on both Bun and Node 22+.

## Context

Prerequisite for every other task. We're not writing product code yet — just the scaffolding so the next tasks (instruction-doc spike, schema implementation) can land tested code immediately.

Project context (also in TECH_SPEC §13): this is a **free personal project**. All choices below stick to free tiers — npm publishing, GitHub Actions, GitHub releases. No paid services in v1.

References:

- `TECH_SPEC.md` §1 (stack table) — locked dependencies
- `TECH_SPEC.md` §2 (project layout) — folder structure
- `TECH_SPEC.md` §13 (distribution) — free-tier policy
- `ROADMAP.md` Phase 0 — exit criteria

## Deliverables

- A **public GitHub repo** named `codemap` (rename freely; the npm package can be `codemap-mcp` or `@<your-username>/codemap-mcp`).
- Local working directory at `~/Desktop/Projects/codemap/` with the structure from `TECH_SPEC.md` §2.
- `package.json` with metadata, scripts, and pinned dependencies.
- `tsconfig.json` configured for Bun + ESM + strict mode.
- `.gitignore` excluding `node_modules/`, `dist/`, build artifacts; **also** excluding `.codemap/` (we don't want our own dogfood graph leaking into the repo during dev — end users will commit `.codemap/` in *their* repos, that's the design).
- `LICENSE` file (recommended: MIT — simplest for personal projects; alternatives noted in §Notes).
- `README.md` placeholder with one-paragraph description and a `v0.0.0 — pre-M1` status note.
- `.github/workflows/ci.yml` running typecheck + tests on push to `main` and on PRs, against a matrix of Bun and Node 22+.
- An initial commit on `main`, pushed to GitHub, CI green.

## Steps

### 1. Verify Bun is installed

```bash
bun --version
```

If not installed, or the version is below 1.1:

```bash
curl -fsSL https://bun.sh/install | bash
exec $SHELL  # reload PATH
bun --version  # expect 1.1+, ideally 1.3+
```

### 2. Initialize folder structure

```bash
cd ~/Desktop/Projects/codemap
mkdir -p src/tools src/cli test/unit test/integration fixtures bin .github/workflows
```

### 3. Initialize git

```bash
git init
git branch -M main
```

### 4. Create `package.json`

Run `bun init -y`, then replace its content with:

```json
{
  "name": "codemap-mcp",
  "version": "0.0.0",
  "type": "module",
  "license": "MIT",
  "description": "Persistent knowledge graph of a codebase, exposed via MCP.",
  "bin": {
    "codemap": "./bin/codemap.ts",
    "codemap-mcp": "./bin/codemap-mcp.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "bun test",
    "test:node": "node --test test/",
    "build": "bun build --compile bin/codemap-mcp.ts --outfile dist/codemap-mcp",
    "lint": "biome check src test"
  },
  "engines": {
    "bun": ">=1.1.0",
    "node": ">=22"
  }
}
```

Notes:

- Adjust `name` if you want an `@username/...` scope. Keep it unscoped if you don't have a personal npm scope yet.
- `bin` paths point at `.ts` for now; in M2 we'll add a build step that emits compiled JS for npm.

### 5. Install dependencies

```bash
bun add @modelcontextprotocol/sdk zod fastest-levenshtein commander proper-lockfile
bun add -d typescript @types/node @types/proper-lockfile @biomejs/biome
```

### 6. Create `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "lib": ["ES2022"],
    "types": ["bun-types", "node"]
  },
  "include": ["src/**/*", "bin/**/*", "test/**/*"]
}
```

### 7. Create `.gitignore`

```
node_modules/
dist/
*.tmp
.codemap/
.DS_Store
.env
.env.local
```

### 8. Add `LICENSE`

Use the standard MIT template ([https://opensource.org/license/mit](https://opensource.org/license/mit)). Replace `<year>` with current year and `<copyright holders>` with your name.

### 9. Add `README.md`

Minimum content:

```markdown
# Codemap

Persistent knowledge graph of a codebase, built incrementally by AI agents during normal work, exposed via MCP. Stored as a JSON file in the repo.

**Status:** v0.0.0 — pre-M1 (project scaffold only).

See `V1_SPEC.md` for what we're building, `TECH_SPEC.md` for how, and `ROADMAP.md` for when.

## License

MIT
```

### 10. Add CI workflow

Create `.github/workflows/ci.yml`:

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  test-bun:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: bun install --frozen-lockfile
      - run: bun run typecheck
      - run: bun test

  test-node:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - uses: oven-sh/setup-bun@v2  # for bun.lockb compat
        with:
          bun-version: latest
      - run: bun install --frozen-lockfile
      - run: bun run typecheck
      - run: node --test test/ || true  # placeholder; Node-runner config in a later task
```

Note: the Node job currently uses Bun for install (because `bun.lockb` is the lockfile) but Node for typecheck/test. The Node test invocation is `|| true` for now since we have no tests; tighten in a follow-up task once tests exist.

### 11. Add minimal smoke test so CI has something to run

Create `test/unit/smoke.test.ts`:

```ts
import { test, expect } from "bun:test";

test("scaffolding works", () => {
  expect(1 + 1).toBe(2);
});
```

### 12. Local sanity check

```bash
bun install
bun run typecheck   # should exit 0
bun test            # should run smoke test, exit 0
```

If both pass, proceed.

### 13. Initial commit and push to GitHub

```bash
git add .
git commit -m "Initial project scaffold

- Bun + TypeScript + zod + MCP SDK + fastest-levenshtein + commander + proper-lockfile
- Strict tsconfig, biome for linting
- CI: matrix of Bun and Node 22+
- LICENSE: MIT
- Placeholder README
"

# Create the GitHub repo using the gh CLI (already installed):
gh repo create codemap --public --source . --remote origin --push
```

### 14. Verify CI

Open the repo on GitHub. The Actions tab should show the CI run kicked off by the initial push. Wait for both `test-bun` and `test-node` jobs to go green.

## Exit criteria

- `bun --version` reports ≥ 1.1.
- `bun run typecheck` exits 0 locally.
- `bun test` exits 0 locally and runs at least the smoke test.
- `git status` clean after the initial commit.
- GitHub repo is public and accessible at `https://github.com/<your-username>/codemap`.
- CI workflow runs on the initial push, both `test-bun` and `test-node` jobs report green.
- `package.json` has all dependencies from TECH_SPEC §1 stack table.
- `.codemap/` is in `.gitignore` (this project; *not* a recommendation for end users).

## Notes

- **Repo name vs npm package name.** They don't have to match. `codemap` (repo) and `codemap-mcp` (npm) is fine. Avoid claiming an npm name until M2 ships something installable.
- **License alternatives.** MIT is the suggestion. Apache-2.0 is more contributor-friendly for orgs. GPL is copyleft. Pick now; can be changed later but rare.
- **Biome vs ESLint+Prettier.** Picked Biome for speed and zero-config. Swap to ESLint if you have a strong existing-config preference.
- **Bun on Windows.** If you're on Windows, run this from WSL2 or skip Bun and use Node 22+ only for now (per platform notes in `TECH_SPEC.md` §1 and §3.4).
- `**gh repo create` requires authentication.** If `gh auth status` shows you're not logged in: `gh auth login` first.
- **Don't commit `bun.lockb` and `package-lock.json` together.** Pick one lockfile (Bun's). The CI sequence above uses `bun install --frozen-lockfile` for both jobs to ensure reproducibility.

