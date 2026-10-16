/**
 * Client-safe asset size limits and warning summaries.
 *
 * Game versions cap code plus uploaded assets at 4 MB. Uploaded assets
 * larger than 100 KB trigger creator warnings.
 */

/** HTML/code plus every asset stored for the version. Single source: asset-upload.ts (#59) enforces it, AS-4 warns. */
export const GAME_VERSION_MAX_BYTES = 4 * 1024 * 1024;
/** Larger assets are stored; the owner sees a warning. */
export const ASSET_SIZE_WARN_BYTES = 100 * 1024;

export interface AssetInputItem {
  path: string;
  status: 'missing' | 'uploaded' | 'rejected';
  sizeBytes: number | null;
}

export interface SummarizeAssetsInput {
  codeBytes: number;
  assets: AssetInputItem[];
}

export interface AssetSummaryLargeItem {
  path: string;
  sizeBytes: number;
}

export interface AssetSummary {
  missing: string[];
  totalBytes: number;
  maxBytes: number;
  overTotal: boolean;
  large: AssetSummaryLargeItem[];
}

export function summarizeAssets({
  codeBytes,
  assets,
}: {
  codeBytes: number;
  assets: { path: string; status: 'missing' | 'uploaded' | 'rejected'; sizeBytes: number | null }[];
}): AssetSummary {
  const missing: string[] = [];
  const large: AssetSummaryLargeItem[] = [];
  let uploadedBytes = 0;

  for (const asset of assets) {
    if (asset.status === 'missing') {
      missing.push(asset.path);
    } else if (asset.status === 'uploaded') {
      const size = typeof asset.sizeBytes === 'number' ? asset.sizeBytes : 0;
      uploadedBytes += size;
      if (size > ASSET_SIZE_WARN_BYTES) {
        large.push({ path: asset.path, sizeBytes: size });
      }
    }
  }

  missing.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  large.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const totalBytes = codeBytes + uploadedBytes;

  return {
    missing,
    totalBytes,
    maxBytes: GAME_VERSION_MAX_BYTES,
    overTotal: totalBytes > GAME_VERSION_MAX_BYTES,
    large,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = (bytes / 1024).toFixed(1);
  if (Number(kb) < 1024) return `${kb} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function formatTotal(bytes: number): string {
  return `${formatBytes(bytes)} (${bytes.toLocaleString('en-US')} bytes)`;
}
