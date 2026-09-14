/**
 * Composite commands: hand-written, multi-request workflows that live inside the generated
 * command tree (e.g. `cmdflare stream export`).
 *
 * Only the *description* of a composite lives here — a synthetic `MethodNode` spliced into the
 * manifest at load time, which gives the command help text, `--help --json`, `cmdflare search`,
 * shell completion and interactive mode for free. The implementation is loaded lazily by
 * `runComposite` in `src/cli.ts` (see COMPOSITE_RUNNERS there), keyed by `MethodNode.composite`.
 */
import type { MethodNode, ParamProp, ResourceNode, TypeSpec } from './manifest-types';
import type { Invocation } from './runtime';

/** What a composite command handler receives. */
export interface CompositeInput extends Invocation {
  path: ResourceNode[];
  method: MethodNode;
}

export interface CompositeModule {
  run: (input: CompositeInput) => Promise<number>;
}

export interface CompositeDef {
  /** Resource path the command is attached to, by `cli` name (e.g. ['stream']). */
  path: string[];
  method: MethodNode;
}

const prop = (name: string, type: TypeSpec, description: string, required = false): ParamProp => ({
  name,
  required,
  type,
  description,
});
const string_ = { kind: 'string' } as const;
const boolean_ = { kind: 'boolean' } as const;
const number_ = { kind: 'number' } as const;

const STREAM_EXPORT: CompositeDef = {
  path: ['stream'],
  method: {
    name: 'export',
    cli: 'export',
    composite: 'stream-export',
    summary: 'Download every Stream video to a directory, with a CSV of all video metadata.',
    description: `Exports an account's entire Stream library to a local directory.

Each video is saved as <id>.mp4, each caption track as <id>.<language>.vtt, and a CSV manifest
(videos.csv) is written with the metadata of every video — id, title, description, public URLs,
flags, dates, caption languages, the full custom "meta" object, and the relative path to each file.

Videos are listed page by page. Every MP4 render is requested up front (so Cloudflare renders them
concurrently) and each file is downloaded as soon as it is ready. Generated MP4s are kept on your
account, so later exports reuse them (they count towards Stream storage; delete them with
\`cmdflare stream downloads delete <id>\`).

Files that already exist are skipped, so an interrupted export resumes where it stopped.`,
    positionals: [{ name: 'dir', cli: 'dir', type: 'string', required: true, description: 'Destination directory (created if missing).' }],
    params: {
      name: 'params',
      required: true,
      type: {
        kind: 'object',
        text: 'StreamExportParams',
        props: [
          prop('account_id', string_, 'Identifier.', true),
          prop('csv', string_, 'Path of the CSV manifest. Defaults to <dir>/videos.csv.'),
          prop('compress', boolean_, 'Also write a gzipped tar archive of the directory (<dir>.tar.gz). The directory is kept.'),
          prop('archive', string_, 'Archive path to write with --compress. Defaults to <dir>.tar.gz.'),
          prop('concurrency', number_, 'How many videos to download in parallel. Defaults to 4.'),
          prop('request_concurrency', number_, 'How many MP4 renders to request in parallel before downloading starts. Defaults to 16.'),
          prop('metadata_only', boolean_, 'Write the CSV (and captions) only; do not download any video files.'),
          prop('captions', boolean_, 'Download caption tracks as <id>.<language>.vtt. On by default; use --no-captions to skip.'),
          prop('overwrite', boolean_, 'Re-download files that already exist locally. By default existing files are skipped.'),
          prop('poll_timeout', number_, 'Seconds to wait for Cloudflare to render each MP4 before giving up. Defaults to 600.'),
          prop('ignore_errors', boolean_, 'Exit with 0 even when some videos could not be exported.'),
          prop('retry_failed', boolean_, 'Retry only the videos the previous run recorded as failed in the CSV manifest, leaving every other row untouched. Requires the manifest to exist.'),
          prop('creator', string_, 'Only export videos with this creator id.'),
          prop('search', string_, 'Only export videos whose name partially matches this term.'),
          prop('video_name', string_, 'Only export videos whose name matches this term exactly.'),
          prop('status', { kind: 'enum', enum: ['queued', 'pendingupload', 'downloading', 'inprogress', 'ready', 'error', 'live-inprogress'] }, 'Only export videos in this state.'),
          prop('type', { kind: 'enum', enum: ['vod', 'live'] }, 'Only export videos of this type.'),
          prop('start', string_, 'Only export videos created after this date (RFC 3339).'),
          prop('end', string_, 'Only export videos created before this date (RFC 3339).'),
        ],
      },
    },
    returns: 'StreamExportSummary',
  },
};

export const COMPOSITES: CompositeDef[] = [STREAM_EXPORT];

/** Implementations, loaded on demand. Literal specifiers keep them visible to the bundler. */
const RUNNERS: Record<string, () => Promise<CompositeModule>> = {
  'stream-export': () => import('../commands/stream-export'),
};

export async function loadComposite(key: string): Promise<CompositeModule> {
  const loader = RUNNERS[key];
  if (!loader) throw new Error(`No implementation registered for composite command "${key}".`);
  return loader();
}

/** Splices every composite command into the manifest tree. Called once by `loadIndex()`. */
export function attachComposites(root: ResourceNode): void {
  for (const def of COMPOSITES) {
    let node: ResourceNode | undefined = root;
    for (const seg of def.path) node = node?.children.find((c) => c.cli === seg);
    if (!node) continue; // resource gone from the SDK: skip rather than break the whole manifest
    if (node.methods.some((m) => m.cli === def.method.cli)) continue; // never shadow a real SDK method
    node.methods.push(def.method);
  }
}
