/** Settings store — localStorage-backed, no login. */

export type ThemeId = "dragon" | "cyberpunk" | "purple" | "matrix" | "amoled" | "sunset";

export type EngineMode = "embedded" | "tab" | "v86";

/**
 * Which guest the v86 engine boots.
 * - "dragon": the vendored mini guest (Arch kernel + bash/coreutils/git).
 *   Boots in seconds, /shared is the live OS filesystem.
 * - "arch": the full Arch Linux 32 root filesystem that copy.sh/v86 serves,
 *   streamed over 9p from an HTTP image store (fs.json + blobs). Real Arch:
 *   pacman, the whole userland. Slower, and no /shared (v86 has a single
 *   9p device, which the root filesystem occupies).
 */
export type V86Guest = "dragon" | "arch";

export interface Settings {
  theme: ThemeId;
  wallpaper: string;
  hosterUrl: string;
  /**
   * Where the CheerpX engine runs:
   * - "embedded": hidden iframe inside this page. Requires Dragon86 itself
   *   to be cross-origin isolated (coi-serviceworker ON).
   * - "tab": hoster opened as its own top-level browser tab (it isolates
   *   itself); Dragon86 does NOT need isolation, so coi-serviceworker is
   *   deregistered and the OS page is unrestricted.
   * - "v86": the vendored v86 emulator (public/v86/) runs a tiny Linux
   *   right inside this page. No isolation, no hoster, no service worker
   *   needed — the compatibility engine for WebView/locked-down browsers.
   *   Its /shared folder is the OS virtual filesystem (see bridge/v86.ts).
   */
  engineMode: EngineMode;
  /** Guest image for the v86 engine — see V86Guest. */
  v86Guest: V86Guest;
  /** Image store root for v86Guest "arch" (fs.json + arch/ live here). */
  v86ImageBase: string;
  /**
   * v86 network backend. Empty/"off" = no NIC at all (the guest sees only
   * loopback). Anything else is v86's relay URL, which decides the backend by
   * scheme:
   *   wss://host/   wsproxy  — copy.sh's own backend; DHCP comes from the proxy
   *   wisp://host   wisp     — v86 runs the stack itself; DHCP answered locally
   *   fetch         in-page  — no server, but only CORS-visible traffic
   * The emulated NIC is v86's job either way; the guest only has to load its
   * driver and ask for a lease (that is what /networking.sh does).
   */
  v86Network: string;
}

const KEY = "dragon86.settings";

export const THEMES: { id: ThemeId; name: string; swatch: string }[] = [
  { id: "dragon", name: "Dragon Red", swatch: "linear-gradient(135deg,#e60012,#4a0000)" },
  { id: "cyberpunk", name: "Cyberpunk", swatch: "linear-gradient(135deg,#00e5ff,#003340)" },
  { id: "purple", name: "Purple", swatch: "linear-gradient(135deg,#9d4edd,#240046)" },
  { id: "matrix", name: "Matrix", swatch: "linear-gradient(135deg,#00ff66,#002b11)" },
  { id: "amoled", name: "AMOLED", swatch: "linear-gradient(135deg,#e2e8f0,#1e293b)" },
  { id: "sunset", name: "Sunset", swatch: "linear-gradient(135deg,#ff8c00,#4a1c00)" },
];

export const WALLPAPERS: { id: string; name: string; css: string }[] = [
  { id: "ember", name: "Ember", css: "var(--wall-ember)" },
  { id: "obsidian", name: "Obsidian", css: "var(--wall-obsidian)" },
  {
    id: "void",
    name: "Void",
    css: "radial-gradient(ellipse at 30% 20%, rgba(var(--theme-rgb),0.18), transparent 55%), #050505",
  },
  {
    id: "inferno",
    name: "Inferno",
    css: "radial-gradient(ellipse at 70% 80%, rgba(var(--theme-rgb),0.35), transparent 60%), linear-gradient(160deg, #0a0a0a 30%, rgba(var(--theme-rgb),0.15))",
  },
  {
    id: "grid",
    name: "Grid",
    css: "repeating-linear-gradient(0deg, transparent 0 38px, rgba(var(--theme-rgb),0.07) 38px 40px), repeating-linear-gradient(90deg, transparent 0 38px, rgba(var(--theme-rgb),0.07) 38px 40px), #060606",
  },
];

const DEFAULTS: Settings = {
  theme: "dragon",
  wallpaper: "ember",
  hosterUrl: "",
  engineMode: "embedded",
  v86Guest: "dragon",
  v86ImageBase: "https://i.copy.sh/",
  /* copy.sh's own public proxy: the same one its Arch demo uses, so the
     guest behaves the way it does there. Rate-limited and shared — set your
     own wisp/wsproxy URL in Settings for regular use. */
  v86Network: "wss://relay.widgetry.org/",
};

let current: Settings = load();
const listeners = new Set<(s: Settings) => void>();

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function getSettings(): Settings {
  return current;
}

export function setSettings(patch: Partial<Settings>): void {
  current = { ...current, ...patch };
  localStorage.setItem(KEY, JSON.stringify(current));
  applySettings();
  for (const fn of listeners) fn(current);
}

export function onSettingsChange(fn: (s: Settings) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function applySettings(): void {
  document.documentElement.setAttribute("data-theme", current.theme);
  const wall = WALLPAPERS.find((w) => w.id === current.wallpaper) ?? WALLPAPERS[0];
  document.documentElement.style.setProperty("--wall-active", wall.css);
}
