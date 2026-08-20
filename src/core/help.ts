/** Help rendering for root, resources and methods. */
import { flagName } from './names';
import { commandPath, countMethods, loadIndex } from './manifest';
import type { MethodNode, ParamProp, ResourceNode, TypeSpec } from './manifest-types';
import { c, termWidth } from './ui';

export const BIN = 'cmdflare';

export const GLOBAL_OPTIONS: Array<[string, string]> = [
  ['-o, --output <fmt>', 'Output format: json, table, yaml, csv, tsv, ndjson, raw, id (default: table on a TTY, json otherwise)'],
  ['    --json', 'Shorthand for --output json'],
  ['    --compact', 'Single-line JSON'],
  ['-q, --query <path>', 'Select part of the result: a.b, [0], [*].name, items[].id, [?status==active]'],
  ['    --fields <a,b,c>', 'Only include these fields / table columns (dotted paths allowed)'],
  ['    --all', 'Auto-paginate and return every page of a list'],
  ['    --limit <n>', 'Stop after n items'],
  ['-A, --account <id|name>', 'Account to use (default: CLOUDFLARE_ACCOUNT_ID or the profile)'],
  ['-Z, --zone <id|name>', 'Zone to use (default: CLOUDFLARE_ZONE_ID or the profile)'],
  ['-p, --profile <name>', 'Config profile (default: CMDFLARE_PROFILE or "default")'],
  ['    --token <token>', 'API token (default: CLOUDFLARE_API_TOKEN)'],
  ['-d, --data <json|@file|@->', 'Params as JSON/YAML (merged with flags); @file reads a file, @- reads stdin'],
  ['    --set <k.path=value>', 'Set a nested param (repeatable), e.g. --set settings.tls=1.2'],
  ['-y, --yes', 'Do not ask for confirmation (destructive commands)'],
  ['    --no-input', 'Never prompt; fail if something required is missing (CI)'],
  ['-i, --interactive', 'Force interactive mode'],
  ['    --dry-run', 'Print the HTTP request that would be sent, without sending it'],
  ['    --curl', 'Print an equivalent curl command instead of sending the request'],
  ['    --raw-response', 'Print the raw API envelope (success, errors, messages, result, result_info)'],
  ['    --include-meta', 'Include pagination metadata (result_info) alongside the result'],
  ['    --output-file <path>', 'Write binary/raw responses to a file'],
  ['    --timeout <ms>', 'Request timeout in milliseconds'],
  ['    --max-retries <n>', 'Retries on transient failures (default: 2)'],
  ['    --base-url <url>', 'API base URL (default: https://api.cloudflare.com/client/v4)'],
  ['-v, --verbose', 'Log requests/responses to stderr'],
  ['-s, --quiet', 'Suppress informational output on stderr'],
  ['    --no-color', 'Disable colors (also NO_COLOR=1)'],
  ['-h, --help', 'Show help'],
  ['-V, --version', 'Show version'],
];

export const BUILTIN_COMMANDS: Array<[string, string]> = [
  ['auth', 'Log in, show identity, manage credentials (login, status, logout, whoami, tokens)'],
  ['config', 'Manage profiles and defaults (get, set, unset, list, use, path)'],
  ['api', 'Call any REST endpoint directly: api GET /zones, api POST /zones/:id/purge_cache -d ...'],
  ['search', 'Find commands: search dns record'],
  ['interactive', 'Guided, menu-driven mode (also: cmdflare with no arguments on a TTY)'],
  ['completion', 'Print shell completion script (bash, zsh, fish)'],
  ['help', 'Help for a command path, or `help --tree` for the whole command tree'],
];

