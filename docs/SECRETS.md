# Secrets runbook (maintainers)

`sqlite-mem` publishes with **npm Trusted Publishing (OIDC)** — not Automation tokens.
npm itself warns against granular tokens for CI/CD; use Trusted Publishing instead.

Optional Vault entries are only for **local** dry-runs (GitHub PAT). CI never calls Vault.

Inventory:

- [`.vault.yaml`](../.vault.yaml) — Vault address / mount / project / config
- [`secrets.manifest.yaml`](../secrets.manifest.yaml) — optional local secrets + OIDC checklist

## Quick commands

```bash
# Full report + Trusted Publishing setup links (never prints secret values)
bun run secrets:doctor

# Validate optional Vault keys + confirm no required Actions secrets are missing
bun run secrets:check

# Sync Vault → GitHub (no-op today: publish does not use repo secrets)
bun run secrets:sync -- --dry-run
```

## One-time: Trusted Publishing (required)

1. Open the package on npm: https://www.npmjs.com/package/sqlite-mem
2. **Settings → Trusted Publisher** (not “Granular Access Token”)
3. Add **GitHub Actions** publisher:
   - Organization/user: `crvouga`
   - Repository: `sqlite-mem`
   - Workflow filename: `ci.yml`
   - Environment: leave empty unless the release job uses one
4. Confirm the release job already has `permissions.id-token: write` in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)

Docs: https://docs.npmjs.com/trusted-publishers

After that, green pushes to `main` with releasable commits publish via OIDC. **Do not** create an npm Automation token or set `NPM_TOKEN` on the repo.

## What exists where

| Credential | Where | Required |
| --- | --- | --- |
| npm Trusted Publisher (OIDC) | npm package settings | **Yes** (CI publish) |
| `GITHUB_TOKEN` | Built into GitHub Actions | Automatic |
| `GH_PAT` | Optional Vault `personal/prd/github` | No (local dry-run only) |
| `NPM_TOKEN` | — | **Not used** |

## Optional: local release dry-run

CI does not need local npm credentials. For `bun run release:dry-run` you only need a GitHub token:

```bash
export VAULT_ADDR=https://vault.chrisvouga.dev
# optional — or use `gh auth token` / an existing GITHUB_TOKEN
export GITHUB_TOKEN="$(vault kv get -mount=secret -field=GH_PAT personal/prd/github)"

bun run build && bun run verify-package
bun run release:dry-run
```

Populate optional PAT in Vault:

```bash
export VAULT_ADDR=https://vault.chrisvouga.dev
printf '%s' "$GH_PAT" | vault kv put -mount=secret personal/prd/github GH_PAT=-
```

Create a PAT (local only): https://github.com/settings/tokens

## Prerequisites (optional Vault tooling)

1. **Vault CLI** — [install](https://developer.hashicorp.com/vault/docs/install), then `export VAULT_ADDR=https://vault.chrisvouga.dev` and `vault login`
2. **GitHub CLI** — [install](https://cli.github.com/), then `gh auth login`

## Validate

```bash
bun run secrets:doctor
```

Healthy Trusted Publishing setup:

- Doctor prints the OIDC checklist with links (manual — npm has no CLI to verify publisher config)
- No required Vault or GitHub Actions secrets missing
- Optional `GH_PAT` may warn/skip if unused
- Release job preflight accepts OIDC without `NPM_TOKEN`

## CI note

The release job runs `bun run release:preflight`, which requires either OIDC (`id-token`) or (legacy) `NPM_TOKEN`. This package standardizes on OIDC only. Preflight does not talk to Vault — use `secrets:doctor` locally for the setup checklist.
