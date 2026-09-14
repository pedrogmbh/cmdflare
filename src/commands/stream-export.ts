/**
 * `cmdflare stream export <dir>` — download an account's whole Stream library plus a CSV manifest.
 *
 * Declared in `src/core/composites.ts` (flags, help text) and dispatched by `runComposite` in
 * `src/cli.ts` (or by interactive mode), so it gets the same flag parsing, account resolution and
 * output plumbing as a generated command.
 */
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { resolvePath } from '../core/paths';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { CompositeInput } from '../core/composites';
import { sdkModules } from '../generated/modules';
import { createTarGz } from '../core/archive';
import { CliError, EXIT, formatError } from '../core/errors';
import { listStreamVideos } from '../core/catalog';
import { delimitedRow, formatOutput, parseDelimited } from '../core/output';
import { decideFormat } from '../core/runtime';
import { canPrompt, createProgress, log, withSpinner } from '../core/ui';

// ---------------------------------------------------------------------------
// CSV manifest
// ---------------------------------------------------------------------------

export const CSV_COLUMNS = [
  'id',
  'title',
  'name',
  'description',
  'creator',
  'created',
  'uploaded',
  'modified',
  'ready_to_stream_at',
  'scheduled_deletion',
  'status_state',
  'ready_to_stream',
  'duration_seconds',
  'size_bytes',
  'width',
  'height',
  'require_signed_urls',
  'allowed_origins',
  'flags',
  'preview_url',
  'share_link',
  'channel_link',
  'playback_hls',
  'playback_dash',
  'thumbnail_url',
  'live_input',
  'clipped_from',
  'watermark_name',
  'caption_languages',
  'caption_labels',
  'caption_files',
  'meta_json',
  'file',
  'file_bytes',
  'export_status',
  'error',
] as const;

export interface Caption {
  language?: string;
  label?: string;
  generated?: boolean;
  status?: string;
}

export interface RowExtras {
  /** Path of the video file, relative to the CSV. */
  file?: string;
  fileBytes?: number;
  captions?: Caption[];
  /** Caption file paths, relative to the CSV. */
  captionFiles?: string[];
  status: 'exported' | 'skipped' | 'not-ready' | 'metadata-only' | 'failed' | 'planned';
  error?: string;
}

function metaOf(video: any): Record<string, any> {
  const meta = video?.meta;
  return meta && typeof meta === 'object' && !Array.isArray(meta) ? (meta as Record<string, any>) : {};
}

/** Human-facing title: the curated public title, else the conventional `meta.name`. */
export function titleOf(video: any): string {
  const meta = metaOf(video);
  return String(video?.publicDetails?.title ?? meta.name ?? '');
}

function flagsOf(video: any, captions: Caption[] | undefined): string {
  const flags: string[] = [];
  if (video?.requireSignedURLs) flags.push('signed_urls');
  if (video?.readyToStream) flags.push('ready');
  if (video?.liveInput) flags.push('from_live_input');
  if (video?.clippedFrom) flags.push('clip');
  if (video?.watermark) flags.push('watermarked');
  if (video?.scheduledDeletion) flags.push('scheduled_deletion');
  if (captions?.length) flags.push('has_captions');
  if (captions?.some((x) => x.generated)) flags.push('ai_captions');
  return flags.join(';');
}