export function wrap(text: string, width: number, indent = 0): string {
  const pad = ' '.repeat(indent);
  const out: string[] = [];
  for (const para of text.split(/\n\s*\n/)) {
    const words = para.replace(/\s*\n\s*/g, ' ').split(' ');
    let line = '';
    for (const w of words) {
      if ((line + ' ' + w).trim().length > width - indent && line) {
        out.push(pad + line);
        line = w;
      } else line = line ? line + ' ' + w : w;
    }
    if (line) out.push(pad + line);
    out.push('');
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

function twoCol(rows: Array<[string, string]>, indent = 2, gap = 2): string {
  const w = termWidth();
  const left = Math.min(Math.max(...rows.map((r) => r[0].length)), 36);
  return rows
    .map(([a, b]) => {
      const descWidth = Math.max(20, w - indent - left - gap);
      const lines = wrap(b, descWidth).split('\n');
      const first = `${' '.repeat(indent)}${a.padEnd(left)}${' '.repeat(gap)}${lines[0] ?? ''}`;
      const rest = lines.slice(1).map((l) => ' '.repeat(indent + left + gap) + l);
      return a.length > left ? `${' '.repeat(indent)}${a}\n${' '.repeat(indent + left + gap)}${lines.join('\n' + ' '.repeat(indent + left + gap))}` : [first, ...rest].join('\n');
    })
    .join('\n');
}

function columns(items: string[], indent = 2): string {
  const w = termWidth() - indent;
  const colW = Math.max(...items.map((i) => i.length)) + 2;
  const n = Math.max(1, Math.floor(w / colW));
  const rows = Math.ceil(items.length / n);
  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    let line = ' '.repeat(indent);
    for (let col = 0; col < n; col++) {
      const it = items[col * rows + r];
      if (it) line += it.padEnd(colW);
    }
    lines.push(line.trimEnd());
  }
  return lines.join('\n');
}

export function renderRootHelp(version: string): string {
  const idx = loadIndex();
  const total = countMethods(idx.root);
  const lines: string[] = [];
  lines.push(`${c.bold(BIN)} ${c.dim('v' + version)} — Cloudflare API on the command line ${c.dim(`(SDK ${idx.sdkVersion}, ${total} commands)`)}`);
  lines.push('');
  lines.push(c.bold('Usage:'));
  lines.push(`  ${BIN} <resource> [<subresource>...] <command> [arguments] [flags]`);
  lines.push(`  ${BIN} <builtin> ...`);
  lines.push(`  ${BIN}                          ${c.dim('# interactive mode (on a TTY)')}`);
  lines.push('');
  lines.push(c.bold('Examples:'));
  lines.push(`  ${BIN} zones list`);
  lines.push(`  ${BIN} dns records list --zone example.com -o table`);
  lines.push(`  ${BIN} dns records create --zone example.com --type A --name www --content 203.0.113.10 --proxied`);
  lines.push(`  ${BIN} workers scripts list -A my-account --all --json`);
  lines.push(`  ${BIN} api GET /zones --paginate -q '[*].name'`);
  lines.push(`  ${BIN} search purge cache`);
  lines.push('');
  lines.push(c.bold('Builtin commands:'));
  lines.push(twoCol(BUILTIN_COMMANDS));
  lines.push('');
  lines.push(c.bold('API resources:') + c.dim(`  (${BIN} <resource> --help)`));
  lines.push(columns(idx.root.children.map((ch) => ch.cli)));
  lines.push('');
  lines.push(c.bold('Global flags:'));
  lines.push(twoCol(GLOBAL_OPTIONS));
  lines.push('');
  lines.push(c.bold('Environment:'));
  lines.push(
    twoCol([
      ['CLOUDFLARE_API_TOKEN', 'API token (also CLOUDFLARE_TOKEN, CF_API_TOKEN)'],
      ['CLOUDFLARE_API_KEY / CLOUDFLARE_EMAIL', 'Legacy global API key + email'],
      ['CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_ZONE_ID', 'Default account / zone'],
      ['CMDFLARE_PROFILE', 'Config profile to use'],
      ['CMDFLARE_NO_INPUT=1', 'Never prompt (same as --no-input); CI=true has the same effect'],
      ['NO_COLOR', 'Disable colors'],
    ]),
  );
  lines.push('');
  lines.push(c.dim(`Config: ${BIN} config path   Docs: https://developers.cloudflare.com/api/`));
  return lines.join('\n');
}

export function renderResourceHelp(path: ResourceNode[], node: ResourceNode): string {
  const lines: string[] = [];
  const cp = commandPath(path);
  lines.push(`${c.bold(`${BIN} ${cp}`)} ${c.dim(`(${countMethods(node)} commands)`)}`);
  if (node.description) lines.push('', wrap(node.description, termWidth(), 2));
  lines.push('');
  lines.push(c.bold('Usage:'));
  lines.push(`  ${BIN} ${cp} <command> [arguments] [flags]`);
  if (node.methods.length) {
    lines.push('');
    lines.push(c.bold('Commands:'));
    lines.push(
      twoCol(
        node.methods.map((m) => [
          m.cli + (m.deprecated ? c.yellow(' (deprecated)') : ''),
          (m.summary ?? '') + (m.http && m.path ? c.dim(`  ${m.http} ${m.path}`) : ''),
        ]),
      ),
    );
  }
  if (node.children.length) {
    lines.push('');
    lines.push(c.bold('Subresources:'));
    lines.push(twoCol(node.children.map((ch) => [ch.cli, c.dim(`${countMethods(ch)} commands`) + (ch.methods.length ? ': ' + ch.methods.map((m) => m.cli).slice(0, 6).join(', ') + (ch.methods.length > 6 ? ', …' : '') : '')])));
  }
  lines.push('');
  lines.push(c.dim(`Run \`${BIN} ${cp} <command> --help\` for details on a command, \`${BIN} --help\` for global flags.`));
  return lines.join('\n');
}

export function typeLabel(t: TypeSpec | undefined): string {
  if (!t) return 'value';
  switch (t.kind) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'enum':
      return 'enum';
    case 'array':
      return `${typeLabel(t.items)}[]`;
    case 'object':
      return 'object(json)';
    case 'record':
      return 'map(json)';
    case 'file':
      return 'file';
    case 'union':
      return t.members?.map(typeLabel).join('|') ?? 'value';
    default:
      return 'json';
  }
}

