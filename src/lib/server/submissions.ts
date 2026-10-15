/**
 * SP-5 submission flow. Upload saves a game as `pending` and the owner watches
 * `/submissions/[id]`, which polls `game_validations` until the run finishes.
 *
 * Passing validation auto-publishes on the server (EF-1/EF-2). This module never
 * offers a publish action; the page only reflects `games.stage`.
 *
 * The table is defined in Features v2 and drafted in SP-3. It is not on main yet.
 * Reads and writes use the shared columns (`status`, `static_report`, `run_report`,
 * `screenshot_paths`, …). A missing relation becomes a spec-shaped placeholder.
 */
import { normalizeTags, type Stage } from './game-rules';
import { validateGameUpload, type ForkParent } from './upload';

export type ValidationStatus = 'queued' | 'running' | 'passed' | 'failed' | 'error';
export type CheckLevel = 'pass' | 'fail' | 'warn';
export type CheckSource = 'static' | 'run';

export interface ValidationCheck {
  id: string;
  name: string;
  level: CheckLevel;
  message: string;
  source: CheckSource;
}

export interface SubmissionGame {
  id: string;
  slug: string;
  title: string;
  ownerId: string | null;
  stage: Stage;
}

/** Row shape shared by the spec and the SP-3 draft (no `gh_run_id`, no `bundle_sha256`). */
export interface ValidationRow {
  id: string;
  gameId: string;
  version: number;
  status: ValidationStatus;
  staticReport: unknown;
  runReport: unknown;
  screenshotPaths: string[];
  createdAt: string;
  finishedAt: string | null;
  /** True when the row was synthesized because `game_validations` is not migrated. */
  mocked?: boolean;
}

export interface QueuedStaticReport {
  status: 'pass';
  bytes: number;
  checks: [];
}

export interface SubmissionStore {
  getGame(id: string): Promise<SubmissionGame | null>;
  /** Throws a Postgres `42P01` error when `game_validations` does not exist. */
  latestValidation(gameId: string): Promise<ValidationRow | null>;
}

export interface PendingGameInput {
  ownerId: string;
  creator: string;
  title: string;
  tagline: string;
  description: string;
  tags: string[];
  license: string;
  forkedFrom: string | null;
  html: Uint8Array;
  thumb?: { bytes: Uint8Array; ext: string; type: string };
  stage: 'pending';
}

export interface SubmissionView {
  game: { id: string; slug: string; title: string; stage: Stage };
  validation: {
    id: string;
    version: number;
    status: ValidationStatus;
    checks: ValidationCheck[];
    console: string[];
    blockedRequests: string[];
    timings: Record<string, number | string> | null;
    screenshotPaths: string[];
    createdAt: string;
    finishedAt: string | null;
    mocked: boolean;
  } | null;
  phase: ValidationStatus | 'waiting';
  /** False while the run is open, and while a pass is still waiting to leave `pending`. */
  terminal: boolean;
  published: boolean;
  headline: string;
  detail: string;
  stamp: string;
}

export type UploadPlan =
  | { type: 'redirect'; location: string; gameId: string; stage: 'pending' }
  | { type: 'errors'; status: number; errors: string[] };

export type SubmissionAccess =
  | { status: 200; view: SubmissionView }
  | { status: 401 | 404; error: string };

const STATUSES = new Set<ValidationStatus>(['queued', 'running', 'passed', 'failed', 'error']);
const LEVELS = new Set<CheckLevel>(['pass', 'fail', 'warn']);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const AUTO_PUBLISH = 'A pass is published to the Proving Grounds automatically.';

export function dbFailureKind(err: unknown): 'missing_table' | 'stage_rejected' | 'other' {
  if (!err || typeof err !== 'object') return 'other';
  const code = 'code' in err && typeof err.code === 'string' ? err.code : '';
  const message = 'message' in err && typeof err.message === 'string' ? err.message : '';
  if (code === '42P01') return 'missing_table';
  if (code === '23514' && /games_stage_check/.test(message)) return 'stage_rejected';
  return 'other';
}

export function isSubmissionPreview(id: string): boolean {
  return id === 'preview' && process.env.MG_SUBMISSION_PREVIEW === '1' && process.env.NODE_ENV !== 'production';
}

export function isSubmissionPreviewPath(pathname: string): boolean {
  return pathname === '/submissions/preview' && process.env.MG_SUBMISSION_PREVIEW === '1' && process.env.NODE_ENV !== 'production';
}