/** Builds one CSV row (values in CSV_COLUMNS order) for a video. */
export function videoRow(video: any, extras: RowExtras): any[] {
  const meta = metaOf(video);
  const captions = extras.captions;
  const values: Record<(typeof CSV_COLUMNS)[number], any> = {
    id: video?.uid ?? '',
    title: titleOf(video),
    name: meta.name ?? '',
    description: meta.description ?? '',
    creator: video?.creator ?? '',
    created: video?.created ?? '',
    uploaded: video?.uploaded ?? '',
    modified: video?.modified ?? '',
    ready_to_stream_at: video?.readyToStreamAt ?? '',
    scheduled_deletion: video?.scheduledDeletion ?? '',
    status_state: video?.status?.state ?? '',
    ready_to_stream: video?.readyToStream ?? false,
    duration_seconds: video?.duration ?? '',
    size_bytes: video?.size ?? '',
    width: video?.input?.width ?? '',
    height: video?.input?.height ?? '',
    require_signed_urls: video?.requireSignedURLs ?? false,
    allowed_origins: Array.isArray(video?.allowedOrigins) ? video.allowedOrigins.join(';') : '',
    flags: flagsOf(video, captions),
    preview_url: video?.preview ?? '',
    share_link: video?.publicDetails?.share_link ?? '',
    channel_link: video?.publicDetails?.channel_link ?? '',
    playback_hls: video?.playback?.hls ?? '',
    playback_dash: video?.playback?.dash ?? '',
    thumbnail_url: video?.thumbnail ?? '',
    live_input: video?.liveInput ?? '',
    clipped_from: video?.clippedFrom ?? '',
    watermark_name: video?.watermark?.name ?? '',
    caption_languages: (captions ?? []).map((x) => x.language ?? '').filter(Boolean).join(';'),
    caption_labels: (captions ?? []).map((x) => x.label ?? '').filter(Boolean).join(';'),
    caption_files: (extras.captionFiles ?? []).join(';'),
    meta_json: Object.keys(meta).length ? JSON.stringify(meta) : '',
    file: extras.file ?? '',
    file_bytes: extras.fileBytes ?? '',
    export_status: extras.status,
    error: extras.error ?? '',
  };
  return CSV_COLUMNS.map((col) => values[col]);
}

// ---------------------------------------------------------------------------
// Download helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface DownloadState {
  status: 'ready' | 'inprogress' | 'error';
  percentComplete?: number;
  url?: string;
}

function defaultDownload(res: any): DownloadState | undefined {
  const d = res?.default;
  return d && typeof d === 'object' ? (d as DownloadState) : undefined;
}

/**
 * Asks Cloudflare to render an MP4 for a video, without waiting for it.
 *
 * Reuses an existing render when there is one (a cheap GET), so re-runs never create a second.
 * Kicking every render off before downloading any is what keeps a large export fast: renders then
 * happen concurrently on Cloudflare's side instead of in batches of `--concurrency`.
 */
async function requestDownload(downloads: any, uid: string, accountId: string): Promise<DownloadState | undefined> {
  try {
    const existing = defaultDownload(await downloads.get(uid, { account_id: accountId }));
    if (existing) return existing;
  } catch {
    // 404 simply means no download has been created yet.
  }
  return defaultDownload(await downloads.create(uid, { account_id: accountId }));
}

/**
 * Polls until a requested MP4 has finished rendering, then returns its URL.
 *
 * `initial` is the state observed when the render was requested. It is only trusted for the
 * "already finished" fast path: it is usually stale by the time a worker gets here (renders were
 * requested for the whole library up front), so anything else is re-checked immediately rather than
 * after a sleep. Sleeps only ever happen *between* checks.
 */
async function waitForDownload(
  downloads: any,
  uid: string,
  accountId: string,
  initial: DownloadState | undefined,
  opts: { timeoutMs: number; onProgress?: (pct: number) => void },
): Promise<string> {
  const deadline = Date.now() + opts.timeoutMs;
  let state = initial;
  let checked = false;
  let wait = 1000;
  for (;;) {
    if (state?.status === 'ready') break;
    if (state?.status === 'error') throw new CliError('Cloudflare could not generate an MP4 for this video.');
    if (Date.now() >= deadline) {
      throw new CliError(`Timed out after ${Math.round(opts.timeoutMs / 1000)}s waiting for the MP4 to render (${state?.percentComplete ?? 0}% done). Re-run to resume, or raise --poll-timeout.`);
    }
    if (checked) {
      await sleep(wait);
      wait = Math.min(5000, Math.round(wait * 1.5));
    }
    if (state) opts.onProgress?.(Number(state.percentComplete ?? 0));
    state = defaultDownload(await downloads.get(uid, { account_id: accountId })) ?? (await requestDownload(downloads, uid, accountId));
    checked = true;
  }
  if (!state.url) throw new CliError('Cloudflare reported the download as ready but returned no URL.');
  return state.url;
}

/** Runs `worker` over `items` with at most `limit` in flight, preserving nothing but order of start. */
async function pooled<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  if (items.length === 0) return;
  let next = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: size }, async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        await worker(items[index]!, index);
      }
    }),
  );
}

