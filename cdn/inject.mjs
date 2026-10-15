// Head injection for CDN-served game documents (pure; shared by handler and tests).
// Adds, right after <head> (or at the top if the game has none):
//   - the portal's zoom-locked viewport meta, ONLY if the game declares no viewport of its own (MV-1),
//   - touch-action: manipulation on the game root (no double-tap zoom / 300 ms delay),
//   - the boot script.
export const VIEWPORT = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no';
const HAS_VIEWPORT = /<meta\b[^>]*\bname\s*=\s*["']?viewport["'\s/>]/i;
const TOUCH_STYLE = '<style>html,body{touch-action:manipulation}</style>';

export const hasViewport = (html) => HAS_VIEWPORT.test(html);

export function injectHead(html, boot) {
  const meta = hasViewport(html) ? '' : `<meta name="viewport" content="${VIEWPORT}">`;
  const tag = `${meta}${TOUCH_STYLE}<script>${boot}</script>`;
  const head = html.match(/<head[^>]*>/i);
  if (head) return html.replace(head[0], head[0] + tag);
  const lead = html.match(/^\s*(<!doctype[^>]*>)?\s*(<html[^>]*>)?/i)[0];
  return lead + tag + html.slice(lead.length);
}
