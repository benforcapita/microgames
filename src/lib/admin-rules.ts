/** Admin review rules. No database or environment access. */
import type { Stage } from './server/game-rules';

export type ReviewDecision = 'approve' | 'reject';
export const REVIEW_NOTE_MAX = 500;

/**
 * Stage a reviewer's decision moves a game to, or null when the decision makes no sense for the
 * current stage. Approve publishes a held (pending) game or re-opens a rejected one into the
 * Proving Grounds; it never jumps straight to live (graduation stays telemetry-driven). Reject
 * takes any non-rejected game down, including a public one (a takedown). The stage write itself
 * stamps reviewed_at via games_touch_review (MR-1).
 */
export function reviewTransition(current: Stage, decision: ReviewDecision): Stage | null {
  if (decision === 'approve') return current === 'pending' || current === 'rejected' ? 'proving' : null;
  if (decision === 'reject') return current === 'rejected' ? null : 'rejected';
  return null;
}

export interface ReviewInput {
  decision: ReviewDecision;
  note: string | null;
}

/** Validates the review form. A note is required when rejecting so the creator learns why. */
export function parseReviewInput(form: { get(name: string): FormDataEntryValue | string | null }): { input?: ReviewInput; error?: string } {
  const decision = String(form.get('decision') ?? '');
  if (decision !== 'approve' && decision !== 'reject') return { error: 'Pick approve or reject.' };
  const raw = form.get('note');
  const note = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (note.length > REVIEW_NOTE_MAX) return { error: `Keep the note under ${REVIEW_NOTE_MAX} characters.` };
  if (decision === 'reject' && !note) return { error: 'Add a note so the creator knows what to fix.' };
  return { input: { decision, note: note || null } };
}