/** Signed-URL videos need a token in place of the uid in the delivery path. */
function withToken(url: string, token: string): string {
  const u = new URL(url);
  const parts = u.pathname.split('/');
  if (parts.length > 1) parts[1] = token;
  u.pathname = parts.join('/');
  return u.toString();
}

/** Streams a URL to disk through a .part file so an interrupted run never leaves a truncated video. */
async function fetchToFile(url: string, dest: string): Promise<number> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new CliError(`Download failed: HTTP ${res.status} ${res.statusText}`.trim(), { exitCode: EXIT.ERROR });
  }
  const part = dest + '.part';
  try {
    await pipeline(Readable.fromWeb(res.body as any), createWriteStream(part));
    renameSync(part, dest);
  } catch (err) {
    rmSync(part, { force: true });
    throw err;
  }
  return statSync(dest).size;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

interface Options {
  dir: string;
  csv: string;
  accountId: string;
  compress: boolean;
  archive: string;
  concurrency: number;
  requestConcurrency: number;
  metadataOnly: boolean;
  captions: boolean;
  overwrite: boolean;
  pollTimeoutMs: number;
  ignoreErrors: boolean;
  retryFailed: boolean;
  filters: Record<string, unknown>;
  maxItems?: number;
}

const FILTER_KEYS = ['creator', 'search', 'video_name', 'status', 'type', 'start', 'end'] as const;

function readOptions(input: CompositeInput): Options {
  const { params, positionals, gf } = input;
  const dirArg = String(positionals[0] ?? '').trim();
  if (!dirArg) throw new CliError('A destination directory is required: cmdflare stream export <dir>', { exitCode: EXIT.USAGE });
  const dir = resolvePath(dirArg);
  const filters: Record<string, unknown> = {};
  for (const key of FILTER_KEYS) if (params[key] !== undefined) filters[key] = params[key];
  const concurrency = Math.max(1, Math.min(32, Number(params.concurrency ?? 4)));
  const requestConcurrency = Math.max(1, Math.min(64, Number(params.request_concurrency ?? 16)));
  const limit = typeof gf.limit === 'number' && gf.limit > 0 ? gf.limit : undefined;
  return {
    dir,
    csv: params.csv ? resolvePath(String(params.csv)) : join(dir, 'videos.csv'),
    accountId: String(params.account_id),
    compress: !!params.compress,
    archive: params.archive ? resolvePath(String(params.archive)) : dir + '.tar.gz',
    concurrency,
    requestConcurrency,
    metadataOnly: !!params.metadata_only,
    captions: params.captions !== false,
    overwrite: !!params.overwrite,
    pollTimeoutMs: Math.max(1, Number(params.poll_timeout ?? 600)) * 1000,
    ignoreErrors: !!params.ignore_errors,
    retryFailed: !!params.retry_failed,
    filters,
    maxItems: limit,
  };
}

interface ExistingManifest {
  header: string[];
  /** Rows in their original order, as parsed cells. */
  rows: string[][];
  /** Row index by video id. */
  indexById: Map<string, number>;
  failedIds: string[];
}

/** Reads a manifest written by a previous run and finds the videos whose export failed. */
function readManifest(csv: string): ExistingManifest {
  if (!existsSync(csv)) {
    throw new CliError(`--retry-failed needs the manifest from a previous run, but ${csv} does not exist.`, {
      exitCode: EXIT.USAGE,
      hint: 'Run the export once first, or point --csv at the manifest of the run you want to retry.',
    });
  }
  const { header, rows } = parseDelimited(readFileSync(csv, 'utf8'));
  const idCol = header.indexOf('id');
  const statusCol = header.indexOf('export_status');
  if (idCol === -1 || statusCol === -1) {
    throw new CliError(`${csv} does not look like a cmdflare export manifest (no "id"/"export_status" columns).`, { exitCode: EXIT.USAGE });
  }
  const indexById = new Map<string, number>();
  const failedIds: string[] = [];
  rows.forEach((row, i) => {
    const id = row[idCol] ?? '';
    if (!id) return;
    indexById.set(id, i);
    if (row[statusCol] === 'failed') failedIds.push(id);
  });
  return { header, rows, indexById, failedIds };
}