export function placeholderValidation(gameId: string): ValidationRow {
  return {
    id: 'unavailable',
    gameId,
    version: 1,
    status: 'queued',
    staticReport: {
      checks: [{
        id: 'store',
        name: 'Validation store',
        level: 'warn',
        message: 'game_validations is not on this database yet. This status is a placeholder until the SP-3 migration is applied.',
      }],
    },
    runReport: null,
    screenshotPaths: [],
    createdAt: 'unpersisted',
    finishedAt: null,
    mocked: true,
  };
}

export async function planGameUpload(opts: {
  user: { id: string } | null;
  profile: { handle: string } | null;
  form: FormData | null;
  findGame: (slugOrId: string) => Promise<ForkParent | null>;
  createGame: (input: PendingGameInput) => Promise<{ id: string }>;
  enqueueValidation: (gameId: string, report: QueuedStaticReport) => Promise<void>;
}): Promise<UploadPlan> {
  if (!opts.user || !opts.profile) {
    return { type: 'errors', status: 401, errors: ['Log in and pick a handle to upload.'] };
  }
  if (!opts.form) return { type: 'errors', status: 400, errors: ['Expected multipart form data'] };

  const { errors, upload } = await validateGameUpload(opts.form, opts.findGame);
  if (!upload) return { type: 'errors', status: 400, errors };

  let game: { id: string };
  try {
    game = await opts.createGame({
      ownerId: opts.user.id,
      creator: opts.profile.handle,
      title: upload.title,
      license: upload.license,
      html: upload.html,
      thumb: upload.thumb,
      tagline: upload.tagline,
      description: upload.description,
      tags: normalizeTags(upload.tagsRaw),
      forkedFrom: upload.forkedFrom,
      stage: 'pending',
    });
  } catch (err) {
    if (dbFailureKind(err) === 'stage_rejected') {
      return {
        type: 'errors',
        status: 503,
        errors: ['This database does not accept pending submissions yet. Apply the submissions migration, then upload again.'],
      };
    }
    throw err;
  }

  try {
    await opts.enqueueValidation(game.id, { status: 'pass', bytes: upload.html.byteLength, checks: [] });
  } catch (err) {
    if (dbFailureKind(err) !== 'missing_table') throw err;
  }

  return { type: 'redirect', location: `/submissions/${game.id}`, gameId: game.id, stage: 'pending' };
}

export async function readSubmission(opts: {
  userId: string | null;
  gameId: string;
  store: SubmissionStore;
}): Promise<SubmissionAccess> {
  if (!opts.userId) return { status: 401, error: 'Log in to view this submission.' };
  if (!ID_RE.test(opts.gameId)) return { status: 404, error: 'Not found' };

  const game = await opts.store.getGame(opts.gameId);
  if (!game || game.ownerId !== opts.userId) return { status: 404, error: 'Not found' };

  let validation: ValidationRow | null;
  try {
    validation = await opts.store.latestValidation(game.id);
  } catch (err) {
    if (dbFailureKind(err) !== 'missing_table') throw err;
    validation = placeholderValidation(game.id);
  }

  return { status: 200, view: buildSubmissionView(game, validation) };
}

export async function handleSubmissionStatus(opts: {
  userId: string | null;
  gameId: string;
  store: SubmissionStore;
}): Promise<Response> {
  const result = await readSubmission(opts);
  if (result.status !== 200) {
    return Response.json({ error: result.error }, { status: result.status, headers: { 'Cache-Control': 'no-store' } });
  }
  return Response.json(result.view, { headers: { 'Cache-Control': 'no-store' } });
}

export function buildSubmissionView(game: SubmissionGame, validation: ValidationRow | null): SubmissionView {
  const published = game.stage === 'proving' || game.stage === 'live';
  const status = validation?.status ?? null;
  const phase: SubmissionView['phase'] = status ?? 'waiting';
  const terminal = status === 'failed' || status === 'error' || (status === 'passed' && game.stage !== 'pending');
  const mocked = validation?.mocked === true;
  const checks = validation ? [...checksFrom(validation.staticReport, 'static'), ...checksFrom(validation.runReport, 'run')] : [];
  const run = reportObject(validation?.runReport);

  let headline = 'Waiting';
  let detail = `Your game is saved as pending. ${AUTO_PUBLISH}`;
  if (phase === 'queued') {
    headline = 'Queued';
    detail = `Validation is queued. This page updates until the run finishes. ${AUTO_PUBLISH}`;
  } else if (phase === 'running') {
    headline = 'Running';
    detail = `Validation is running. ${AUTO_PUBLISH}`;
  } else if (phase === 'passed' && !published) {
    headline = 'Passed';
    detail = 'Every required check passed. Publishing to the Proving Grounds now.';
  } else if (phase === 'passed' && published) {
    headline = 'Published';
    detail = game.stage === 'live'
      ? 'This game has graduated and is monetized.'
      : 'This game is in the Proving Grounds.';
  } else if (phase === 'failed') {
    headline = 'Failed';
    detail = 'Fix the failed checks and submit again. Nothing was published.';
  } else if (phase === 'error') {
    headline = 'Error';
    detail = 'The validation run did not finish. Nothing was published.';
  }
  if (mocked) {
    detail += ' game_validations is not on this database yet, so this status is a placeholder.';
  }

  const view: SubmissionView = {
    game: { id: game.id, slug: game.slug, title: game.title, stage: game.stage },
    validation: validation
      ? {
          id: validation.id,
          version: validation.version,
          status: validation.status,
          checks,
          console: stringList(run?.console ?? run?.consoleExcerpt),
          blockedRequests: stringList(run?.blocked_requests ?? run?.blockedRequests),
          timings: timingsOf(run?.timings),
          screenshotPaths: validation.screenshotPaths.slice(0, 8),
          createdAt: validation.createdAt,
          finishedAt: validation.finishedAt,
          mocked,
        }
      : null,
    phase,
    terminal,
    published,
    headline,
    detail,
    stamp: '',
  };
  view.stamp = submissionStamp(view);
  return view;
}

