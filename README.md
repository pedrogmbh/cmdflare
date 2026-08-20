# cmdflare

**The whole Cloudflare API on your command line.** `cmdflare` turns every endpoint of the official
[Cloudflare TypeScript SDK](https://github.com/cloudflare/cloudflare-typescript) into a command
(2,500+ of them, generated from the SDK so coverage tracks upstream), with:

- **Non-interactive mode** for scripts and CI: predictable flags, JSON by default when piped, meaningful exit codes, `--no-input`, `--yes`, `--dry-run`.
- **Interactive mode** for humans: fuzzy command search, guided prompts for every parameter, pickers for zones/accounts, and the equivalent one-liner printed for reuse.
- **Smart defaults**: zone/account by *name* (`--zone example.com`), profiles, env vars, auto-pagination, table/JSON/YAML/CSV output, `--query` selection.
- **Escape hatch**: `cmdflare api <METHOD> <path>` calls any REST endpoint, even ones the SDK does not model yet.

```
$ cmdflare dns records list --zone example.com
id                                name              type  content        proxied  ttl
3f1c…                             www.example.com   A     203.0.113.10   true     1
a8b2…                             example.com       MX    mail.example   false    3600

$ cmdflare dns records create --zone example.com --type A --name api --content 203.0.113.20 --proxied --ttl 1 --json
{ "id": "…", "name": "api.example.com", "type": "A", … }

$ cmdflare workers scripts list -A "My Account" --all -q '[*].id'
```

## Install

```bash
# with bun (recommended for development)
bun install
bun run build            # generates the command manifest and bundles dist/cli.js
bun link                 # makes `cmdflare` available on your PATH

# or run from source
bun src/cli.ts --help

# once published: npx cmdflare / bunx cmdflare
```

Requires Bun ≥ 1.1 for development; the built CLI runs on Node.js ≥ 20 or Bun.

## Authenticate

```bash
cmdflare auth login                 # prompts for an API token, verifies it, stores it in a profile
cmdflare auth login --token "$CF_TOKEN" -p ci   # non-interactive, into profile "ci"
cmdflare auth status                # what credentials/account/zone are in effect (exit 3 if invalid)
cmdflare auth whoami
cmdflare auth logout
```

Credentials are looked up in this order: `--token` flag → `CLOUDFLARE_API_TOKEN` (also
`CLOUDFLARE_TOKEN`, `CF_API_TOKEN`) → `CLOUDFLARE_API_KEY` + `CLOUDFLARE_EMAIL` → the active profile.
Create tokens at <https://dash.cloudflare.com/profile/api-tokens>.

Config lives in `~/.config/cmdflare/config.json` (`cmdflare config path`). Profiles hold a token plus
default `account_id` / `zone_id`:

```bash
cmdflare config set account_id 8c7434c9906dab3c23d2dd5d46fbb649
cmdflare config set zone_id example.com          # names are resolved on use
cmdflare config set output yaml                  # default TTY output format
cmdflare config use staging                      # switch profiles (or -p staging / CMDFLARE_PROFILE)
```

## Command structure

```
cmdflare <resource> [<subresource>...] <command> [arguments] [flags]
```

Resources mirror the SDK / API docs: `zones`, `dns records`, `workers scripts`, `kv namespaces values`,
`zero-trust access applications`, `r2 buckets`, `rulesets`, … Commands are the SDK methods:
`list`, `get`, `create`, `update`, `edit`, `delete`, plus specific ones (`purge`, `verify`, `rotate`…).
Both `kebab-case` and `camelCase` spellings work; `ls`/`rm`/`show`/`add` are aliases.

Discover commands:

```bash
cmdflare --help                      # overview + all top-level resources
cmdflare dns --help                  # subresources and commands under dns
cmdflare dns records create --help   # arguments, required/optional flags, HTTP route, examples
cmdflare search purge cache          # full-text search across all commands
cmdflare help --tree zero-trust      # the whole command tree under a resource
```

### Arguments and flags

- Resource ids that are part of the URL path are **positional** (`cmdflare dns records get <dns-record-id>`).
- Everything else is a `--flag` named after the API field (`--per-page`, `--proxied`, `--ttl 3600`).
  Types are enforced from the SDK: booleans (`--proxied`, `--proxied=false`), numbers, enums (validated), arrays
  (`--tags a,b` or `--tags '["a","b"]'` or repeated flags), objects (`--settings '{"ipv4_only":true}'` or
  nested flags `--settings.ipv4-only true`), file uploads (`--value ./file.bin`, `@-` for stdin).
- `--zone-id` / `--account-id` are filled automatically from `-Z/--zone`, `-A/--account`,
  `CLOUDFLARE_ZONE_ID` / `CLOUDFLARE_ACCOUNT_ID`, or the profile. Names are accepted and resolved
  (`--zone example.com`, `-A "Acme Corp"`).
- Any flag value can come from a file or stdin: `--description @notes.txt`, `--data @-`.
- Pass the whole request at once with `-d/--data '{…}'` (JSON or YAML, `@file`, `@-`), or set nested
  values with `--set key.path=value`. Flags override `--data`.
- If a command has a parameter that happens to share a name with a global flag (for example
  `--data` on `dns records create`, or `--limit` on cursor-paginated lists), the **parameter wins**;
  use the short form (`-d`, `-q`, `-o`, …) or `--cf-<flag>` for the global one. `--help` tells you.

### Output

| Flag | Effect |
| --- | --- |
| `-o table` (TTY default) | Columns picked automatically (id, name, status, …), fits the terminal |
| `-o json` / `--json` (default when piped) | Pretty JSON (`--compact` for one line) |
| `-o yaml`, `-o csv`, `-o tsv`, `-o ndjson`, `-o raw`, `-o id` | … |
| `-q, --query <path>` | Select data: `[*].name`, `result.items[0].id`, `[?status==active].id`, `a.b` |
| `--fields id,name,account.name` | Restrict columns / keys |
| `--all` / `--limit <n>` | Auto-paginate every page / cap the number of items |
| `--include-meta` | Wrap as `{result, result_info, has_more}` |
| `--raw-response` | Print the API envelope (`success`, `errors`, `messages`, `result`) |
| `--output-file <path>` | Write output (or binary downloads) to a file |

Data goes to **stdout**, everything else (hints, spinners, errors) to **stderr**.

### Safety and CI

- Destructive commands (`delete`, `purge`, `rotate`, `revoke`, …) ask for confirmation on a TTY;
  non-interactively they require `--yes`.
- `--dry-run` prints the exact HTTP request (method, URL, headers, JSON body) without sending it; `--curl`
  prints an equivalent `curl` command.
- `--no-input` (or `CMDFLARE_NO_INPUT=1`, or `CI=true`) never prompts: missing required values fail with exit 2.
- Exit codes: `0` ok · `1` API/other error · `2` usage error · `3` authentication · `4` not found ·
  `5` rate limited · `130` cancelled.
- `-v/--verbose` logs every request/response (status, timing, `cf-ray`) to stderr.

```yaml
# GitHub Actions example
- run: bunx cmdflare cache purge --zone example.com --purge-everything --yes
  env:
    CLOUDFLARE_API_TOKEN: ${{ secrets.CF_API_TOKEN }}
```

## Interactive mode

Run `cmdflare` with no arguments in a terminal (or `cmdflare interactive`, `cmdflare -i`, or a partial
path like `cmdflare dns records`):

1. **Search** commands by typing (`dns records list`, `purge cache`) or browse the resource tree.
2. Fill **positional ids** and **required parameters** through typed prompts (enums become menus,
   zones/accounts/DNS records become searchable pickers). Large accounts prefetch several pages, then
   typing searches the API (`name=contains:…` for zones, `search=` for DNS records) instead of only
   the first 50 items. Objects can be filled field by field or as JSON.
3. Optionally add any of the **optional parameters**.
4. See the **equivalent command line** (copy it into your scripts/CI), confirm, run.
5. Inspect the result as table / JSON / YAML, save it to a file, fetch remaining pages, run another.

Missing required values are also prompted for in normal mode when you are on a TTY — e.g.
`cmdflare dns records get` will ask for the record id and zone instead of failing.

## Raw API access

```bash
cmdflare api /zones -P per_page=5                         # GET is the default
cmdflare api GET '/zones/{zone_id}/dns_records' -Z example.com --paginate -q '[*].name'
cmdflare api POST '/zones/{zone_id}/purge_cache' -Z example.com -d '{"purge_everything":true}'
cmdflare api PUT  '/accounts/{account_id}/storage/kv/namespaces/NS/values/key' -d @value.json
cmdflare api DELETE /zones/<id>/dns_records/<rid> --yes
```

`{account_id}` / `{zone_id}` (or `:account_id` / `:zone_id`) are filled from your context; `-P key=value`
adds query params (GET/DELETE) or body fields; `-H 'Name: value'` adds headers; `--paginate` follows
page/cursor pagination.

## Shell completion

```bash
echo 'eval "$(cmdflare completion bash)"' >> ~/.bashrc
echo 'eval "$(cmdflare completion zsh)"'  >> ~/.zshrc
cmdflare completion fish > ~/.config/fish/completions/cmdflare.fish
```

## Environment variables

| Variable | Meaning |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` (`CLOUDFLARE_TOKEN`, `CF_API_TOKEN`) | API token |
| `CLOUDFLARE_API_KEY` + `CLOUDFLARE_EMAIL` | Legacy global API key |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID` | Default account / zone (id or name) |
| `CLOUDFLARE_BASE_URL` | API base URL (default `https://api.cloudflare.com/client/v4`) |
| `CMDFLARE_PROFILE` | Config profile |
| `CMDFLARE_CONFIG_DIR`, `CMDFLARE_CACHE_DIR` | Override config / cache locations |
| `CMDFLARE_NO_INPUT`, `CI` | Never prompt |
| `NO_COLOR`, `FORCE_COLOR` | Color control |

## How it works / development

- `scripts/gen-manifest.ts` walks the installed `cloudflare` package's TypeScript declarations with the
  TypeScript compiler API and the compiled JS, and emits `src/generated/` (a light `index.json` for startup,
  one detail file per top-level resource, and `modules.ts` for lazy SDK imports). Re-run `bun run gen`
  after upgrading the `cloudflare` dependency — new endpoints become commands automatically.
- At runtime only the SDK module for the invoked resource is loaded (≈70 ms startup on Bun).
- `bun test` runs unit tests plus end-to-end tests against a fake Cloudflare API.
- `bun run typecheck`, `bun run build` (→ `dist/cli.js`, Node-compatible), `bun run dev -- zones list`.

## License

GPL-3.0 — see [LICENSE](LICENSE).