function propDesc(p: ParamProp): string {
  const bits: string[] = [];
  if (p.description) bits.push(p.description.split(/\n\s*\n/)[0]!.replace(/\s+/g, ' '));
  if (p.type.kind === 'enum' && p.type.enum) bits.push(c.dim(`[${p.type.enum.slice(0, 12).join('|')}${p.type.enum.length > 12 ? '|…' : ''}]`));
  if (p.type.kind === 'array' && p.type.items?.kind === 'enum' && p.type.items.enum) bits.push(c.dim(`[${p.type.items.enum.slice(0, 12).join('|')}${p.type.items.enum.length > 12 ? '|…' : ''}]`));
  if (p.type.kind === 'object' && p.type.props?.length) {
    const keys = p.type.props.map((sp) => sp.name + (sp.required ? '*' : '')).slice(0, 10);
    bits.push(c.dim(`keys: ${keys.join(', ')}${p.type.props.length > 10 ? ', …' : ''} (use --${flagName(p.name)}.<key> or JSON)`));
  }
  if (p.type.kind === 'file') bits.push(c.dim('(file path, or @- for stdin)'));
  if (p.deprecated) bits.push(c.yellow('(deprecated)'));
  return bits.join(' ');
}

export function isContextParam(name: string): boolean {
  return name === 'account_id' || name === 'zone_id';
}

