/** API token format detection and verification (user vs account-owned). */
import { CliError, EXIT } from './errors';

/** Prefixed scannable formats from https://developers.cloudflare.com/fundamentals/api/get-started/token-formats/ */
export type TokenFormat = 'account' | 'user' | 'global_key' | 'legacy';

export interface TokenVerifyResult {
  id?: string;
  status: string;
  expires_on?: string | null;
  not_before?: string | null;
  /** user = /user/tokens/verify; account = account-owned (cfat_) token. */
  kind: 'user' | 'account';
  account_id?: string;
  account_name?: string;
}

export function detectTokenFormat(token: string | undefined): TokenFormat | undefined {
  if (!token) return undefined;
  if (token.startsWith('cfat_')) return 'account';
  if (token.startsWith('cfut_')) return 'user';
  if (token.startsWith('cfk_')) return 'global_key';
  return 'legacy';
}

function unwrap(env: any): any {
  return env && typeof env === 'object' && 'result' in env ? env.result : env;
}

function isTokenRejected(err: any): boolean {
  const status = err?.status;
  if (status === 401 || status === 403) return true;
  const codes = Array.isArray(err?.errors) ? err.errors.map((e: any) => e?.code) : [];
  return codes.includes(1000) || codes.includes(9103) || codes.includes(9109);
}

async function verifyUserToken(client: any): Promise<TokenVerifyResult> {
  const r = unwrap(await client.get('/user/tokens/verify')) ?? {};
  return {
    id: r.id,
    status: r.status ?? 'unknown',
    expires_on: r.expires_on ?? null,
    not_before: r.not_before ?? null,
    kind: 'user',
  };
}

async function verifyAccountToken(client: any, accountId: string): Promise<TokenVerifyResult> {
  try {
    const r = unwrap(await client.get(`/accounts/${accountId}/tokens/verify`)) ?? {};
    return {
      id: r.id,
      status: r.status ?? 'active',
      expires_on: r.expires_on ?? null,
      not_before: r.not_before ?? null,
      kind: 'account',
      account_id: accountId,
    };
  } catch (err) {
    // Some account tokens cannot call tokens/verify but still work on the account itself.
    if (!isTokenRejected(err)) throw err;
    const a = unwrap(await client.get(`/accounts/${accountId}`)) ?? {};
    return {
      status: 'active',
      kind: 'account',
      account_id: a.id ?? accountId,
      account_name: a.name,
    };
  }
}

async function verifyViaAccountList(client: any): Promise<TokenVerifyResult> {
  const env = await client.get('/accounts', { query: { per_page: 50 } });
  const items: any[] = Array.isArray(unwrap(env)) ? unwrap(env) : Array.isArray(env?.result) ? env.result : [];
  if (!items.length) {
    throw new CliError('Token was accepted but listed no accounts.', {
      exitCode: EXIT.AUTH,
      hint: 'Pass -A <account id> or set CLOUDFLARE_ACCOUNT_ID, then retry.',
    });
  }
  if (items.length === 1 && items[0]?.id) {
    try {
      const v = await verifyAccountToken(client, String(items[0].id));
      return { ...v, account_name: v.account_name ?? items[0].name };
    } catch {
      return { status: 'active', kind: 'account', account_id: String(items[0].id), account_name: items[0].name };
    }
  }
  return { status: 'active', kind: 'account' };
}

/**
 * Prove a Bearer API token works.
 * User tokens (`cfut_` / legacy) use GET /user/tokens/verify.
 * Account-owned tokens (`cfat_`) are rejected there (401 [1000]); use the account verify path instead.
 */
export async function verifyApiToken(client: any, opts: { token?: string; accountId?: string } = {}): Promise<TokenVerifyResult> {
  const format = detectTokenFormat(opts.token);
  const accountFirst = format === 'account';

  const accountPath = async (): Promise<TokenVerifyResult> => {
    if (opts.accountId) {
      try {
        return await verifyAccountToken(client, opts.accountId);
      } catch (err) {
        if (!isTokenRejected(err)) throw err;
      }
    }
    return verifyViaAccountList(client);
  };

  if (accountFirst) return accountPath();

  try {
    return await verifyUserToken(client);
  } catch (err) {
    if (format === 'user' || !isTokenRejected(err)) throw err;
    try {
      return await accountPath();
    } catch {
      throw err;
    }
  }
}
