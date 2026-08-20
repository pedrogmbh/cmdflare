/** auth: login / status / whoami / logout */
import { createClient } from '../core/client';
import { loadConfig, maskSecret, resolveContext, saveConfig, configPath, type Context, type ConfigFile } from '../core/config';
import { CliError, EXIT, UsageError, formatError } from '../core/errors';
import { formatOutput } from '../core/output';
import { c, canPrompt, log, stdoutIsTTY, withSpinner } from '../core/ui';
import { BUILTIN_HELP } from './index';

function promptContext() {
  return { output: process.stderr, input: process.stdin };
}

export async function runAuth(args: string[], gf: Record<string, any>, _argv: string[], version: string): Promise<number> {
  const sub = args[0] ?? (gf.help ? 'help' : 'status');
  if (gf.help || sub === 'help') {
    process.stdout.write(BUILTIN_HELP.auth + '\n');
    return EXIT.OK;
  }
  switch (sub) {
    case 'login':
      return login(gf, version);
    case 'status':
      return status(gf, version);
    case 'whoami':
      return whoami(gf, version);
    case 'logout':
      return logout(gf);
    default:
      throw new UsageError(`Unknown auth command "${sub}".`, 'Use: auth login | status | whoami | logout');
  }
}

async function verifyToken(client: any): Promise<{ id?: string; status?: string; expires_on?: string; not_before?: string }> {
  const env = await client.get('/user/tokens/verify');
  return env?.result ?? env;
}

async function login(gf: Record<string, any>, version: string): Promise<number> {
  const cfg = loadConfig();
  const profileName: string = gf.profile || process.env.CMDFLARE_PROFILE || cfg.profile || 'default';
  let token: string | undefined = gf.token;
  let apiKey: string | undefined = gf['api-key'];
  let email: string | undefined = gf.email;

  if (!token && !apiKey) {
    if (!canPrompt()) {
      throw new UsageError(
        'No credentials given.',
        'Pass --token <api-token> (or --api-key <key> --email <email>), or run interactively. Create a token at https://dash.cloudflare.com/profile/api-tokens',
      );
    }
    const { password, select, input } = await import('@inquirer/prompts');
    log.info(`${c.bold('Cloudflare login')} ${c.dim(`(profile: ${profileName})`)}`);
    log.info(c.dim('Create an API token at https://dash.cloudflare.com/profile/api-tokens (the "Edit zone DNS" or a custom template).'));
    const kind = await select(
      {
        message: 'Credential type',
        choices: [
          { name: 'API token (recommended)', value: 'token' },
          { name: 'Global API key + email (legacy)', value: 'key' },
        ],
      },
      promptContext(),
    );
    if (kind === 'token') {
      token = (await password({ message: 'Paste your API token', mask: '*' }, promptContext())).trim();
      if (!token) throw new UsageError('Empty token.');
    } else {
      email = email || (await input({ message: 'Account email' }, promptContext())).trim();
      apiKey = (await password({ message: 'Global API key', mask: '*' }, promptContext())).trim();
    }
  }
  if (apiKey && !email) throw new UsageError('--api-key requires --email (or CLOUDFLARE_EMAIL).');

  const ctx = resolveContext({ token, apiKey, email, profile: undefined }, cfg);
  // Force the provided creds regardless of env
  if (token) ctx.credentials = { kind: 'token', apiToken: token, source: 'login' };
  else ctx.credentials = { kind: 'key', apiKey, email, source: 'login' };

  const client = await createClient(ctx, { version });
  let identity = '';
  await withSpinner('Verifying credentials…', async () => {
    if (token) {
      const v = await verifyToken(client);
      if (v?.status && v.status !== 'active') throw new CliError(`Token status is "${v.status}".`, { exitCode: EXIT.AUTH });
      identity = `token ${v?.id ?? ''}${v?.expires_on ? ` (expires ${v.expires_on})` : ''}`.trim();
    } else {
      const u = await client.get('/user');
      identity = `user ${u?.result?.email ?? ''}`.trim();
    }
  });

  const profile = cfg.profiles[profileName] ?? {};
  if (token) {
    profile.api_token = token;
    delete profile.api_key;
    delete profile.email;
  } else {
    profile.api_key = apiKey;
    profile.email = email;
    delete profile.api_token;
  }
  cfg.profiles[profileName] = profile;
  if (!cfg.profile) cfg.profile = profileName;
  if (gf.account) profile.account_id = gf.account;
  if (gf.zone) profile.zone_id = gf.zone;

  // Offer a default account when there is exactly one (or let the user choose interactively).
  if (!profile.account_id) {
    try {
      const env = await client.get('/accounts', { query: { per_page: 50 } });
      const accounts: any[] = env?.result ?? [];
      if (accounts.length === 1) {
        profile.account_id = accounts[0].id;
        log.info(`Default account: ${c.bold(accounts[0].name)} ${c.dim(accounts[0].id)}`);
      } else if (accounts.length > 1 && canPrompt()) {
        const { select } = await import('@inquirer/prompts');
        const choice = await select(
          {
            message: 'Default account for this profile',
            choices: [...accounts.map((a) => ({ name: `${a.name} ${c.dim(a.id)}`, value: a.id as string })), { name: c.dim('(none — pass --account per command)'), value: '' }],
            pageSize: 12,
          },
          promptContext(),
        );
        if (choice) profile.account_id = choice;
      }
    } catch {
      /* token may not be allowed to list accounts */
    }
  }
  const path = saveConfig(cfg);
  log.success(`Logged in as ${identity}. Credentials saved to profile "${profileName}" (${path}).`);
  if (cfg.profile !== profileName) log.hint(`Active profile is still "${cfg.profile}". Use \`cmdflare config use ${profileName}\` to switch, or -p ${profileName} per command.`);
  return EXIT.OK;
}

