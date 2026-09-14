/** Print the agent skill markdown. */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, EXIT } from '../core/errors';
import { builtinHelpData, writeHelp } from '../core/help';
import { builtinHelpText } from './index';

export function findSkillPath(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const tries = [
    join(here, 'skills/cmdflare/SKILL.md'),
    join(here, '../skills/cmdflare/SKILL.md'),
    join(here, '../../skills/cmdflare/SKILL.md'),
  ];
  for (const p of tries) if (existsSync(p)) return p;
  return undefined;
}

export function runSkill(gf: Record<string, any>): number {
  if (gf.help) {
    writeHelp(gf, builtinHelpText('skill'), builtinHelpData('skill', builtinHelpText('skill')));
    return EXIT.OK;
  }
  const path = findSkillPath();
  if (!path) {
    throw new CliError('Agent skill file not found (skills/cmdflare/SKILL.md).', {
      exitCode: EXIT.ERROR,
      hint: 'Reinstall cmdflare, or read https://github.com/pedrogmbh/cmdflare/blob/main/skills/cmdflare/SKILL.md',
    });
  }
  const text = readFileSync(path, 'utf8');
  process.stdout.write(text.endsWith('\n') ? text : text + '\n');
  return EXIT.OK;
}
