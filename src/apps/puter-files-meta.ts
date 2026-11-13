/** IDs of vendored heyputer/everything apps installed from the Dragon86 Store. */
export const PUTER_APP_IDS = new Set([
  "api-client", "audio-studio", "backgammon", "building-design", "cad", "checkers",
  "chess", "circuits", "music-studio", "notes", "parametric", "photo-studio",
  "presentation", "records", "solitaire", "studio3d", "sudoku", "vector-studio",
  "video-studio", "whiteboard", "wiki", "tasks", "contacts",
]);

export const isPuterApp = (id: string): boolean => PUTER_APP_IDS.has(id);

const INJECT = `<script>try{parent.__d86PuterFiles&&parent.__d86PuterFiles.install(window)}catch(e){console.error("Dragon86 Files adapter unavailable",e)}</script>`;

/** Inserted at parse time so file inputs are redirected before app startup. */
export function injectPuterFilesAdapter(html: string): string {
  if (html.includes("__d86PuterFiles&&parent.__d86PuterFiles.install")) return html;
  const head = /<head\b[^>]*>/i;
  return head.test(html) ? html.replace(head, (tag) => `${tag}${INJECT}`) : `${INJECT}${html}`;
}
