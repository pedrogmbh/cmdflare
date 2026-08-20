# cmdflare

[![npm](https://img.shields.io/npm/v/cmdflare)](https://www.npmjs.com/package/cmdflare)
[![CI](https://github.com/pedrogmbh/cmdflare/actions/workflows/release.yml/badge.svg)](https://github.com/pedrogmbh/cmdflare/actions/workflows/release.yml)
[![node](https://img.shields.io/node/v/cmdflare)](https://www.npmjs.com/package/cmdflare)
[![license](https://img.shields.io/github/license/pedrogmbh/cmdflare)](LICENSE)

The Cloudflare API, as a command. List DNS, purge cache, ship Workers — from a terminal or from CI. 2,500+ commands, generated from the [official SDK](https://github.com/cloudflare/cloudflare-typescript).

```
$ cmdflare dns records list --zone example.com
id                                name              type  content        proxied  ttl
3f1c…                             www.example.com   A     203.0.113.10   true     1
a8b2…                             example.com       MX    mail.example   false    3600

$ cmdflare dns records create --zone example.com --type A --name api --content 203.0.113.20 --proxied --ttl 1 --json
{ "id": "…", "name": "api.example.com", "type": "A", … }

$ cmdflare workers scripts list -A "My Account" --all -q '[*].id'
```

## Try it

```bash
npm i -g cmdflare          # Node.js ≥ 20; or: bunx cmdflare / npx cmdflare
cmdflare auth login        # paste a Cloudflare API token
cmdflare zones list
```

Create a token at [API Tokens](https://dash.cloudflare.com/profile/api-tokens) (user) or **Manage Account → Account API Tokens** (account-owned, `cfat_…`). Then:

```bash
cmdflare dns records list --zone example.com
cmdflare cache purge --zone example.com --purge-everything --yes
```

Or skip login and export `CLOUDFLARE_API_TOKEN` (also `CLOUDFLARE_TOKEN` / `CF_API_TOKEN`).

## Interactive

Run `cmdflare` with no arguments. Type `dns records`, pick a zone by name, fill the rest. It prints the equivalent one-liner so you can paste it into a script later.

Same idea for a partial path: `cmdflare dns records` opens that menu. On a TTY, missing flags are prompted instead of failing — `cmdflare dns records get` will ask for the record and the zone.

## Commands

```
cmdflare <resource> [<subresource>...] <command> [arguments] [flags]
```

Resources match the API: `zones`, `dns records`, `workers scripts`, `kv namespaces values`, `r2 buckets`, `zero-trust access applications`, `rulesets`, … Commands are SDK methods (`list`, `get`, `create`, `update`, `edit`, `delete`, plus `purge`, `verify`, `rotate`, …). `kebab-case` and `camelCase` both work; `ls` / `rm` / `show` / `add` are aliases.

```bash
cmdflare --help
cmdflare dns --help
cmdflare dns records create --help
cmdflare search purge cache
cmdflare help --tree zero-trust
```

Path ids are positional (`cmdflare dns records get <dns-record-id>`). Everything else is a `--flag` named after the API field. Zones and accounts accept **names**: `--zone example.com`, `-A "Acme Corp"` (or `CLOUDFLARE_ZONE_ID` / `CLOUDFLARE_ACCOUNT_ID`, or a profile default).

## Scripts and CI

JSON when piped, tables on a TTY. Destructive commands ask on a TTY and need `--yes` otherwise. `--no-input` (or `CI=true`) never prompts.

```yaml
- run: bunx cmdflare cache purge --zone example.com --purge-everything --yes
  env:
    CLOUDFLARE_API_TOKEN: ${{ secrets.CF_API_TOKEN }}
```

Exit codes: `0` ok · `1` API/other · `2` usage · `3` auth · `4` not found · `5` rate limited · `130` cancelled.

## Output

| Flag | Effect |
| --- | --- |
| `-o table` (TTY default) | Columns picked automatically, fits the terminal |
| `-o json` / `--json` (piped default) | Pretty JSON (`--compact` for one line) |
| `-o yaml`, `-o csv`, `-o tsv`, `-o ndjson`, `-o raw`, `-o id` | … |
| `-q, --query <path>` | Select data: `[*].name`, `[?status==active].id` |
| `--fields id,name,account.name` | Restrict columns / keys |
| `--all` / `--limit <n>` | Every page / cap items |
| `--dry-run` / `--curl` | Print the request (or a `curl`) without sending it |

Stdout is data. Hints, spinners, and errors go to stderr.

## Flags in more detail

- Types come from the SDK: booleans (`--proxied`, `--proxied=false`), numbers, enums, arrays (`--tags a,b` or JSON or repeated flags), objects (`--settings '{"ipv4_only":true}'` or `--settings.ipv4-only true`), files (`--value ./file.bin`, `@-` for stdin).
- `--description @notes.txt` and `--data @-` read a file or stdin.
- `-d/--data '{…}'` (JSON or YAML) sets the whole body; `--set key.path=value` patches nested fields; flags win over `--data`.
- If a parameter shares a name with a global flag (`--data` on DNS create, `--limit` on some lists), the **parameter wins**. Use `-d` / `-q` / `-o` or `--cf-<flag>` for the global. `--help` says which.
- `--include-meta` wraps `{result, result_info, has_more}`. `--raw-response` prints the API envelope. `--output-file` writes downloads.

## Auth and profiles

```bash
cmdflare auth login
cmdflare auth login --token "$CF_TOKEN" -p ci
cmdflare auth status
cmdflare auth whoami
cmdflare auth logout
```

Lookup order: `--token` → `CLOUDFLARE_API_TOKEN` (`CLOUDFLARE_TOKEN`, `CF_API_TOKEN`) → `CLOUDFLARE_API_KEY` + `CLOUDFLARE_EMAIL` → the active profile.

User tokens (`cfut_…` or older unprefixed strings) and account-owned tokens (`cfat_…`) both go out as `Authorization: Bearer`. Global API keys (`cfk_…`) still need `--api-key` and `--email`.

Config is `~/.config/cmdflare/config.json` (`cmdflare config path`). A profile stores the token plus optional default account/zone:

```bash
cmdflare config set account_id 8c7434c9906dab3c23d2dd5d46fbb649
cmdflare config set zone_id example.com          # names are resolved on use
cmdflare config set output yaml
cmdflare config use staging                      # or -p staging / CMDFLARE_PROFILE
```

## Raw API

Any REST path, including endpoints the SDK does not model yet:

```bash
cmdflare api /zones -P per_page=5
cmdflare api GET '/zones/{zone_id}/dns_records' -Z example.com --paginate -q '[*].name'
cmdflare api POST '/zones/{zone_id}/purge_cache' -Z example.com -d '{"purge_everything":true}'
cmdflare api DELETE /zones/<id>/dns_records/<rid> --yes
```

`{account_id}` / `{zone_id}` are filled from context. `-P` is query or body; `-H` adds headers; `--paginate` follows pages.

## Completion

```bash
echo 'eval "$(cmdflare completion bash)"' >> ~/.bashrc
echo 'eval "$(cmdflare completion zsh)"'  >> ~/.zshrc
cmdflare completion fish > ~/.config/fish/completions/cmdflare.fish
```

## Environment

| Variable | Meaning |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` (`CLOUDFLARE_TOKEN`, `CF_API_TOKEN`) | API token |
| `CLOUDFLARE_API_KEY` + `CLOUDFLARE_EMAIL` | Legacy global API key |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID` | Default account / zone (id or name) |
| `CLOUDFLARE_BASE_URL` | API base (default `https://api.cloudflare.com/client/v4`) |
| `CMDFLARE_PROFILE` | Config profile |
| `CMDFLARE_CONFIG_DIR`, `CMDFLARE_CACHE_DIR` | Config / cache locations |
| `CMDFLARE_NO_INPUT`, `CI` | Never prompt |
| `NO_COLOR`, `FORCE_COLOR` | Color |

## Development

From a clone (Bun ≥ 1.1):

```bash
bun install
bun run build            # manifest + dist/cli.js
bun link                 # `cmdflare` on your PATH
bun src/cli.ts --help    # or run TypeScript directly
bun test
bun run typecheck
bun run dev -- zones list
```

`scripts/gen-manifest.ts` walks the `cloudflare` package and writes `src/generated/`. Re-run `bun run gen` after upgrading the SDK — new endpoints become commands. Runtime loads only the SDK module for the command you ran.

## License

GPL-3.0 — see [LICENSE](LICENSE).
