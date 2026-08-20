/** Config file (profiles), environment and credential resolution. */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CliError, EXIT, UsageError } from './errors';

export interface Profile {
  api_token?: string;
  api_key?: string;
  email?: string;
  user_service_key?: string;
  account_id?: string;
  zone_id?: string;
  base_url?: string;
}

export interface Settings {
  /** Default output format when stdout is a TTY (json|table|yaml). */
  output?: string;
  color?: boolean;
  /** Page size hint for paginated lists. */
  per_page?: number;
}

export interface ConfigFile {
  version: 1;
  profile?: string;
  profiles: Record<string, Profile>;
  settings?: Settings;
}

export const ID_RE = /^[0-9a-f]{32}$/i;

export function configDir(): string {
  if (process.env.CMDFLARE_CONFIG_DIR) return process.env.CMDFLARE_CONFIG_DIR;
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg && xdg.trim() ? xdg : join(homedir(), '.config'), 'cmdflare');
}

export function configPath(): string {
  return process.env.CMDFLARE_CONFIG || join(configDir(), 'config.json');
}

export function cacheDir(): string {
  if (process.env.CMDFLARE_CACHE_DIR) return process.env.CMDFLARE_CACHE_DIR;
  const xdg = process.env.XDG_CACHE_HOME;
  return join(xdg && xdg.trim() ? xdg : join(homedir(), '.cache'), 'cmdflare');
}

const EMPTY: ConfigFile = { version: 1, profiles: {} };

export function loadConfig(): ConfigFile {
  const p = configPath();
  if (!existsSync(p)) return structuredClone(EMPTY);
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    return { version: 1, profile: raw.profile, profiles: raw.profiles ?? {}, settings: raw.settings ?? {} };
  } catch (err: any) {
    throw new CliError(`Could not parse config file ${p}: ${err.message}`);
  }
}

export function saveConfig(cfg: ConfigFile): string {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {
    /* best effort (e.g. Windows) */
  }
  return p;
}

export interface Credentials {
  kind: 'token' | 'key' | 'service_key' | 'none';
  apiToken?: string;
  apiKey?: string;
  email?: string;
  userServiceKey?: string;
  /** Human readable origin, e.g. "env CLOUDFLARE_API_TOKEN" or "profile default". */
  source: string;
}

export interface ContextOverrides {
  profile?: string;
  token?: string;
  apiKey?: string;
  email?: string;
  account?: string;
  zone?: string;
  baseUrl?: string;
}

export interface Context {
  profileName: string;
  profile: Profile;
  config: ConfigFile;
  credentials: Credentials;
  /** Resolved 32-hex account id (if known). */
  accountId?: string;
  /** Raw account reference (name) awaiting resolution. */
  accountRef?: string;
  accountSource?: string;
  zoneId?: string;
  zoneRef?: string;
  zoneSource?: string;
  baseURL?: string;
}

const env = (...names: string[]): { value: string; name: string } | undefined => {
  for (const n of names) {
    const v = process.env[n];
    if (v && v.trim()) return { value: v.trim(), name: n };
  }
  return undefined;
};

export const ENV_TOKEN = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_TOKEN', 'CF_API_TOKEN'];
export const ENV_KEY = ['CLOUDFLARE_API_KEY', 'CF_API_KEY'];
export const ENV_EMAIL = ['CLOUDFLARE_EMAIL', 'CLOUDFLARE_ACCOUNT_EMAIL', 'CLOUDFLARE_API_EMAIL', 'CF_API_EMAIL'];
export const ENV_SERVICE_KEY = ['CLOUDFLARE_API_USER_SERVICE_KEY'];
export const ENV_ACCOUNT = ['CLOUDFLARE_ACCOUNT_ID', 'CF_ACCOUNT_ID'];
export const ENV_ZONE = ['CLOUDFLARE_ZONE_ID', 'CF_ZONE_ID'];
export const ENV_BASE_URL = ['CLOUDFLARE_BASE_URL'];

