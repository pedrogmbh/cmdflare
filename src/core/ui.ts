/** Terminal helpers: colors, tty detection, logging, spinner. Output to stderr never pollutes data on stdout. */

const ESC = String.fromCharCode(27);

let colorEnabled: boolean | undefined;
let verbose = false;
let quiet = false;
let noInput = false;

export function setColor(v: boolean | undefined) {
  colorEnabled = v;
}
export function setVerbose(v: boolean) {
  verbose = v;
}
export function setQuiet(v: boolean) {
  quiet = v;
}
export function setNoInput(v: boolean) {
  noInput = v;
}
export const isVerbose = () => verbose;
export const isQuiet = () => quiet;

export const stdoutIsTTY = () => !!process.stdout.isTTY;
export const stderrIsTTY = () => !!process.stderr.isTTY;
export const stdinIsTTY = () => !!process.stdin.isTTY;

/** True when a human is likely at the keyboard (and we may prompt). */
export function canPrompt(): boolean {
  if (noInput) return false;
  if (process.env.CMDFLARE_NO_INPUT === '1' || process.env.CMDFLARE_NO_INPUT === 'true') return false;
  if (process.env.CI && process.env.CI !== 'false' && process.env.CI !== '0') return false;
  return stdinIsTTY() && stderrIsTTY();
}

export function useColor(): boolean {
  if (colorEnabled !== undefined) return colorEnabled;
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false;
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0') return true;
  if (process.env.TERM === 'dumb') return false;
  return stdoutIsTTY();
}

const wrap = (open: number, close: number) => (s: string | number) =>
  useColor() ? `${ESC}[${open}m${s}${ESC}[${close}m` : String(s);

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  underline: wrap(4, 24),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
  white: wrap(37, 39),
};

const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

export function termWidth(): number {
  const w = process.stdout.columns || process.stderr.columns;
  return w && w > 20 ? w : 100;
}

export const log = {
  info(msg: string) {
    if (!quiet) process.stderr.write(msg + '\n');
  },
  success(msg: string) {
    if (!quiet) process.stderr.write(c.green('✔ ') + msg + '\n');
  },
  warn(msg: string) {
    if (!quiet) process.stderr.write(c.yellow('! ') + msg + '\n');
  },
  error(msg: string) {
    process.stderr.write(c.red('✖ ') + msg + '\n');
  },
  debug(msg: string) {
    if (verbose) process.stderr.write(c.gray('· ' + msg) + '\n');
  },
  hint(msg: string) {
    if (!quiet) process.stderr.write(c.dim(msg) + '\n');
  },
};

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Minimal spinner on stderr; no-op when not a TTY or in quiet mode. */
export async function withSpinner<T>(text: string, fn: () => Promise<T>): Promise<T> {
  if (!stderrIsTTY() || quiet || !useColor()) return fn();
  let i = 0;
  const write = () => process.stderr.write(`\r${c.cyan(FRAMES[i++ % FRAMES.length]!)} ${text}`);
  write();
  const timer = setInterval(write, 80);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
    process.stderr.write(`\r${ESC}[2K`);
  }
}

export function plural(n: number, word: string, pluralWord?: string): string {
  return `${n} ${n === 1 ? word : (pluralWord ?? word + 's')}`;
}
