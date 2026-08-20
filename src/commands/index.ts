/** Builtin (non-API) commands dispatcher. */
import { EXIT, UsageError } from '../core/errors';
import { renderMethodHelp, renderResourceHelp, renderRootHelp, renderTree } from '../core/help';
import { commandPath, getMethodDetail, loadIndex, resolveCommand } from '../core/manifest';
import { c } from '../core/ui';

export const BUILTIN_NAMES = new Set(['auth', 'config', 'api', 'search', 'interactive', 'i', 'completion', 'help', 'version', '__complete']);

export async function runBuiltin(name: string, args: string[], gf: Record<string, any>, argv: string[], version: string): Promise<number> {
  switch (name) {
    case 'version':
      process.stdout.write(`cmdflare ${version}\n`);
      return EXIT.OK;
    case 'help':
      return runHelp(args, gf, version);
    case 'auth': {
      const { runAuth } = await import('./auth');
      return runAuth(args, gf, argv, version);
    }
    case 'config': {
      const { runConfig } = await import('./config-cmd');
      return runConfig(args, gf);
    }
    case 'api': {
      const { runApi } = await import('./api');
      return runApi(args, gf, argv, version);
    }
    case 'search': {
      const { runSearch } = await import('./search');
      return runSearch(args, gf);
    }
    case 'completion': {
      const { runCompletion } = await import('./completion');
      return runCompletion(args, gf);
    }
    case '__complete': {
      const { runCompleteQuery } = await import('./completion');
      return runCompleteQuery(args);
    }
    case 'interactive':
    case 'i': {
      const { runInteractive } = await import('../interactive');
      const start = args.length ? resolveCommand(args) : undefined;
      return runInteractive({ globals: gf, version, startPath: start && start.ok ? start.path : undefined });
    }
    default:
      throw new UsageError(`Unknown builtin ${name}`);
  }
}

function runHelp(args: string[], gf: Record<string, any>, version: string): number {
  if (gf.tree || args[0] === '--tree' || args.includes('--tree')) {
    const path = args.filter((a) => a !== '--tree');
    const res = path.length ? resolveCommand(path) : undefined;
    const node = res && res.ok ? res.node : loadIndex().root;
    const prefix = res && res.ok && res.path.length ? c.bold(commandPath(res.path)) + '\n' : '';
    process.stdout.write(prefix + renderTree(node, res && res.ok && res.path.length ? '  ' : '') + '\n');
    return EXIT.OK;
  }
  if (!args.length) {
    process.stdout.write(renderRootHelp(version) + '\n');
    return EXIT.OK;
  }
  if (BUILTIN_NAMES.has(args[0]!)) {
    return runBuiltinHelp(args[0]!);
  }
  const res = resolveCommand(args);
  if (!res.ok) throw new UsageError(`Unknown command "${res.token}".`, res.suggestions.length ? `Did you mean: ${res.suggestions.join(', ')}?` : undefined);
  if (res.method) process.stdout.write(renderMethodHelp(res.path, getMethodDetail(res.path, res.method)) + '\n');
  else process.stdout.write(renderResourceHelp(res.path, res.node) + '\n');
  return EXIT.OK;
}

export const BUILTIN_HELP: Record<string, string> = {
  auth: `${c.bold('cmdflare auth')} — credentials

  cmdflare auth login [--token <token>] [--api-key <key> --email <email>] [-p <profile>]
      Verify and store credentials in a profile (prompts for the token on a TTY).
  cmdflare auth status          Show which credentials/account/zone are in effect and verify the token
  cmdflare auth whoami          Show the user/token identity
  cmdflare auth logout [-p <profile>]   Remove stored credentials from the profile

Tokens: https://dash.cloudflare.com/profile/api-tokens`,
  config: `${c.bold('cmdflare config')} — profiles & defaults (${c.dim('stored in the config file, see `cmdflare config path`')})

  cmdflare config list                     Show all profiles and settings
  cmdflare config get <key>                Read a value from the current profile
  cmdflare config set <key> <value>        Keys: account_id, zone_id, api_token, api_key, email, base_url, output, color, per_page
  cmdflare config unset <key>
  cmdflare config use <profile>            Switch the default profile
  cmdflare config profiles                 List profiles
  cmdflare config delete-profile <name>
  cmdflare config path                     Print the config file path
  cmdflare config cache clear              Clear the zone/account name cache`,
  api: `${c.bold('cmdflare api')} — call any Cloudflare REST endpoint

  cmdflare api [METHOD] <path> [-P key=value]... [-H 'Header: value']... [-d <json|@file|@->] [--paginate]

  <path> is relative to the API base (e.g. /zones, /accounts/{account_id}/workers/scripts).
  {account_id} / {zone_id} (or :account_id / :zone_id) are filled from -A/-Z, env, or the profile.
  -P adds a query parameter for GET/DELETE and a JSON body field otherwise; -d sets the whole body.
  --paginate follows page/cursor pagination and concatenates results.
  Output is the unwrapped "result" unless --raw-response is given.

Examples:
  cmdflare api /zones -P per_page=5
  cmdflare api GET '/zones/{zone_id}/dns_records' -Z example.com --paginate -q '[*].name'
  cmdflare api POST '/zones/{zone_id}/purge_cache' -Z example.com -d '{"purge_everything":true}'
  cmdflare api DELETE /zones/<id>/dns_records/<record-id> -y`,
  search: `${c.bold('cmdflare search')} <terms...>   Find commands by name, description or HTTP path (use --all to list every match)`,
  completion: `${c.bold('cmdflare completion')} <bash|zsh|fish>   Print a shell completion script

  bash:  echo 'eval "$(cmdflare completion bash)"' >> ~/.bashrc
  zsh:   echo 'eval "$(cmdflare completion zsh)"'  >> ~/.zshrc
  fish:  cmdflare completion fish > ~/.config/fish/completions/cmdflare.fish`,
  interactive: `${c.bold('cmdflare interactive')} [<resource>...]   Menu-driven mode: search commands, fill parameters with prompts, run, and get the equivalent command line.`,
  help: `${c.bold('cmdflare help')} [<command path>] [--tree]   Help for a command; --tree prints the full command tree under a path`,
};

export function runBuiltinHelp(name: string): number {
  const key = name === 'i' ? 'interactive' : name;
  process.stdout.write((BUILTIN_HELP[key] ?? `No help for ${name}`) + '\n');
  return EXIT.OK;
}