export function renderMethodHelp(path: ResourceNode[], method: MethodNode): string {
  const lines: string[] = [];
  const cp = commandPath(path, method);
  const pos = method.positionals.map((p) => (p.required ? `<${p.cli}>` : `[${p.cli}]`)).join(' ');
  lines.push(`${c.bold(`${BIN} ${cp}`)}${method.deprecated ? c.yellow(' (deprecated)') : ''}`);
  lines.push('');
  if (method.description) lines.push(wrap(method.description, termWidth(), 2));
  else if (method.summary) lines.push('  ' + method.summary);
  if (method.deprecatedNote) lines.push('', c.yellow('  Deprecated: ' + method.deprecatedNote));
  lines.push('');
  lines.push(c.bold('Usage:'));
  lines.push(`  ${BIN} ${cp}${pos ? ' ' + pos : ''} [flags]`);
  if (method.http && method.path) lines.push('', c.bold('HTTP: ') + `${method.http} ${method.path}`);
  if (method.positionals.length) {
    lines.push('', c.bold('Arguments:'));
    lines.push(twoCol(method.positionals.map((p) => [`<${p.cli}>`, (p.description ?? '') + c.dim(` (${p.type}${p.required ? '' : ', optional'})`)])));
  }
  const props = method.params?.type.props ?? [];
  const required = props.filter((p) => p.required && !isContextParam(p.name));
  const context = props.filter((p) => isContextParam(p.name));
  const optional = props.filter((p) => !p.required && !isContextParam(p.name));
  if (context.length) {
    lines.push('', c.bold('Context:'));
    lines.push(
      twoCol(
        context.map((p) => [
          `--${flagName(p.name)} <id>`,
          (p.name === 'account_id' ? 'Account id. Defaults to -A/--account, CLOUDFLARE_ACCOUNT_ID, or the profile.' : 'Zone id. Defaults to -Z/--zone (name or id), CLOUDFLARE_ZONE_ID, or the profile.') + (p.required ? '' : c.dim(' (optional)')),
        ]),
      ),
    );
  }
  if (required.length) {
    lines.push('', c.bold('Required flags:') + (method.params?.type.variants ? c.dim(`  (merged from ${method.params.type.variants} request variants; "required" means required in all)`) : ''));
    lines.push(twoCol(required.map((p) => [`--${flagName(p.name)} <${typeLabel(p.type)}>`, propDesc(p)])));
  }
  if (optional.length) {
    lines.push('', c.bold('Optional flags:'));
    const byLoc = (loc: string) => optional.filter((p) => (p.location ?? 'body') === loc);
    const groups: Array<[string, ParamProp[]]> = [
      ['body', byLoc('body')],
      ['query', byLoc('query')],
      ['header', byLoc('header')],
      ['path', byLoc('path')],
    ];
    for (const [loc, ps] of groups) {
      if (!ps.length) continue;
      if (groups.filter((g) => g[1].length).length > 1) lines.push(c.dim(`  ${loc}:`));
      lines.push(twoCol(ps.map((p) => [`--${flagName(p.name)} <${typeLabel(p.type)}>`, propDesc(p)])));
    }
  }
  if (method.params && !props.length) {
    lines.push('', c.bold('Params:'), `  --data '<json>'  ${c.dim(method.params.type.text ?? '')}`);
  }
  if (method.paginated) {
    lines.push('', c.bold('Pagination:'), `  Returns the first page by default. Use ${c.cyan('--all')} to fetch every page, ${c.cyan('--limit <n>')} to cap items${props.some((p) => p.name === 'per_page') ? `, ${c.cyan('--per-page <n>')} for page size` : ''}.`);
  }
  if (method.multipart) lines.push('', c.dim('  This command uploads files: pass paths to file flags (or @- to read stdin).'));
  if (method.binary) lines.push('', c.dim('  This command returns binary/raw content; it is written to stdout or --output-file.'));
  if (method.destructive) lines.push('', c.yellow('  Destructive: asks for confirmation on a TTY unless --yes is given.'));
  lines.push('', c.bold('Examples:'));
  lines.push('  ' + exampleFor(cp, method));
  if (method.params && props.length) lines.push(`  ${BIN} ${cp}${pos ? ' ' + pos : ''} --data @params.json`);
  if (method.paginated) lines.push(`  ${BIN} ${cp} --all -o json -q '[*].id'`);
  lines.push('');
  lines.push(c.dim(`Any flag accepts @file / @- to read its value from a file / stdin. Nested values: --parent.child value. Global flags: ${BIN} --help`));
  return lines.join('\n');
}

export function exampleFor(cp: string, method: MethodNode): string {
  const parts = [BIN, cp];
  for (const p of method.positionals) if (p.required) parts.push(`<${p.cli}>`);
  const props = method.params?.type.props ?? [];
  for (const p of props) {
    if (!p.required) continue;
    if (p.name === 'zone_id') {
      parts.push('--zone <zone>');
      continue;
    }
    if (p.name === 'account_id') {
      parts.push('--account <account>');
      continue;
    }
    parts.push(`--${flagName(p.name)} ${placeholder(p)}`);
  }
  return parts.join(' ');
}

function placeholder(p: ParamProp): string {
  switch (p.type.kind) {
    case 'boolean':
      return 'true';
    case 'number':
      return '<n>';
    case 'enum':
      return String(p.type.enum?.[0] ?? '<value>');
    case 'array':
      return '<a,b>';
    case 'object':
    case 'record':
      return "'{...}'";
    case 'file':
      return '<file>';
    default:
      return `<${p.name}>`;
  }
}

export function renderTree(node: ResourceNode, prefix = '', depth = 0, maxDepth = 99): string {
  const lines: string[] = [];
  if (depth > maxDepth) return '';
  for (const m of node.methods) lines.push(`${prefix}${c.green(m.cli)} ${c.dim(m.summary ?? '')}`);
  for (const ch of node.children) {
    lines.push(`${prefix}${c.bold(ch.cli)}${c.dim('/')}`);
    lines.push(renderTree(ch, prefix + '  ', depth + 1, maxDepth));
  }
  return lines.filter((l) => l !== '').join('\n');
}
