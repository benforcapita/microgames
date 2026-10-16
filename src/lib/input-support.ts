/**
 * Input support (IS-1): which devices a game can be played on.
 *
 * Runtime-neutral (no Node/Deno APIs), shared by the server mappers, the static check (IS-2) and the
 * validate-game Edge Function. 'unknown' is only ever a computed value: a game can *declare*
 * 'mobile' | 'desktop' | 'both' through the runtime contract (see docs/INPUT-SUPPORT.md):
 *   <meta name="meshground:input-support" content="both">   (legacy name meshgrounds:input-support also accepted)
 *   window.Meshground?.declare?.({ inputSupport: 'both' })
 */
export const INPUT_SUPPORT = ['mobile', 'desktop', 'both', 'unknown'] as const;
export type InputSupport = (typeof INPUT_SUPPORT)[number];
export const DECLARABLE_INPUT_SUPPORT = ['mobile', 'desktop', 'both'] as const;
export type DeclaredInputSupport = (typeof DECLARABLE_INPUT_SUPPORT)[number];

/** Meta tag name a game uses to declare its input support. */
export const INPUT_SUPPORT_META = 'meshground:input-support';
/** Pre-rebrand name; games uploaded before the rename still use it, so it is read everywhere the new name is. */
export const LEGACY_INPUT_SUPPORT_META = 'meshgrounds:input-support';
export const INPUT_SUPPORT_META_NAMES: readonly string[] = [INPUT_SUPPORT_META, LEGACY_INPUT_SUPPORT_META];

/** A declared value ('mobile' | 'desktop' | 'both', case/space-insensitive), else null. */
export function parseDeclaredInputSupport(v: unknown): DeclaredInputSupport | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return (DECLARABLE_INPUT_SUPPORT as readonly string[]).includes(s) ? (s as DeclaredInputSupport) : null;
}

/** Any stored value; anything unexpected (null, typos, older rows) reads as 'unknown'. */
export function toInputSupport(v: unknown): InputSupport {
  return typeof v === 'string' && (INPUT_SUPPORT as readonly string[]).includes(v) ? (v as InputSupport) : 'unknown';
}
