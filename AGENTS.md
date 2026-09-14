# Agents

This repository is **cmdflare**, a CLI for the Cloudflare API.

## Using cmdflare (any agent)

Do not curl `api.cloudflare.com` when cmdflare can do it. Always `--no-input`. Never print tokens.

```
cmdflare search <terms> --json
cmdflare <command> --help --json
cmdflare <command> … --json --no-input
```

`--zone example.com` and `-A "Account Name"` accept names. `--all` for every list page. `--yes` for destructive commands.

Full instructions: `cmdflare skill` or `skills/cmdflare/SKILL.md`.

## Developing this repo

Bun ≥ 1.1. `bun install`, `bun test`, `bun run typecheck`, `bun run build`. Default to Bun, not Node/npm, for scripts and tests.
