/** Resolves human-friendly zone/account names to ids (with a small on-disk cache). */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sdkModules } from '../generated/modules';
import { cacheDir, ID_RE } from './config';
import { CliError, EXIT } from './errors';
import { log, withSpinner } from './ui';

interface NameCache {
  zones: Record<string, { id: string; ts: number; account?: string }>;
  accounts: Record<string, { id: string; ts: number }>;
}
const TTL_MS = 24 * 60 * 60 * 1000;

function cachePath() {
  return join(cacheDir(), 'names.json');
}
function loadCache(): NameCache {
  try {
    if (existsSync(cachePath())) {
      const raw = JSON.parse(readFileSync(cachePath(), 'utf8'));
      return { zones: raw.zones ?? {}, accounts: raw.accounts ?? {} };
    }
  } catch {
    /* ignore corrupt cache */
  }
  return { zones: {}, accounts: {} };
}
function saveCache(c: NameCache) {
  try {
    mkdirSync(cacheDir(), { recursive: true, mode: 0o700 });
    writeFileSync(cachePath(), JSON.stringify(c), { mode: 0o600 });
  } catch {
    /* cache is best effort */
  }
}

export async function resolveZoneId(getClient: () => Promise<any>, ref: string): Promise<string> {
  if (ID_RE.test(ref)) return ref;
  const name = ref.toLowerCase().replace(/\.$/, '');
  const cache = loadCache();
  const hit = cache.zones[name];
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.id;
  const client = await getClient();
  const mod = await sdkModules['resources/zones/zones']!();
  const zones = new mod.Zones(client);
  const page = await withSpinner<any>(`Resolving zone "${ref}"…`, () => zones.list({ name, per_page: 50 }));
  const items: any[] = page.getPaginatedItems();
  const exact = items.filter((z) => String(z.name).toLowerCase() === name);
  if (exact.length === 0) {
    throw new CliError(`No zone named "${ref}" found in the accounts this token can access.`, {
      exitCode: EXIT.NOT_FOUND,
      hint: 'Pass a 32-character zone id instead, or run `cmdflare zones list` to see available zones.',
    });
  }
  if (exact.length > 1) log.warn(`Multiple zones named "${ref}"; using ${exact[0].id} (account ${exact[0].account?.name ?? exact[0].account?.id ?? '?'}).`);
  const id = String(exact[0].id);
  cache.zones[name] = { id, ts: Date.now(), account: exact[0].account?.id };
  saveCache(cache);
  return id;
}

export async function resolveAccountId(getClient: () => Promise<any>, ref: string): Promise<string> {
  if (ID_RE.test(ref)) return ref;
  const key = ref.toLowerCase();
  const cache = loadCache();
  const hit = cache.accounts[key];
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.id;
  const client = await getClient();
  const mod = await sdkModules['resources/accounts/accounts']!();
  const accounts = new mod.Accounts(client);
  const page = await withSpinner<any>(`Resolving account "${ref}"…`, () => accounts.list({ name: ref, per_page: 50 }));
  const items: any[] = page.getPaginatedItems();
  let match = items.filter((a) => String(a.name).toLowerCase() === key);
  if (match.length === 0) match = items.filter((a) => String(a.name).toLowerCase().includes(key));
  if (match.length === 0) {
    throw new CliError(`No account named "${ref}" found.`, {
      exitCode: EXIT.NOT_FOUND,
      hint: 'Pass the 32-character account id, or run `cmdflare accounts list` to see available accounts.',
    });
  }
  if (match.length > 1) log.warn(`Multiple accounts match "${ref}"; using "${match[0].name}" (${match[0].id}).`);
  const id = String(match[0].id);
  cache.accounts[key] = { id, ts: Date.now() };
  saveCache(cache);
  return id;
}

export function clearNameCache() {
  saveCache({ zones: {}, accounts: {} });
}