export function describeContext(ctx: Context): Record<string, any> {
  return {
    profile: ctx.profileName,
    config_file: configPath(),
    credentials: ctx.credentials.kind,
    credentials_source: ctx.credentials.source,
    token: ctx.credentials.apiToken ? maskSecret(ctx.credentials.apiToken) : undefined,
    api_key: ctx.credentials.apiKey ? maskSecret(ctx.credentials.apiKey) : undefined,
    email: ctx.credentials.email,
    account_id: ctx.accountId ?? ctx.accountRef,
    account_source: ctx.accountSource,
    zone_id: ctx.zoneId ?? ctx.zoneRef,
    zone_source: ctx.zoneSource,
    base_url: ctx.baseURL ?? 'https://api.cloudflare.com/client/v4',
  };
}

async function status(gf: Record<string, any>, version: string): Promise<number> {
  const ctx = resolveContext({ profile: gf.profile, token: gf.token, apiKey: gf['api-key'], email: gf.email, account: gf.account, zone: gf.zone, baseUrl: gf['base-url'] });
  const info: Record<string, any> = describeContext(ctx);
  let code: number = EXIT.OK;
  if (ctx.credentials.kind === 'none') {
    info.status = 'no credentials';
    code = EXIT.AUTH;
  } else {
    try {
      const client = await createClient(ctx, { version });
      if (ctx.credentials.kind === 'token') {
        const v = await withSpinner('Verifying token…', () => verifyToken(client));
        info.token_id = v?.id;
        info.status = v?.status ?? 'unknown';
        info.expires_on = v?.expires_on ?? null;
        if (v?.status && v.status !== 'active') code = EXIT.AUTH;
      } else {
        const u = await withSpinner<any>('Verifying credentials…', () => client.get('/user'));
        info.status = 'active';
        info.user = u?.result?.email ?? u?.result?.id;
      }
    } catch (err: any) {
      info.status = 'invalid';
      info.error = formatError(err).message;
      code = EXIT.AUTH;
    }
  }
  const json = gf.json || gf.output === 'json' || !stdoutIsTTY();
  if (json) process.stdout.write(formatOutput(info, { format: 'json' }) + '\n');
  else {
    const ok = info.status === 'active';
    process.stdout.write(`${ok ? c.green('●') : c.red('●')} ${c.bold(String(info.status))} ${c.dim(`(profile ${info.profile}, ${info.credentials} via ${info.credentials_source})`)}\n`);
    for (const [k, v] of Object.entries(info)) {
      if (['status', 'profile', 'credentials', 'credentials_source'].includes(k) || v === undefined) continue;
      process.stdout.write(`  ${c.cyan(k.padEnd(18))} ${v === null ? c.dim('-') : String(v)}\n`);
    }
    if (code === EXIT.AUTH && ctx.credentials.kind === 'none') log.hint('Run `cmdflare auth login` or set CLOUDFLARE_API_TOKEN.');
  }
  return code;
}

async function whoami(gf: Record<string, any>, version: string): Promise<number> {
  const ctx = resolveContext({ profile: gf.profile, token: gf.token, apiKey: gf['api-key'], email: gf.email });
  const client = await createClient(ctx, { version });
  let data: any;
  try {
    data = (await withSpinner<any>('Fetching user…', () => client.get('/user')))?.result;
  } catch {
    data = await verifyToken(client);
    data = { token: data, note: 'Token cannot read /user (needs "User Details: Read"); showing token verification instead.' };
  }
  const json = gf.json || gf.output === 'json' || !stdoutIsTTY();
  process.stdout.write(formatOutput(data, { format: json ? 'json' : 'table' }) + '\n');
  return EXIT.OK;
}

async function logout(gf: Record<string, any>): Promise<number> {
  const cfg: ConfigFile = loadConfig();
  const profileName: string = gf.profile || process.env.CMDFLARE_PROFILE || cfg.profile || 'default';
  const p = cfg.profiles[profileName];
  if (!p) {
    log.warn(`Profile "${profileName}" has no stored credentials.`);
    return EXIT.OK;
  }
  delete p.api_token;
  delete p.api_key;
  delete p.email;
  delete p.user_service_key;
  saveConfig(cfg);
  log.success(`Removed credentials from profile "${profileName}".`);
  return EXIT.OK;
}
