import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTarGz } from '../src/core/archive';
import { listStreamVideos } from '../src/core/catalog';
import { createClient } from '../src/core/client';
import type { Context } from '../src/core/config';
import { delimitedRow, parseDelimited } from '../src/core/output';
import { CSV_COLUMNS, titleOf, videoRow } from '../src/commands/stream-export';
import { ok, runCli, startFakeApi } from './helpers';

const ACCOUNT = 'a'.repeat(32);
const tmpRoot = mkdtempSync(join(tmpdir(), 'cmdflare-stream-'));
const tmpDir = (name: string) => {
  const d = join(tmpRoot, `${name}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(d, { recursive: true });
  return d;
};

const col = (row: any[], name: (typeof CSV_COLUMNS)[number]) => row[CSV_COLUMNS.indexOf(name)];

// ---------------------------------------------------------------------------

describe('CSV rows', () => {
  const video = {
    uid: 'v1',
    creator: 'creator-1',
    created: '2026-01-02T03:04:05Z',
    uploaded: '2026-01-02T03:00:00Z',
    duration: 12.5,
    size: 4096,
    input: { width: 1920, height: 1080 },
    playback: { hls: 'https://cf/v1/manifest/video.m3u8', dash: 'https://cf/v1/manifest/video.mpd' },
    preview: 'https://cf/v1/watch',
    thumbnail: 'https://cf/v1/thumbnails/thumbnail.jpg',
    readyToStream: true,
    requireSignedURLs: false,
    status: { state: 'ready' },
    allowedOrigins: ['example.com', 'example.org'],
    meta: { name: 'My song.mp4', description: 'A description', lyrics: 'la, la\nla' },
    publicDetails: { title: 'Public title', share_link: 'https://cf/share' },
  };

  test('maps every documented field', () => {
    const row = videoRow(video, { status: 'exported', file: 'v1.mp4', fileBytes: 4096, captions: [{ language: 'en', label: 'English', generated: true }], captionFiles: ['v1.en.vtt'] });
    expect(row).toHaveLength(CSV_COLUMNS.length);
    expect(col(row, 'id')).toBe('v1');
    expect(col(row, 'title')).toBe('Public title');
    expect(col(row, 'name')).toBe('My song.mp4');
    expect(col(row, 'description')).toBe('A description');
    expect(col(row, 'created')).toBe('2026-01-02T03:04:05Z');
    expect(col(row, 'duration_seconds')).toBe(12.5);
    expect(col(row, 'width')).toBe(1920);
    expect(col(row, 'preview_url')).toBe('https://cf/v1/watch');
    expect(col(row, 'share_link')).toBe('https://cf/share');
    expect(col(row, 'playback_hls')).toContain('.m3u8');
    expect(col(row, 'allowed_origins')).toBe('example.com;example.org');
    expect(col(row, 'caption_languages')).toBe('en');
    expect(col(row, 'caption_files')).toBe('v1.en.vtt');
    expect(col(row, 'file')).toBe('v1.mp4');
    expect(col(row, 'file_bytes')).toBe(4096);
    expect(col(row, 'export_status')).toBe('exported');
    expect(col(row, 'error')).toBe('');
  });

  test('flags summarize the booleans', () => {
    expect(col(videoRow(video, { status: 'exported', captions: [{ language: 'en', generated: true }] }), 'flags')).toBe('ready;has_captions;ai_captions');
    const signed = { ...video, requireSignedURLs: true, readyToStream: false, liveInput: 'li1', clippedFrom: 'v0', watermark: { name: 'wm' } };
    expect(col(videoRow(signed, { status: 'skipped' }), 'flags')).toBe('signed_urls;from_live_input;clip;watermarked');
  });

  test('title falls back to meta.name, then empty', () => {
    expect(titleOf({ meta: { name: 'Only meta name' } })).toBe('Only meta name');
    expect(titleOf({ publicDetails: {}, meta: {} })).toBe('');
    expect(titleOf({})).toBe('');
  });

  test('the whole meta object is preserved, and CSV-escaped', () => {
    const row = videoRow(video, { status: 'exported' });
    expect(JSON.parse(col(row, 'meta_json'))).toEqual(video.meta);
    const line = delimitedRow(row);
    // meta contains a comma, a newline and quotes once serialized: the cell must be quoted
    expect(line).toContain('"{""name"":""My song.mp4""');
    // JSON.stringify escapes the newline inside meta, so a row is always exactly one line
    expect(line.split('\n')).toHaveLength(1);
  });

  test('missing fields never throw and render as empty', () => {
    const row = videoRow({ uid: 'bare' }, { status: 'not-ready', error: 'video is queued' });
    expect(col(row, 'id')).toBe('bare');
    expect(col(row, 'title')).toBe('');
    expect(col(row, 'meta_json')).toBe('');
    expect(col(row, 'error')).toBe('video is queued');
  });
});

// ---------------------------------------------------------------------------

describe('createTarGz', () => {
  test('round-trips through system tar', async () => {
    const base = tmpDir('archive');
    const src = join(base, 'backup');
    const deep = join(src, 'a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40));
    mkdirSync(join(src, 'nested'), { recursive: true });
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(src, 'small.txt'), 'hello');
    writeFileSync(join(src, 'big.bin'), Buffer.alloc(1500, 7)); // spans multiple 512-byte blocks
    writeFileSync(join(src, 'nested', 'long-'.repeat(22) + '.txt'), 'deep'); // too long for ustar: GNU @LongLink
    writeFileSync(join(deep, 'file.txt'), 'nested'); // long path that still fits the ustar name/prefix split
    const out = join(base, 'backup.tar.gz');

    const result = await createTarGz(src, out);
    expect(result.files).toBe(4);
    expect(statSync(out).size).toBeGreaterThan(0);

    const dest = join(base, 'extracted');
    mkdirSync(dest);
    expect(Bun.spawnSync(['tar', '-xzf', out, '-C', dest]).exitCode).toBe(0);
    expect(Bun.spawnSync(['diff', '-r', src, join(dest, 'backup')]).exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('listStreamVideos', () => {
  const PAGE = 3;
  let api: ReturnType<typeof startFakeApi>;
  // 7 videos; the 4th and 5th share a timestamp so the inclusive `start` cursor repeats one.
  const all = Array.from({ length: 7 }, (_, i) => ({ uid: `v${i}`, created: `2026-01-0${i + 1}T00:00:00Z` }));

  beforeAll(() => {
    api = startFakeApi((req, url) => {
      if (url.pathname !== `/client/v4/accounts/${ACCOUNT}/stream`) return undefined;
      const start = url.searchParams.get('start');
      const limit = Number(url.searchParams.get('limit') ?? PAGE);
      const from = start ? all.findIndex((v) => v.created >= start) : 0;
      return ok(all.slice(from, from + limit));
    });
  });
  afterAll(() => api.stop());

  const ctx = (): Context => ({
    profileName: 'default',
    profile: {},
    config: { version: 1, profiles: {} },
    credentials: { kind: 'token', apiToken: 'test-token-1234567890', source: 'test' },
    baseURL: api.baseURL,
  });

  test('walks the library by timestamp and never repeats a video', async () => {
    const client = await createClient(ctx(), { version: 'test', baseURL: api.baseURL });
    const seen: string[] = [];
    let batches = 0;
    for await (const batch of listStreamVideos(client, { accountId: ACCOUNT, pageSize: PAGE })) {
      batches++;
      seen.push(...batch.map((v: any) => v.uid));
    }
    expect(seen).toEqual(all.map((v) => v.uid));
    expect(batches).toBeGreaterThan(1);
    // Every request after the first carries a cursor.
    const listCalls = api.requests.filter((r) => r.path.startsWith(`/client/v4/accounts/${ACCOUNT}/stream?`));
    expect(listCalls.length).toBeGreaterThan(1);
    expect(listCalls[0]!.path).toContain('asc=true');
    expect(listCalls[1]!.path).toContain('start=');
  });

  test('stops at maxItems', async () => {
    const client = await createClient(ctx(), { version: 'test', baseURL: api.baseURL });
    const seen: string[] = [];
    for await (const batch of listStreamVideos(client, { accountId: ACCOUNT, pageSize: PAGE, maxItems: 4 })) seen.push(...batch.map((v: any) => v.uid));
    expect(seen).toEqual(['v0', 'v1', 'v2', 'v3']);
  });

  test('passes filters through', async () => {
    const client = await createClient(ctx(), { version: 'test', baseURL: api.baseURL });
    for await (const _ of listStreamVideos(client, { accountId: ACCOUNT, pageSize: PAGE, filters: { creator: 'bob', status: 'ready' }, maxItems: 1 })) break;
    const last = api.requests[api.requests.length - 1]!;
    expect(last.path).toContain('creator=bob');
    expect(last.path).toContain('status=ready');
  });
});

// ---------------------------------------------------------------------------

describe('stream export (end to end)', () => {
  const MP4 = Buffer.from('fake-mp4-bytes-'.repeat(40));
  const VTT = 'WEBVTT\n\n00:00.000 --> 00:02.000\nhello\n';
  let api: ReturnType<typeof startFakeApi>;
  let origin = '';
  let downloadPolls = 0;
  let brokenHealed = false;

  const videos = [
    { uid: 'ready1', created: '2026-01-01T00:00:00Z', readyToStream: true, status: { state: 'ready' }, duration: 10, size: MP4.length, meta: { name: 'First, video', description: 'has a comma' }, publicDetails: { title: 'First' }, preview: 'https://watch/ready1' },
    { uid: 'ready2', created: '2026-01-02T00:00:00Z', readyToStream: true, status: { state: 'ready' }, duration: 20, size: MP4.length, meta: { name: 'Second' } },
    { uid: 'pending', created: '2026-01-03T00:00:00Z', readyToStream: false, status: { state: 'inprogress' }, meta: {} },
    { uid: 'broken', created: '2026-01-04T00:00:00Z', readyToStream: true, status: { state: 'ready' }, meta: {} },
  ];

  beforeAll(() => {
    api = startFakeApi((req, url) => {
      const p = url.pathname;
      const base = `/client/v4/accounts/${ACCOUNT}/stream`;
      if (p === base && req.method === 'GET') {
        const start = url.searchParams.get('start');
        const from = start ? videos.findIndex((v) => v.created >= start) : 0;
        const limit = Number(url.searchParams.get('limit') ?? 50);
        return ok(videos.slice(from, from + limit));
      }
      const one = p.match(new RegExp(`^${base}/([^/]+)$`));
      if (one && req.method === 'GET') {
        const v = videos.find((x) => x.uid === one[1]);
        return v ? ok(v) : Response.json({ success: false, errors: [{ code: 10005, message: 'not found' }], messages: [], result: null }, { status: 404 });
      }
      const dl = p.match(new RegExp(`^${base}/([^/]+)/downloads$`));
      if (dl) {
        const uid = dl[1]!;
        if (uid === 'broken' && !brokenHealed) return ok({ default: { status: 'error', percentComplete: 0 } });
        if (req.method === 'POST') return ok({ default: { status: 'inprogress', percentComplete: 0 } });
        downloadPolls++;
        // First GET reports no download at all (404), then it renders.
        if (downloadPolls === 1) return Response.json({ success: false, errors: [{ code: 10005, message: 'not found' }], messages: [], result: null }, { status: 404 });
        return ok({ default: { status: 'ready', percentComplete: 100, url: `${origin}/${uid}/downloads/default.mp4` } });
      }
      const caps = p.match(new RegExp(`^${base}/([^/]+)/captions$`));
      if (caps) return ok(caps[1] === 'ready1' ? [{ language: 'en', label: 'English', generated: true, status: 'ready' }] : []);
      const vtt = p.match(new RegExp(`^${base}/([^/]+)/captions/([^/]+)/vtt$`));
      if (vtt) return new Response(VTT, { headers: { 'content-type': 'text/vtt' } });
      const media = p.match(/^\/([^/]+)\/downloads\/default\.mp4$/);
      if (media) return new Response(MP4, { headers: { 'content-type': 'video/mp4' } });
      return undefined;
    });
    origin = new URL(api.baseURL).origin;
  });
  afterAll(() => api.stop());

  const env = () => ({ CLOUDFLARE_BASE_URL: api.baseURL, CLOUDFLARE_ACCOUNT_ID: ACCOUNT });
  const csvOf = (dir: string) => readFileSync(join(dir, 'videos.csv'), 'utf8').trim().split('\n');

  test('exports videos, captions and a CSV manifest', async () => {
    const dir = join(tmpDir('e2e'), 'backup');
    const r = await runCli(['stream', 'export', dir, '--concurrency', '2', '--ignore-errors'], { env: env() });
    expect(r.code).toBe(0);

    expect(readFileSync(join(dir, 'ready1.mp4'))).toEqual(MP4);
    expect(readFileSync(join(dir, 'ready2.mp4'))).toEqual(MP4);
    expect(readFileSync(join(dir, 'ready1.en.vtt'), 'utf8')).toBe(VTT);
    expect(existsSync(join(dir, 'pending.mp4'))).toBe(false);
    expect(existsSync(join(dir, 'broken.mp4'))).toBe(false);
    expect(existsSync(join(dir, 'ready1.mp4.part'))).toBe(false);

    const lines = csvOf(dir);
    expect(lines[0]).toBe(CSV_COLUMNS.join(','));
    expect(lines).toHaveLength(videos.length + 1);
    // Rows keep listing order regardless of completion order.
    expect(lines.slice(1).map((l) => l.split(',')[0])).toEqual(['ready1', 'ready2', 'pending', 'broken']);
    expect(lines[1]).toContain('"First, video"'); // comma in meta.name is quoted
    expect(lines[1]).toContain('ready1.mp4');
    expect(lines[1]).toContain('ready1.en.vtt');
    expect(lines[3]).toContain('not-ready');
    expect(lines[4]).toContain('failed');

    const summary = JSON.parse(r.stdout);
    expect(summary).toMatchObject({ total: 4, exported: 2, skipped: 0, failed: 1, account_id: ACCOUNT });
    expect(summary.bytes).toBe(MP4.length * 2);
  });

  test('re-running skips existing files, --overwrite re-downloads', async () => {
    const dir = join(tmpDir('resume'), 'backup');
    await runCli(['stream', 'export', dir, '--ignore-errors'], { env: env() });
    const before = api.requests.length;

    const again = await runCli(['stream', 'export', dir, '--ignore-errors'], { env: env() });
    expect(JSON.parse(again.stdout)).toMatchObject({ exported: 0, skipped: 2 });
    expect(api.requests.slice(before).some((r) => r.method === 'POST')).toBe(false);

    const forced = await runCli(['stream', 'export', dir, '--overwrite', '--ignore-errors'], { env: env() });
    expect(JSON.parse(forced.stdout)).toMatchObject({ exported: 2, skipped: 0 });
  });

  test('--metadata-only writes the CSV without touching media', async () => {
    const dir = join(tmpDir('meta'), 'backup');
    const r = await runCli(['stream', 'export', dir, '--metadata-only'], { env: env() });
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, 'ready1.mp4'))).toBe(false);
    expect(existsSync(join(dir, 'ready1.en.vtt'))).toBe(true);
    expect(csvOf(dir).filter((l) => l.includes('metadata-only'))).toHaveLength(4);
    expect(JSON.parse(r.stdout)).toMatchObject({ exported: 0, failed: 0 });
  });

  test('--no-captions skips caption requests', async () => {
    const dir = join(tmpDir('nocap'), 'backup');
    const before = api.requests.length;
    await runCli(['stream', 'export', dir, '--metadata-only', '--no-captions'], { env: env() });
    expect(api.requests.slice(before).some((r) => r.path.includes('/captions'))).toBe(false);
    expect(existsSync(join(dir, 'ready1.en.vtt'))).toBe(false);
  });

  test('--dry-run reports the plan and writes nothing', async () => {
    const dir = join(tmpDir('dry'), 'backup');
    const before = api.requests.length;
    const r = await runCli(['stream', 'export', dir, '--dry-run'], { env: env() });
    expect(r.code).toBe(0);
    expect(existsSync(dir)).toBe(false);
    expect(api.requests.slice(before).every((req) => req.method === 'GET')).toBe(true);
    const plan = JSON.parse(r.stdout);
    expect(plan).toMatchObject({ dry_run: true, total: 4, downloadable: 3 });
    expect(plan.videos[0]).toMatchObject({ id: 'ready1', file: 'ready1.mp4' });
  });

  test('--compress writes an archive that extracts to the same tree', async () => {
    const dir = join(tmpDir('tgz'), 'backup');
    const r = await runCli(['stream', 'export', dir, '--compress', '--ignore-errors'], { env: env() });
    expect(r.code).toBe(0);
    const archive = JSON.parse(r.stdout).archive as string;
    expect(archive).toBe(dir + '.tar.gz');
    expect(statSync(archive).size).toBeGreaterThan(0);

    const dest = tmpDir('tgz-out');
    expect(Bun.spawnSync(['tar', '-xzf', archive, '-C', dest]).exitCode).toBe(0);
    expect(Bun.spawnSync(['diff', '-r', dir, join(dest, 'backup')]).exitCode).toBe(0);
  });

  test('failures exit 1 unless --ignore-errors', async () => {
    const dir = join(tmpDir('fail'), 'backup');
    const r = await runCli(['stream', 'export', dir], { env: env() });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('1 video failed');
    expect(JSON.parse(r.stdout).failures[0].id).toBe('broken');
    // the other videos were still exported
    expect(existsSync(join(dir, 'ready1.mp4'))).toBe(true);
  });

  test('--limit caps the number of videos and --csv relocates the manifest', async () => {
    const base = tmpDir('limit');
    const dir = join(base, 'backup');
    const csv = join(base, 'manifest.csv');
    const r = await runCli(['stream', 'export', dir, '--limit', '1', '--csv', csv], { env: env() });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ total: 1, exported: 1 });
    const lines = readFileSync(csv, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    // paths in the CSV are relative to the CSV itself
    expect(lines[1]).toContain('backup/ready1.mp4');
  });

  test('expands ~ in the destination, --csv and --archive', async () => {
    const r = await runCli(['stream', 'export', '~/cmdflare-tilde-test', '--csv', '~/cmdflare-tilde.csv', '--archive', '~/cmdflare-tilde.tar.gz', '--compress', '--dry-run'], { env: env() });
    expect(r.code).toBe(0);
    const plan = JSON.parse(r.stdout);
    expect(plan.dir).toBe(join(homedir(), 'cmdflare-tilde-test'));
    expect(plan.csv).toBe(join(homedir(), 'cmdflare-tilde.csv'));
    expect(plan.dir.includes('~')).toBe(false);
    expect(existsSync(join(process.cwd(), '~'))).toBe(false); // never a directory literally named ~
  });

  test('--retry-failed re-attempts only the failed rows and updates them in place', async () => {
    const dir = join(tmpDir('retry'), 'backup');
    const first = await runCli(['stream', 'export', dir], { env: env() });
    expect(first.code).toBe(1);
    expect(JSON.parse(first.stdout)).toMatchObject({ exported: 2, failed: 1 });

    const csvPath = join(dir, 'videos.csv');
    const before = parseDelimited(readFileSync(csvPath, 'utf8'));
    expect(before.rows).toHaveLength(4);

    // Cloudflare can render it now; retry should pick up exactly that one video.
    brokenHealed = true;
    const requestsBefore = api.requests.length;
    const retry = await runCli(['stream', 'export', dir, '--retry-failed'], { env: env() });
    expect(retry.code).toBe(0);
    expect(JSON.parse(retry.stdout)).toMatchObject({ retried: 1, total: 1, exported: 1, failed: 0 });
    brokenHealed = false;

    // Only the failed video was touched: no request mentions the ones that already succeeded.
    const touched = api.requests.slice(requestsBefore).map((r) => r.path);
    expect(touched.some((p) => p.includes('broken'))).toBe(true);
    expect(touched.some((p) => p.includes('ready1') || p.includes('ready2'))).toBe(false);
    expect(touched.some((p) => p.endsWith('/stream') || p.includes('/stream?'))).toBe(false); // no re-listing

    // The manifest keeps every row, in order, with just the retried one rewritten.
    const after = parseDelimited(readFileSync(csvPath, 'utf8'));
    expect(after.header).toEqual([...CSV_COLUMNS]);
    expect(after.rows.map((r) => r[0])).toEqual(['ready1', 'ready2', 'pending', 'broken']);
    const statusAt = CSV_COLUMNS.indexOf('export_status');
    expect(after.rows[3]![statusAt]).toBe('exported');
    expect(after.rows[3]![CSV_COLUMNS.indexOf('error')]).toBe('');
    expect(after.rows.slice(0, 3)).toEqual(before.rows.slice(0, 3)); // untouched rows are byte-identical
    expect(existsSync(join(dir, 'broken.mp4'))).toBe(true);
  });

  test('--retry-failed reports nothing to do when no row failed', async () => {
    const dir = join(tmpDir('retry-clean'), 'backup');
    await runCli(['stream', 'export', dir, '--metadata-only'], { env: env() });
    const r = await runCli(['stream', 'export', dir, '--retry-failed'], { env: env() });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ retried: 0, failed: 0 });
    expect(r.stderr).toContain('nothing to retry');
  });

  test('--retry-failed needs an existing manifest', async () => {
    const dir = join(tmpDir('retry-missing'), 'backup');
    const r = await runCli(['stream', 'export', dir, '--retry-failed'], { env: env() });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('does not exist');
    expect(r.stderr).toContain('Run the export once first');
  });

  test('requires an account', async () => {
    const r = await runCli(['stream', 'export', tmpDir('noacct')], { env: { ...env(), CLOUDFLARE_ACCOUNT_ID: undefined } });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--account');
  });

  test('is discoverable through help and search', async () => {
    expect((await runCli(['stream', '--help'])).stdout).toContain('export');
    expect((await runCli(['search', 'stream', 'export', '--json'])).stdout).toContain('stream export');
    const help = JSON.parse((await runCli(['stream', 'export', '--help', '--json'])).stdout);
    expect(help.command).toBe('stream export');
    expect(help.positionals[0].cli).toBe('dir');
    expect(help.params.map((p: any) => p.name)).toContain('compress');
  });
});
