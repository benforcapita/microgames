import type { APIRoute } from 'astro';
import { sqlSubmissionStore } from '../../../lib/server/submissions-db';
import { handleSubmissionStatus } from '../../../lib/server/submissions';
import { isAdmin } from '../../../lib/server/profiles';

/** Owner-only (or admin) status JSON. The page polls this until validation passes or fails. */
export const GET: APIRoute = ({ params, locals }) =>
  handleSubmissionStatus({
    userId: locals.user?.id ?? null,
    gameId: params.id ?? '',
    store: sqlSubmissionStore,
    reviewer: isAdmin(locals.profile),
  });
