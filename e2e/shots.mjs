// E2E screenshots go to a gitignored directory (Playwright's outputDir, test-results/), never docs/pr-assets/,
// so running e2e leaves `git status` clean. To refresh a committed PR asset, copy it from here by hand.
import path from 'node:path';

// Absolute (repo root), so it doesn't depend on the cwd playwright was started from.
export const SHOT_DIR = path.join(import.meta.dirname, '..', 'test-results', 'screenshots');
export const shotPath = (name) => path.join(SHOT_DIR, name);
