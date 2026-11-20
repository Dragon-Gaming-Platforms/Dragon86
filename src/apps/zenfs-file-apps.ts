/** Same-origin apps that open or export user files. */
export const ZENFS_FILE_APP_IDS = new Set([
  "api-client", "arculator", "audio-studio", "backgammon", "building-design", "cad", "checkers",
  "chess", "circuits", "contacts", "emulatorjs", "music-studio", "notes", "parametric",
  "photo-studio", "presentation", "ps1", "records", "solitaire", "studio3d", "sudoku",
  "tasks", "vector-studio", "video-studio", "whiteboard", "wiki",
]);

export const isZenFSFileApp = (id: string): boolean => ZENFS_FILE_APP_IDS.has(id);

const INJECT = `<script>try{parent.__d86ZenFSFiles&&parent.__d86ZenFSFiles.install(window)}catch(e){console.error("Dragon86 Files adapter unavailable",e)}</script>`;

/** Inserted at parse time so file inputs are redirected before app startup. */
export function injectZenFSFileAdapter(html: string): string {
  if (html.includes("__d86ZenFSFiles&&parent.__d86ZenFSFiles.install")) return html;
  const head = /<head\b[^>]*>/i;
  return head.test(html) ? html.replace(head, (tag) => `${tag}${INJECT}`) : `${INJECT}${html}`;
}
