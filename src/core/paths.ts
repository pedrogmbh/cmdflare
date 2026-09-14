/** Filesystem path helpers for user-supplied values. */
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * Expands a leading `~` to the user's home directory.
 *
 * The shell normally does this, but not when the argument is quoted (`'~/backup'`), written as
 * `--flag=~/x`, typed at an interactive prompt, or stored in a config profile — so the CLI has to.
 * `~user` is left alone: resolving another user's home is not portable.
 */
export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}

/** `expandHome` + `path.resolve`: the absolute path a user meant by a path-ish argument. */
export function resolvePath(p: string): string {
  return resolve(expandHome(p));
}

export { isAbsolute };
