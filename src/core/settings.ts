/** Settings store — localStorage-backed, no login. */

export type ThemeId = "dragon" | "cyberpunk" | "purple" | "matrix" | "amoled" | "sunset";

/**
 * The CPU architecture of the Terminal's machine. The user picks hardware,
 * not an emulator: the right engine is chosen behind the scenes
 * (bridge/v86.ts — the vendored v64 build for the x86 machines and ARM64;
 * bridge/rv64.ts — the vendored rv64.js build for RISC-V 64).
 */
export type MachineArch = "x86_32" | "x86_64" | "arm64" | "arm32" | "riscv64";

export interface Settings {
  theme: ThemeId;
  wallpaper: string;
  /** Which machine the Terminal boots — see MachineArch. */
  arch: MachineArch;
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
  /** Desktop icon size — the tile grid follows it. */
  iconSize: "small" | "medium" | "large";
  /**
   * Where the App Store reads its catalog from. Empty = the store.json that
   * ships next to the OS. Anything else can be a full URL or a path.
   */
  storeUrl: string;
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
  /* 32-bit x86 is the default: it is the only architecture with an
     installed distro today (the Arch userland), and its engine runs on
     every browser Dragon86 targets. */
  arch: "x86_32",
  /* copy.sh's own public proxy: the same one its Arch demo uses, so the
     guest behaves the way it does there. Rate-limited and shared — set your
     own wisp/wsproxy URL in Settings for regular use. */
  v86Network: "wss://relay.widgetry.org/",
  iconSize: "medium",
  storeUrl: "",
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