export function resolveContext(o: ContextOverrides = {}, cfg: ConfigFile = loadConfig()): Context {
  const envProfile = env('CMDFLARE_PROFILE');
  const profileName = o.profile || envProfile?.value || cfg.profile || 'default';
  const profile = cfg.profiles[profileName];
  if (!profile && (o.profile || envProfile)) {
    throw new UsageError(
      `Profile "${profileName}" does not exist.`,
      `Known profiles: ${Object.keys(cfg.profiles).join(', ') || '(none)'}. Create one with \`cmdflare auth login --profile ${profileName}\`.`,
    );
  }
  const p = profile ?? {};

  let credentials: Credentials = { kind: 'none', source: 'none' };
  const tokenEnv = env(...ENV_TOKEN);
  const keyEnv = env(...ENV_KEY);
  const emailEnv = env(...ENV_EMAIL);
  const svcEnv = env(...ENV_SERVICE_KEY);
  if (o.token) credentials = { kind: 'token', apiToken: o.token, source: 'flag --token' };
  else if (o.apiKey && (o.email || emailEnv || p.email)) {
    credentials = { kind: 'key', apiKey: o.apiKey, email: o.email || emailEnv?.value || p.email, source: 'flag --api-key' };
  } else if (tokenEnv) credentials = { kind: 'token', apiToken: tokenEnv.value, source: `env ${tokenEnv.name}` };
  else if (keyEnv && (emailEnv || p.email)) {
    credentials = { kind: 'key', apiKey: keyEnv.value, email: emailEnv?.value || p.email, source: `env ${keyEnv.name}` };
  } else if (svcEnv) credentials = { kind: 'service_key', userServiceKey: svcEnv.value, source: `env ${svcEnv.name}` };
  else if (p.api_token) credentials = { kind: 'token', apiToken: p.api_token, source: `profile ${profileName}` };
  else if (p.api_key && p.email) {
    credentials = { kind: 'key', apiKey: p.api_key, email: p.email, source: `profile ${profileName}` };
  } else if (p.user_service_key) {
    credentials = { kind: 'service_key', userServiceKey: p.user_service_key, source: `profile ${profileName}` };
  }

  const ctx: Context = { profileName, profile: p, config: cfg, credentials };

  const accEnv = env(...ENV_ACCOUNT);
  const accountRaw = o.account ? { value: o.account, name: 'flag --account' }
    : accEnv ? { value: accEnv.value, name: `env ${accEnv.name}` }
    : p.account_id ? { value: p.account_id, name: `profile ${profileName}` }
    : undefined;
  if (accountRaw) {
    ctx.accountSource = accountRaw.name;
    if (ID_RE.test(accountRaw.value)) ctx.accountId = accountRaw.value;
    else ctx.accountRef = accountRaw.value;
  }
  const zoneEnv = env(...ENV_ZONE);
  const zoneRaw = o.zone ? { value: o.zone, name: 'flag --zone' }
    : zoneEnv ? { value: zoneEnv.value, name: `env ${zoneEnv.name}` }
    : p.zone_id ? { value: p.zone_id, name: `profile ${profileName}` }
    : undefined;
  if (zoneRaw) {
    ctx.zoneSource = zoneRaw.name;
    if (ID_RE.test(zoneRaw.value)) ctx.zoneId = zoneRaw.value;
    else ctx.zoneRef = zoneRaw.value;
  }
  ctx.baseURL = o.baseUrl || env(...ENV_BASE_URL)?.value || p.base_url;
  return ctx;
}

export function requireCredentials(ctx: Context): Credentials {
  if (ctx.credentials.kind === 'none') {
    throw new CliError('No Cloudflare credentials found.', {
      exitCode: EXIT.AUTH,
      hint:
        'Run `cmdflare auth login` to store an API token, or set CLOUDFLARE_API_TOKEN ' +
        '(or CLOUDFLARE_API_KEY + CLOUDFLARE_EMAIL). Create tokens at https://dash.cloudflare.com/profile/api-tokens',
    });
  }
  return ctx.credentials;
}

export function maskSecret(s: string | undefined): string {
  if (!s) return '';
  if (s.length <= 8) return '*'.repeat(s.length);
  return s.slice(0, 4) + '…' + s.slice(-4);
}
