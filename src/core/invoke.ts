/** Calls an SDK method with prepared arguments, handling pagination and response modes. */
import { instantiateResource } from './client';
import { CliError } from './errors';
import type { MethodNode, ResourceNode } from './manifest-types';

export interface InvokeOptions {
  positionals: any[];
  params?: Record<string, any>;
  /** Auto-paginate through every page. */
  all?: boolean;
  /** Stop after N items (applies with or without --all). */
  limit?: number;
  /** Return the raw API envelope instead of the unwrapped result. */
  rawResponse?: boolean;
  /** Called for each item as pages stream in (used for ndjson streaming). */
  onItem?: (item: any) => void;
}

export interface InvokeResult {
  data: any;
  meta?: { result_info?: any; hasMore?: boolean; count?: number; pages?: number };
  response?: Response;
  binary?: boolean;
}

export async function invokeMethod(client: any, node: ResourceNode, method: MethodNode, opts: InvokeOptions): Promise<InvokeResult> {
  const resource = await instantiateResource(client, node);
  const fn = resource[method.name];
  if (typeof fn !== 'function') throw new CliError(`SDK method ${node.className}.${method.name} not found.`);

  const args: any[] = [...opts.positionals];
  if (method.params) {
    const hasParams = opts.params && Object.keys(opts.params).length > 0;
    if (hasParams) args.push(opts.params);
    else if (method.params.required) args.push({});
    else args.push(undefined);
  }

  const promise = fn.apply(resource, args);

  if (method.binary) {
    const res: Response = await promise;
    return { data: res, response: res, binary: true };
  }

  if (opts.rawResponse) {
    const res: Response = await promise.asResponse();
    const text = await res.text();
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* leave as text */
    }
    return { data, response: res };
  }

  if (method.paginated) {
    const limit = opts.limit && opts.limit > 0 ? opts.limit : undefined;
    if (opts.all) {
      const items: any[] = [];
      let pages = 0;
      const first = await promise;
      let page: any = first;
      outer: while (page) {
        pages++;
        for (const it of page.getPaginatedItems()) {
          items.push(it);
          opts.onItem?.(it);
          if (limit && items.length >= limit) break outer;
        }
        if (!page.hasNextPage()) break;
        page = await page.getNextPage();
      }
      return { data: items, meta: { count: items.length, pages, hasMore: limit ? page?.hasNextPage?.() : false } };
    }
    const page = await promise;
    let items: any[] = page.getPaginatedItems();
    let hasMore = false;
    try {
      hasMore = page.hasNextPage();
    } catch {
      hasMore = false;
    }
    if (limit && items.length > limit) {
      items = items.slice(0, limit);
      hasMore = true;
    }
    for (const it of items) opts.onItem?.(it);
    return { data: items, meta: { result_info: page.result_info, hasMore, count: items.length, pages: 1 } };
  }

  const data = await promise;
  return { data };
}
