/**
 * Client-safe asset size limits and warning summaries.
 *
 * Game versions cap code plus uploaded assets at 4 MB. Uploaded assets
 * larger than 100 KB trigger creator warnings.
 */

export const GAME_VERSION_MAX_BYTES = 4 * 1024 * 1024;
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

  const totalBytes = codeBytes + uploadedBytes;

  return {
    missing,
    totalBytes,
    maxBytes: GAME_VERSION_MAX_BYTES,
    overTotal: totalBytes > GAME_VERSION_MAX_BYTES,
    large,
  };
}

const ONE_MB = 1024 * 1024;

export function formatSize(bytes: number): string {
  if (bytes < ONE_MB) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / ONE_MB).toFixed(2)} MB`;
}
