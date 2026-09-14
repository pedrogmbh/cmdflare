/** List/search helpers for interactive pickers (zones, accounts, DNS records) and bulk workflows (Stream). */
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

/** Stream's list endpoint caps `limit` at 1000 and has no page cursor — see listStreamVideos. */
export const STREAM_PAGE_SIZE = 1000;

export interface StreamVideoQuery extends CatalogQuery {
  accountId: string;
  /** Pass-through list filters (creator, search, status, type, start, end, …). */
  filters?: Record<string, unknown>;
  pageSize?: number;
  /** Called when a page is skipped because every video in it was already seen. */
  onStall?: (cursor: string) => void;
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

/**
 * Yields every Stream video of an account, one batch per request.
 *
 * Stream's list endpoint is modelled as `SinglePage` in the SDK (`nextPageRequestOptions()` is always
 * null), so `--all`/`collectPaginatedItems` cannot page it. Instead we sort ascending and use the
 * `created` timestamp of the last video as the `start` of the next request. `start` is inclusive, so
 * the boundary video repeats and is filtered out by uid.
 */
export async function* listStreamVideos(client: any, opts: StreamVideoQuery): AsyncGenerator<any[]> {
  const mod = await sdkModules['resources/stream/stream']!();
  const stream = new mod.Stream(client);
  const pageSize = opts.pageSize && opts.pageSize > 0 ? Math.min(opts.pageSize, STREAM_PAGE_SIZE) : STREAM_PAGE_SIZE;
  const maxItems = opts.maxItems != null && opts.maxItems > 0 ? opts.maxItems : Number.POSITIVE_INFINITY;
  const seen = new Set<string>();
  let cursor: string | undefined = typeof opts.filters?.start === 'string' ? (opts.filters.start as string) : undefined;

  while (seen.size < maxItems) {
    const query: Record<string, unknown> = { account_id: opts.accountId, asc: true, limit: pageSize, ...opts.filters };
    if (cursor) query.start = cursor;
    const page: any = await stream.list(query, reqOpts(opts.signal));
    const batch: any[] = typeof page?.getPaginatedItems === 'function' ? page.getPaginatedItems() : (page?.result ?? []);
    if (batch.length === 0) return;

    const fresh: any[] = [];
    for (const video of batch) {
      const uid = String(video?.uid ?? '');
      if (!uid || seen.has(uid)) continue;
      seen.add(uid);
      fresh.push(video);
      if (seen.size >= maxItems) break;
    }
    if (fresh.length) yield fresh;

    if (batch.length < pageSize) return; // short page: that was the last one
    const last = batch[batch.length - 1];
    const next = last?.created ?? last?.uploaded;
    if (!next || typeof next !== 'string') return;
    if (fresh.length === 0) {
      // Every video in this page was already seen: more than `pageSize` videos share one timestamp,
      // and advancing the cursor would loop forever. Stop rather than spin.
      opts.onStall?.(next);
      return;
    }
    cursor = next;
  }
}
