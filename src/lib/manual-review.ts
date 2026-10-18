const OFF = new Set(['0', 'false', 'off', 'no']);

/**
 * Parse a settings value. Missing or blank is on. Only `0`, `false`, `off`, or `no` is off.
 * The live switch is the database row; this does not read the environment.
 */
export function manualReviewEnabled(raw: string | undefined): boolean {
  if (raw == null || raw.trim() === '') return true;
  return !OFF.has(raw.trim().toLowerCase());
}

/** What a pass does, for pages and the submission status that are still waiting on validation. */
export function passPublishLine(enabled = true): string {
  return enabled
    ? 'A pass waits for a reviewer before it is published.'
    : 'A pass is published to the Proving Grounds automatically.';
}

export function uploadOutcome(enabled = true): string {
  return enabled
    ? 'The game stays private while validation runs. A pass waits for review, then opens in the Proving Grounds.'
    : 'The game stays private while validation runs, then publishes to the Proving Grounds on its own if it passes.';
}

export function homeCreatorSentence(enabled = true): string {
  return enabled
    ? 'Upload one HTML file. After review it enters the Proving Grounds, and if it clears that it graduates to the main arcade.'
    : 'Upload one HTML file and it goes live right away. Pass the Proving Grounds and your game graduates to the main arcade.';
}

export function creatorsLiveStep(enabled = true): { title: string; body: string } {
  return enabled
    ? {
        title: 'Upload → review → the Proving Grounds.',
        body: 'A passed game waits for review, then opens for players to scout, play, and rate.',
      }
    : {
        title: 'Upload → the Proving Grounds.',
        body: 'Your game goes live straight away in a discovery feed. Players scout it, play it, and rate it.',
      };
}

/** Shown before an asset upload that will take a public game offline. */
export const ASSET_REVIEW_HOLD =
  'This game is public. Uploading or replacing a file takes it offline until a reviewer publishes it again.';

/** Cancel leaves the game public. A game that is not on review hold uploads without asking. */
export function confirmPublicAssetChange(reviewHold: boolean, confirm: (message: string) => boolean): boolean {
  if (!reviewHold) return true;
  return confirm(ASSET_REVIEW_HOLD);
}
