/** Storage client used while saving a new game bundle. Matches the supabase-js bucket shape. */
export interface BundleStorage {
  upload(path: string, bytes: Uint8Array, contentType: string): Promise<{ error: { message: string } | null }>;
  remove(paths: string[]): Promise<{ error: { message: string } | null }>;
}

/** Thrown after a thumbnail put fails and any earlier bundle objects have been deleted. */
export class ThumbnailUploadError extends Error {
  readonly status = 503;
  constructor() {
    super('Thumbnail upload failed, please try again');
    this.name = 'ThumbnailUploadError';
  }
}

export function isThumbnailUploadError(err: unknown): err is ThumbnailUploadError {
  return err instanceof ThumbnailUploadError || (err instanceof Error && err.name === 'ThumbnailUploadError');
}

function isThumbPath(path: string): boolean {
  return /\/thumb\.[a-z0-9]+$/i.test(path);
}

/**
 * Upload every bundle object (in parallel, one round trip instead of one per object), then run the games insert.
 * If any upload or the insert fails, delete the objects that were stored so a rejected thumbnail cannot leave
 * an orphaned bundle. Cleanup is best-effort: a delete failure is logged, and the original error is always rethrown.
 */
export async function saveUploadedBundle(opts: {
  objects: { path: string; bytes: Uint8Array; contentType: string }[];
  storage: BundleStorage;
  insert: () => Promise<unknown>;
}): Promise<void> {
  const results = await Promise.allSettled(
    opts.objects.map(async ({ path, bytes, contentType }) => {
      const put = await opts.storage.upload(path, bytes, contentType);
      if (put.error) throw new Error(`Storage upload failed: ${put.error.message}`);
    }),
  );
  const stored = opts.objects.filter((_, i) => results[i].status === 'fulfilled').map((o) => o.path);
  const failed = results.findIndex((r) => r.status === 'rejected');
  try {
    if (failed >= 0) {
      if (isThumbPath(opts.objects[failed].path)) throw new ThumbnailUploadError();
      throw (results[failed] as PromiseRejectedResult).reason;
    }
    await opts.insert();
  } catch (err) {
    await discardStoredBundle(opts.storage, stored);
    throw err;
  }
}

async function discardStoredBundle(storage: BundleStorage, paths: string[]) {
  if (paths.length === 0) return;
  try {
    const removed = await storage.remove(paths);
    if (removed.error) logCleanupFailure(paths, removed.error);
  } catch (cleanupErr) {
    logCleanupFailure(paths, cleanupErr);
  }
}

function logCleanupFailure(paths: string[], error: unknown) {
  try {
    console.error(`Failed to delete stored game bundle (${paths.join(', ')}) after the upload failed`, error);
  } catch {
    // A broken logger must not replace the insert error.
  }
}
