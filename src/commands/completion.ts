/** Shell completion scripts and the hidden __complete query. */
import { EXIT, UsageError } from '../core/errors';
import { loadIndex, resolveCommand, getMethodDetail } from '../core/manifest';
import { flagName } from '../core/names';
import { BUILTIN_NAMES } from './index';

const BASH = `# bash completion for cmdflare
_cmdflare_complete() {
  local IFS=$'\\n'
  local words=("\${COMP_WORDS[@]:1:COMP_CWORD}")
  COMPREPLY=( $(cmdflare __complete -- "\${words[@]}" 2>/dev/null) )
}
complete -o default -F _cmdflare_complete cmdflare
`;

const ZSH = `#compdef cmdflare
_cmdflare() {
  local -a completions
  local IFS=$'\\n'
  completions=( $(cmdflare __complete --zsh -- "\${words[@]:1:CURRENT-1}" 2>/dev/null) )
  if (( \${#completions} )); then
    _describe 'cmdflare' completions
  else
    _files
  fi
}
compdef _cmdflare cmdflare
`;

const FISH = `# fish completion for cmdflare
function __cmdflare_complete
  set -l words (commandline -opc)
  set -l cur (commandline -ct)
  cmdflare __complete --fish -- $words[2..-1] $cur 2>/dev/null
end
complete -c cmdflare -f -a '(__cmdflare_complete)'
`;

export async function runCompletion(args: string[], gf: Record<string, any>): Promise<number> {
  const shell = args[0];
  if (gf.help || !shell) {
    process.stdout.write('Usage: cmdflare completion <bash|zsh|fish>\n');
    return shell ? EXIT.OK : EXIT.USAGE;
  }
  switch (shell) {
    case 'bash':
      process.stdout.write(BASH);
      break;
    case 'zsh':
      process.stdout.write(ZSH);
      break;
    case 'fish':
      process.stdout.write(FISH);
      break;
    default:
      throw new UsageError(`Unsupported shell "${shell}". Use bash, zsh or fish.`);
  }
  return EXIT.OK;
}

const GLOBAL_FLAG_NAMES = ['--output', '--json', '--compact', '--query', '--fields', '--all', '--limit', '--account', '--zone', '--profile', '--token', '--data', '--set', '--yes', '--no-input', '--interactive', '--dry-run', '--curl', '--raw-response', '--include-meta', '--output-file', '--timeout', '--max-retries', '--base-url', '--verbose', '--quiet', '--no-color', '--help', '--version'];

/** `cmdflare __complete [--zsh|--fish] -- <words...>`: words are everything after the program name, last one is the current (possibly empty) word. */
export async function runCompleteQuery(args: string[]): Promise<number> {
  let mode: 'plain' | 'zsh' | 'fish' = 'plain';
  const rest = [...args];
  while (rest[0]?.startsWith('--') && rest[0] !== '--') {
    if (rest[0] === '--zsh') mode = 'zsh';
    if (rest[0] === '--fish') mode = 'fish';
    rest.shift();
  }
  if (rest[0] === '--') rest.shift();
  const words = rest;
  const current = words.length ? words[words.length - 1]! : '';
  const previous = words.slice(0, -1).filter((w) => !w.startsWith('-'));
  const out: Array<[string, string]> = [];
  const emit = (name: string, desc = '') => out.push([name, desc]);

  if (current.startsWith('-')) {
    for (const g of GLOBAL_FLAG_NAMES) emit(g);
    const res = resolveCommand(previous);
    if (res.ok && res.method) {
      const m = getMethodDetail(res.path, res.method);
      for (const p of m.params?.type.props ?? []) emit('--' + flagName(p.name), p.description?.split('\n')[0] ?? '');
    }
  } else if (previous.length === 0) {
    for (const b of BUILTIN_NAMES) if (!b.startsWith('__') && b !== 'i') emit(b);
    for (const ch of loadIndex().root.children) emit(ch.cli);
  } else if (BUILTIN_NAMES.has(previous[0]!)) {
    const subs: Record<string, string[]> = {
      auth: ['login', 'status', 'whoami', 'logout'],
      config: ['list', 'get', 'set', 'unset', 'use', 'profiles', 'delete-profile', 'path', 'cache'],
      completion: ['bash', 'zsh', 'fish'],
      api: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      help: loadIndex().root.children.map((c) => c.cli),
    };
    for (const s of subs[previous[0]!] ?? []) emit(s);
  } else {
    const res = resolveCommand(previous);
    if (res.ok && !res.method) {
      for (const ch of res.node.children) emit(ch.cli, `${ch.methods.length ? ch.methods.map((m) => m.cli).slice(0, 4).join(', ') : 'resource'}`);
      for (const m of res.node.methods) emit(m.cli, m.summary ?? '');
    } else if (res.ok && res.method) {
      for (const p of res.method.positionals) emit(`<${p.cli}>`);
    }
  }
  const filtered = out.filter(([n]) => n.startsWith(current));
  for (const [n, d] of filtered) {
    if (mode === 'zsh') process.stdout.write(`${n.replace(/:/g, '\\:')}${d ? ':' + d.replace(/:/g, ' ') : ''}\n`);
    else if (mode === 'fish') process.stdout.write(`${n}${d ? '\t' + d : ''}\n`);
    else process.stdout.write(n + '\n');
  }
  return EXIT.OK;
}