/** Path of `file` as written into the CSV: relative to the CSV, with forward slashes. */
function relPath(csv: string, file: string): string {
  const rel = relative(dirname(csv), file);
  return (rel || basename(file)).split(/[\\/]/).join('/');
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function run(input: CompositeInput): Promise<number> {
  const started = Date.now();
  const opts = readOptions(input);
  const { gf, dryRun, getRealClient } = input;
  const client = await getRealClient();

  // (listStreamVideos loads the Stream resource itself.)
  const [downloadsMod, captionsMod, vttMod, tokenMod] = await Promise.all([
    sdkModules['resources/stream/downloads']!(),
    sdkModules['resources/stream/captions/captions']!(),
    sdkModules['resources/stream/captions/language/vtt']!(),
    sdkModules['resources/stream/token']!(),
  ]);
  const downloads = new downloadsMod.Downloads(client);
  const captionsApi = new captionsMod.Captions(client);
  const vttApi = new vttMod.Vtt(client);
  const tokenApi = new tokenMod.Token(client);

  // 1. Decide which videos this run covers: the whole library, or just the failures of a previous one.
  const videos: any[] = [];
  let manifest: ExistingManifest | undefined;

  if (opts.retryFailed) {
    manifest = readManifest(opts.csv);
    if (Object.keys(opts.filters).length) {
      log.warn(`--retry-failed takes its videos from ${opts.csv}; list filters are ignored.`);
    }
    let ids = manifest.failedIds;
    if (opts.maxItems && ids.length > opts.maxItems) ids = ids.slice(0, opts.maxItems);
    if (ids.length === 0) {
      log.success(`No failed videos in ${opts.csv}; nothing to retry.`);
      process.stdout.write(
        formatOutput(
          { account_id: opts.accountId, dir: opts.dir, csv: opts.csv, archive: null, retried: 0, total: 0, exported: 0, skipped: 0, failed: 0, bytes: 0, duration_ms: Date.now() - started, failures: [] },
          { format: decideFormat(gf), compact: gf.compact },
        ) + '\n',
      );
      return EXIT.OK;
    }
    const streamMod = await sdkModules['resources/stream/stream']!();
    const streamApi = new streamMod.Stream(client);
    const fetched = new Array<any>(ids.length);
    await withSpinner(`Re-reading ${ids.length} failed video${ids.length === 1 ? '' : 's'}…`, () =>
      pooled(ids, opts.requestConcurrency, async (id, i) => {
        try {
          fetched[i] = await streamApi.get(id, { account_id: opts.accountId });
        } catch (err) {
          // The video may have been deleted since the failed run; keep the id so the row still updates.
          fetched[i] = { uid: id, __fetchError: formatError(err).message };
        }
      }),
    );
    videos.push(...fetched);
    log.info(`Retrying ${videos.length} failed video${videos.length === 1 ? '' : 's'} from ${opts.csv}.`);
  } else {
    await withSpinner('Listing Stream videos…', async () => {
      for await (const batch of listStreamVideos(client, {
        accountId: opts.accountId,
        filters: opts.filters,
        maxItems: opts.maxItems,
        onStall: (cursor) =>
          log.warn(`More than one page of videos shares the timestamp ${cursor}; stopping there. Narrow the range with --start/--end to get the rest.`),
      })) {
        videos.push(...batch);
        if (videos.length % 1000 === 0) log.debug(`listed ${videos.length} videos…`);
      }
    });
  }

  if (!opts.retryFailed) {
    if (videos.length === 0) log.warn('No Stream videos matched.');
    log.info(`${videos.length} video${videos.length === 1 ? '' : 's'} to export${opts.metadataOnly ? ' (metadata only)' : ''}.`);
  }

  // 2. Dry run: report the plan, touch nothing.
  if (dryRun) {
    const planned = videos.map((v) => ({
      id: v.uid,
      title: titleOf(v),
      status: v.status?.state ?? '',
      file: v.readyToStream && !opts.metadataOnly ? relPath(opts.csv, join(opts.dir, `${v.uid}.mp4`)) : null,
    }));
    const summary = {
      dry_run: true,
      ...(opts.retryFailed ? { retry_failed: true } : {}),
      account_id: opts.accountId,
      dir: opts.dir,
      csv: opts.csv,
      archive: opts.compress ? opts.archive : null,
      total: videos.length,
      downloadable: planned.filter((p) => p.file).length,
      videos: planned,
    };
    process.stdout.write(formatOutput(summary, { format: decideFormat(gf) }) + '\n');
    return EXIT.OK;
  }

  // 3. Confirm, since creating MP4s adds Stream storage to the account.
  const willDownload = !opts.metadataOnly && videos.some((v) => v.readyToStream);
  if (willDownload && !gf.yes) {
    log.warn(`Exporting creates an MP4 download for each video and keeps it on your account (Stream storage is billed).`);
    log.hint(`Delete them later with \`cmdflare stream downloads delete <id>\`, or run with --metadata-only to skip video files.`);
    if (canPrompt()) {
      const { confirm } = await import('@inquirer/prompts');
      const ok = await confirm({ message: `Export ${videos.length} video${videos.length === 1 ? '' : 's'} to ${opts.dir}?`, default: true }, { output: process.stderr, input: process.stdin });
      if (!ok) {
        log.info('Aborted.');
        return EXIT.CANCELLED;
      }
    }
  }

  mkdirSync(opts.dir, { recursive: true });
  mkdirSync(dirname(opts.csv), { recursive: true });
  const header = CSV_COLUMNS.join(',');
  // A retry updates rows in place, so the manifest is rewritten once at the end instead of being
  // truncated and appended to (which would drop every row that is not being retried).
  if (!opts.retryFailed) writeFileSync(opts.csv, header + '\n');

  const rows: string[] = new Array(videos.length);
  const failures: Array<{ id: string; error: string }> = [];
  let exported = 0;
  let skipped = 0;
  let bytes = 0;

  /** Per-video plan, decided up front so the render requests can all go out before any download. */
  interface Job {
    video: any;
    index: number;
    uid: string;
    dest: string;
    /** Whether this video still needs its bytes fetched. */
    download: boolean;
    state?: DownloadState;
    extras: RowExtras;
  }

  const jobs: Job[] = videos.map((video, index) => {
    const uid = String(video?.uid ?? '');
    const dest = join(opts.dir, `${uid}.mp4`);
    const job: Job = { video, index, uid, dest, download: false, extras: { status: 'skipped' } };
    if (video?.__fetchError) {
      job.extras.status = 'failed';
      job.extras.error = video.__fetchError;
      failures.push({ id: uid, error: job.extras.error! });
    } else if (opts.metadataOnly) {
      job.extras.status = 'metadata-only';
    } else if (!video?.readyToStream) {
      job.extras.status = 'not-ready';
      job.extras.error = `video is ${video?.status?.state ?? 'not ready'}; nothing to download yet`;
    } else if (!opts.overwrite && existsSync(dest) && statSync(dest).size > 0) {
      job.extras.status = 'skipped';
      job.extras.file = relPath(opts.csv, dest);
      job.extras.fileBytes = statSync(dest).size;
      skipped++;
    } else {
      job.download = true;
    }
    return job;
  });

  const fail = (job: Job, err: unknown) => {
    job.extras.status = 'failed';
    job.extras.error = formatError(err).message;
    failures.push({ id: job.uid, error: job.extras.error });
  };

  // 4. Ask Cloudflare to render every MP4 first. These are small, fast calls, so they run at a
  //    higher concurrency than the downloads — and the renders then proceed in parallel server-side
  //    instead of a few at a time.
  const pending = jobs.filter((j) => j.download);
  if (pending.length) {
    const reqProgress = createProgress(pending.length, 'MP4 renders requested');
    await pooled(pending, opts.requestConcurrency, async (job) => {
      try {
        job.state = await requestDownload(downloads, job.uid, opts.accountId);
      } catch (err) {
        fail(job, err);
        job.download = false;
      }
      reqProgress.tick(job.uid);
    });
    reqProgress.done();
    const rendering = pending.filter((j) => j.download && j.state?.status === 'inprogress').length;
    if (rendering) log.info(`${rendering} MP4${rendering === 1 ? '' : 's'} still rendering; downloading each as it becomes ready.`);
  }

  // 5. Captions + bytes. Most renders are already finished by the time a worker reaches them.
  const progress = createProgress(jobs.length, 'videos');
  await pooled(jobs, opts.concurrency, async (job) => {
    const { video, uid, extras } = job;
    if (video?.__fetchError) {
      const row = delimitedRow(videoRow(video, extras));
      rows[job.index] = row;
      if (!opts.retryFailed) appendFileSync(opts.csv, row + '\n');
      progress.tick(uid);
      return;
    }
    try {
      // Captions: metadata for the CSV, plus the .vtt tracks themselves.
      if (opts.captions && uid) {
        const page: any = await captionsApi.get(uid, { account_id: opts.accountId });
        const list: Caption[] = typeof page?.getPaginatedItems === 'function' ? page.getPaginatedItems() : (page?.result ?? page ?? []);
        extras.captions = list;
        const files: string[] = [];
        for (const caption of list) {
          const lang = caption.language;
          if (!lang || caption.status === 'inprogress') continue;
          const dest = join(opts.dir, `${uid}.${lang}.vtt`);
          if (!opts.overwrite && existsSync(dest) && statSync(dest).size > 0) {
            files.push(relPath(opts.csv, dest));
            continue;
          }
          const vtt: string = await vttApi.get(lang, { account_id: opts.accountId, identifier: uid });
          writeFileSync(dest, vtt);
          files.push(relPath(opts.csv, dest));
        }
        extras.captionFiles = files;
      }

      if (job.download) {
        let url = await waitForDownload(downloads, uid, opts.accountId, job.state, {
          timeoutMs: opts.pollTimeoutMs,
          onProgress: (pct: number) => progress.update(`${uid} rendering ${pct}%`),
        });
        if (video.requireSignedURLs) {
          const { token } = await tokenApi.create(uid, { account_id: opts.accountId, downloadable: true });
          if (token) url = withToken(url, token);
        }
        progress.update(`${uid} downloading`);
        const size = await fetchToFile(url, job.dest);
        extras.status = 'exported';
        extras.file = relPath(opts.csv, job.dest);
        extras.fileBytes = size;
        bytes += size;
        exported++;
      }
    } catch (err) {
      fail(job, err);
    }
    const row = delimitedRow(videoRow(video, extras));
    rows[job.index] = row;
    // Append as we go: a long export stays inspectable and crash-safe. (Not in retry mode, where the
    // file already holds the other rows and is rewritten once at the end.)
    if (!opts.retryFailed) appendFileSync(opts.csv, row + '\n');
    progress.tick(uid);
  });
  progress.done();

  if (manifest) {
    // Replace just the retried rows, keeping every other row (and its position) untouched.
    const updated = manifest.rows.map((cells) => delimitedRow(cells));
    jobs.forEach((job) => {
      const at = manifest!.indexById.get(job.uid);
      const row = rows[job.index];
      if (row === undefined) return;
      if (at === undefined) updated.push(row);
      else updated[at] = row;
    });
    writeFileSync(opts.csv, [header, ...updated].join('\n') + '\n');
  } else {
    // Rewrite in listing order (rows were appended in completion order).
    writeFileSync(opts.csv, [header, ...rows.filter(Boolean)].join('\n') + '\n');
  }

  // 5. Optional archive.
  let archive: string | null = null;
  if (opts.compress) {
    const result = await withSpinner(`Compressing ${basename(opts.dir)}…`, () => createTarGz(opts.dir, opts.archive));
    archive = result.path;
    log.success(`Wrote ${archive} (${result.files} files)`);
  }

  const summary = {
    account_id: opts.accountId,
    dir: opts.dir,
    csv: opts.csv,
    archive,
    ...(opts.retryFailed ? { retried: videos.length } : {}),
    total: videos.length,
    exported,
    skipped,
    failed: failures.length,
    bytes,
    duration_ms: Date.now() - started,
    failures,
  };
  process.stdout.write(formatOutput(summary, { format: decideFormat(gf), compact: gf.compact }) + '\n');

  if (failures.length) {
    log.error(`${failures.length} video${failures.length === 1 ? '' : 's'} failed; see the "error" column in ${opts.csv}.`);
    if (!opts.ignoreErrors) return EXIT.ERROR;
  } else {
    log.success(`Exported ${exported} video${exported === 1 ? '' : 's'}${skipped ? `, skipped ${skipped} already present` : ''} to ${opts.dir}`);
    log.hint(`Manifest: ${opts.csv}${archive ? ` · Archive: ${archive}` : ''}`);
  }
  return EXIT.OK;
}
