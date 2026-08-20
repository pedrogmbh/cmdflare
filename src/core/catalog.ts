/** List/search helpers for interactive pickers (zones, accounts, DNS records). */
import { sdkModules } from '../generated/modules';
import { collectPaginatedItems, type CollectPagesResult } from './invoke';

/** Cloudflare list endpoints cap `per_page` at 50 for zones/accounts. */
export const CATALOG_PAGE_SIZE = 50;
/** Prefetch this many items in pickers; beyond that, search hits the API. */
export const PICKER_PREFETCH_MAX = 250;

const ZONE_NAME_OPS = /^(equal|not_equal|starts_with|ends_with|contains|starts_with_case_sensitive|ends_with_case_sensitive|contains_case_sensitive):/i;

export interface CatalogQuery {
  maxItems?: number;
  signal?: AbortSignal;
}

export interface ZoneQuery extends CatalogQuery {
  /** Substring or operator-prefixed zone name (`contains:foo`). */
  name?: string;
  accountId?: string;
}

export interface AccountQuery extends CatalogQuery {
  name?: string;
}

export interface DnsRecordQuery extends CatalogQuery {
  zoneId: string;
  search?: string;
}

export function zoneNameQuery(term: string): string {
  const t = term.trim();
  if (!t) return t;
  if (ZONE_NAME_OPS.test(t)) return t;
  return `contains:${t}`;
}

export function itemMatches(item: { name?: unknown; id?: unknown; content?: unknown; type?: unknown }, term: string): boolean {
  const t = term.trim().toLowerCase();
  if (!t) return true;
  const hay = [item.name, item.id, item.content, item.type].filter((v) => v != null).map((v) => String(v).toLowerCase());
  return hay.some((s) => s.includes(t));
}

export function mergeById<T extends { id?: unknown }>(...lists: T[][]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const list of lists) {
    for (const it of list) {
      const id = it.id == null ? '' : String(it.id);
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      out.push(it);
    }
  }
  return out;
}

function reqOpts(signal?: AbortSignal): { signal: AbortSignal } | undefined {
  return signal ? { signal } : undefined;
}

export async function listZones(client: any, opts: ZoneQuery = {}): Promise<CollectPagesResult> {
  const mod = await sdkModules['resources/zones/zones']!();
  const query: Record<string, unknown> = { per_page: CATALOG_PAGE_SIZE, order: 'name' };
  if (opts.name) query.name = opts.name;
  if (opts.accountId) query.account = { id: opts.accountId };
  const page = await new mod.Zones(client).list(query, reqOpts(opts.signal));
  return collectPaginatedItems(page, { maxItems: opts.maxItems });
}

export async function listAccounts(client: any, opts: AccountQuery = {}): Promise<CollectPagesResult> {
  const mod = await sdkModules['resources/accounts/accounts']!();
  const query: Record<string, unknown> = { per_page: CATALOG_PAGE_SIZE };
  if (opts.name) query.name = opts.name;
  const page = await new mod.Accounts(client).list(query, reqOpts(opts.signal));
  return collectPaginatedItems(page, { maxItems: opts.maxItems });
}

export async function listDnsRecords(client: any, opts: DnsRecordQuery): Promise<CollectPagesResult> {
  const mod = await sdkModules['resources/dns/records']!();
  const query: Record<string, unknown> = { zone_id: opts.zoneId, per_page: CATALOG_PAGE_SIZE };
  if (opts.search) query.search = opts.search;
  const page = await new mod.Records(client).list(query, reqOpts(opts.signal));
  return collectPaginatedItems(page, { maxItems: opts.maxItems });
}
