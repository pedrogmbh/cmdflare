/** search: find commands by keyword. */
import { EXIT, UsageError } from '../core/errors';
import { flattenCommands, searchScore } from '../core/manifest';
import { formatOutput } from '../core/output';
import { c, stdoutIsTTY, termWidth } from '../core/ui';

export async function runSearch(args: string[], gf: Record<string, any>): Promise<number> {
  if (!args.length || gf.help) {
    if (gf.help) {
      process.stdout.write('Usage: cmdflare search <terms...> [--all] [--json]\n');
      return EXIT.OK;
    }
    throw new UsageError('Usage: cmdflare search <terms...>', 'Example: cmdflare search dns records');
  }
  const terms = args.flatMap((a) => a.split(/\s+/)).filter(Boolean);
  const all = flattenCommands();
  const scored = all
    .map((cmd) => ({ cmd, score: searchScore(cmd, terms) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  const limit = gf.all ? scored.length : 30;
  const shown = scored.slice(0, limit);
  const json = gf.json || gf.output === 'json' || !stdoutIsTTY();
  if (json) {
    process.stdout.write(
      formatOutput(
        shown.map(({ cmd }) => ({ command: cmd.cli, http: cmd.method.http, path: cmd.method.path, summary: cmd.method.summary, deprecated: cmd.method.deprecated ?? false })),
        { format: 'json' },
      ) + '\n',
    );
    return EXIT.OK;
  }
  if (!shown.length) {
    process.stdout.write(`No commands match "${terms.join(' ')}". Try broader terms, or \`cmdflare help --tree\`.\n`);
    return EXIT.NOT_FOUND;
  }
  const w = termWidth();
  const left = Math.min(48, Math.max(...shown.map((s) => s.cmd.cli.length)));
  for (const { cmd } of shown) {
    const http = `${cmd.method.http ?? ''} ${cmd.method.path ?? ''}`.trim();
    const summary = cmd.method.summary ?? '';
    const room = Math.max(10, w - left - 3);
    const desc = summary.length > room ? summary.slice(0, room - 1) + '…' : summary;
    process.stdout.write(`${c.cyan(cmd.cli.padEnd(left))}  ${desc}${cmd.method.deprecated ? c.yellow(' (deprecated)') : ''}\n${' '.repeat(left + 2)}${c.dim(http)}\n`);
  }
  if (scored.length > shown.length) process.stdout.write(c.dim(`… ${scored.length - shown.length} more; use --all to list everything.\n`));
  return EXIT.OK;
}