export function previewSubmissionView(): SubmissionView {
  return buildSubmissionView(
    {
      id: 'preview',
      slug: 'sky-loop',
      title: 'Sky Loop',
      ownerId: 'preview-owner',
      stage: 'pending',
    },
    {
      id: '00000000-0000-4000-8000-000000000001',
      gameId: 'preview',
      version: 1,
      status: 'running',
      staticReport: {
        checks: [
          { id: 'size', label: 'File size', level: 'pass', message: '48 KB, under the 5 MB limit.' },
          { id: 'canvas', label: 'Draws to a canvas', level: 'pass', message: 'Found a canvas element.' },
          { id: 'hosts', label: 'Network allowlist', level: 'warn', message: 'Scripts stay on cdn.jsdelivr.net. One font host is fonts.googleapis.com.' },
          { id: 'sandbox', label: 'Sandbox-safe APIs', level: 'pass', message: 'No alert, window.open, or form submit.' },
        ],
      },
      runReport: {
        checks: [
          { id: 'boot', name: 'First frame', level: 'pass', message: 'First frame arrived in 420 ms.' },
          { id: 'ready', name: 'Meshgrounds.ready()', level: 'warn', message: 'ready() was not called. This stays a warning during the grace period.' },
        ],
        console: ['[boot] Meshgrounds runtime injected'],
        blocked_requests: [],
        timings: { firstFrameMs: 420 },
      },
      screenshotPaths: [],
      createdAt: '2026-10-15T09:00:00.000Z',
      finishedAt: null,
    },
  );
}

function submissionStamp(view: SubmissionView): string {
  const checks = view.validation?.checks.map((c) => `${c.id}:${c.level}`).join(',') ?? '';
  return `${view.game.stage}|${view.validation?.status ?? 'none'}|${view.validation?.finishedAt ?? ''}|${checks}`;
}

function reportObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function checksFrom(report: unknown, source: CheckSource): ValidationCheck[] {
  const body = reportObject(report);
  const raw = body?.checks;
  if (!Array.isArray(raw)) return [];
  const checks: ValidationCheck[] = [];
  for (let i = 0; i < raw.length && checks.length < 40; i++) {
    const row = raw[i];
    if (!row || typeof row !== 'object') continue;
    const item = row as Record<string, unknown>;
    if (typeof item.level !== 'string' || !LEVELS.has(item.level as CheckLevel)) continue;
    const name = typeof item.name === 'string' ? item.name : typeof item.label === 'string' ? item.label : `Check ${i + 1}`;
    const message = typeof item.message === 'string' ? item.message : '';
    const id = typeof item.id === 'string' && item.id ? item.id : `${source}-${i}`;
    checks.push({
      id: clip(id, 80),
      name: clip(name, 120),
      level: item.level as CheckLevel,
      message: clip(message, 500),
      source,
    });
  }
  return checks;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string').slice(0, 20).map((item) => clip(item, 300));
}

function timingsOf(value: unknown): Record<string, number | string> | null {
  const body = reportObject(value);
  if (!body) return null;
  const timings: Record<string, number | string> = {};
  for (const [key, item] of Object.entries(body).slice(0, 12)) {
    if (typeof item === 'number' && Number.isFinite(item)) timings[clip(key, 40)] = item;
    else if (typeof item === 'string') timings[clip(key, 40)] = clip(item, 80);
  }
  return Object.keys(timings).length ? timings : null;
}

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

export function asValidationStatus(value: string): ValidationStatus | null {
  return STATUSES.has(value as ValidationStatus) ? value as ValidationStatus : null;
}
