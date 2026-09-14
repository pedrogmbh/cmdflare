---
name: cmdflare
description: Use the cmdflare CLI for Cloudflare API work (DNS, zones, Workers, KV, R2, cache, Zero Trust, and 2,500+ other endpoints). Trigger on Cloudflare dashboard tasks, API calls, wrangler-vs-API questions, zone/record lists, cache purge, or when the user mentions cmdflare. Not for local wrangler.jsonc / wrangler dev / wrangler deploy of a Worker project.
---

# cmdflare

Prefer **cmdflare** over `curl` to `api.cloudflare.com`. Use `cmdflare api METHOD /path` only when no generated command exists. Use **Wrangler** only for a Worker *project* (`wrangler.jsonc`, `wrangler dev`, `wrangler deploy`).

Agents: always `--no-input`. Never prompt. Never print API tokens.

## Loop

1. Discover: `cmdflare search <terms> --json`
2. Schema: `cmdflare <command> --help --json` (required flags, types, example)
3. Run: `cmdflare <command> … --json --no-input`

Full skill text: `cmdflare skill`. Root discovery: `cmdflare --help --json`.

## Auth

Token from env (`CLOUDFLARE_API_TOKEN`, also `CLOUDFLARE_TOKEN` / `CF_API_TOKEN`) or `cmdflare auth login`. User tokens (`cfut_`) and account-owned tokens (`cfat_`) are both `Authorization: Bearer`. Global API keys need `--api-key` and `--email`.

If a command needs an account, pass `-A <id|name>` or `CLOUDFLARE_ACCOUNT_ID`.

## Flags that matter

- Zones/accounts by **name**: `--zone example.com`, `-A "My Account"`
- Lists return **one page** unless `--all` (or `--limit n`)
- Destructive (`delete`, `purge`, `rotate`, …): `--yes`
- `--dry-run` / `--curl` to inspect the request
- Data on stdout; errors on stderr. Exit `0` ok · `2` usage · `3` auth · `4` not found

## Examples

```bash
cmdflare search dns records --json
cmdflare dns records list --help --json
cmdflare dns records list --zone example.com --json --no-input
cmdflare dns records list --zone example.com --all -q '[*].name' --json --no-input
cmdflare cache purge --zone example.com --purge-everything --yes --no-input
cmdflare api GET /zones --paginate -q '[*].name' --json --no-input
```
