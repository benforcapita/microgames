/** Storage client used while saving a new game bundle. Matches the supabase-js bucket shape. */
export interface BundleStorage {
  upload(path: string, bytes: Uint8Array, contentType: string): Promise<{ error: { message: string } | null }>;
  remove(paths: string[]): Promise<{ error: { message: string } | null }>;
}

/**
 * Upload every bundle object, then run the games insert.
 * If that insert throws, delete the objects just stored. Cleanup is best-effort:
 * a delete failure is logged, and the original insert error is always rethrown.
 */
export async function saveUploadedBundle(opts: {
  objects: { path: string; bytes: Uint8Array; contentType: string }[];
  storage: BundleStorage;
  insert: () => Promise<unknown>;
}): Promise<void> {
  const stored: string[] = [];
  for (const object of opts.objects) {
    const put = await opts.storage.upload(object.path, object.bytes, object.contentType);
    if (put.error) throw new Error(`Storage upload failed: ${put.error.message}`);
    stored.push(object.path);
  }

  try {
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
    console.error(`Failed to delete stored game bundle (${paths.join(', ')}) after the games insert failed`, error);
  } catch {
    // A broken logger must not replace the insert error.
  }
}
