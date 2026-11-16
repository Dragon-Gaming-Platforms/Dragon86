/**
 * Dragon86 — boot sequence.
 */

import "./styles/theme.css";
import "./styles/os.css";
import { applySettings } from "./core/settings";
import { initVfs } from "./core/vfs";
import { WindowManager } from "./core/wm";
import { buildDesktop, refreshDesktops } from "./core/desktop";
import { buildTaskbar, coreApps } from "./core/taskbar";
import { createLauncher } from "./apps/registry";
import { isolationReport, logInfo, logWarn } from "./core/log";
import { loadFsApps, onFsAppsChange, startFsAppBridge } from "./core/fs-apps";
import { loadDefaults, requestDefaults } from "./core/filetypes";
import { initTrash } from "./core/trash";
import { ensureAppShortcuts, watchAppPointers } from "./core/app-shortcuts";
import { installDevApi } from "./core/dev-api";
import { getSettings } from "./core/settings";
import { startDeveloperConsole } from "./core/eruda";

async function completeOpenRouterSignIn(): Promise<void> {
  const params = new URLSearchParams(location.search);
  if (!params.has("openrouter_callback")) return;
  const code = params.get("code");
  try {
    if (!code) throw new Error("OpenRouter did not return an authorization code.");
    const verifier = localStorage.getItem("dragon86.openrouter.verifier");
    if (!verifier) throw new Error("The sign-in verifier is missing; please try again.");
    const response = await fetch("https://openrouter.ai/api/v1/auth/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
    });
    if (!response.ok) throw new Error(`OpenRouter sign-in failed (${response.status}).`);
    const payload = await response.json() as { key?: string };
    if (!payload.key) throw new Error("OpenRouter did not return an API key.");
    localStorage.setItem("dragon86.openrouter.key", payload.key);
    localStorage.removeItem("dragon86.openrouter.error");
  } catch (error) {
    localStorage.setItem("dragon86.openrouter.error", error instanceof Error ? error.message : String(error));
  } finally {
    localStorage.removeItem("dragon86.openrouter.verifier");
    history.replaceState({}, "", location.pathname);
  }
}

async function boot(): Promise<void> {
  await completeOpenRouterSignIn();
  /* Nothing in Dragon86 needs cross-origin isolation anymore (the in-page
     emulators run without SharedArrayBuffer); log the state every boot so
     diagnostics always show which state we're in. */
  logInfo("os", "boot environment:", isolationReport());
  const status = document.querySelector<HTMLParagraphElement>(".boot-status");
  const barFill = document.querySelector<HTMLElement>(".boot-bar-fill");

  const step = async (pct: number, label: string, fn?: () => Promise<void> | void) => {
    if (barFill) barFill.style.width = `${pct}%`;
    if (status) status.textContent = label;
    await new Promise((r) => setTimeout(r, 180));
    if (fn) await fn();
  };

  await step(15, "Loading theme…", () => applySettings());
  if (getSettings().devConsole) void startDeveloperConsole().catch((error) => logWarn("os", "Eruda startup failed:", error));
  await step(45, "Mounting virtual filesystem…", () => initVfs());
  /* Filesystem apps have to be known before the launcher is built (the
     start menu and desktop get their entries from the registry), and the
     service worker has to be live before any app window asks for a file. */
  await step(60, "Loading filesystem apps…", async () => {
    await loadFsApps();
    await loadDefaults();
    startFsAppBridge();
  });
  /* Deleting means "put it in the trash", and the trash is emptied at boot. */
  await step(68, "Emptying the trash…", () => initTrash());
  await step(75, "Starting window manager…");

  /* build the shell */
  const wmHost = document.getElementById("windows")!;
  const wm = new WindowManager(wmHost);
  const launcher = createLauncher(wm);

  /* window.d86 — the API system scripts (and same-origin apps) use. Installed
     before anything else can run a script. */
  installDevApi({
    launch: (id) => launcher.launch[id]?.(),
    open: (path) => launcher.openFile(path),
  });

  /* The app list is a function, not a snapshot: installing something in the
     App Store has to show up on the desktop and in the start menu without a
     reload. */
  const appsNow = () => coreApps(launcher.launch);
  buildTaskbar(wm, appsNow);
  buildDesktop(appsNow, {
    openApp: (id) => launcher.launch[id]?.(),
    openFile: (p) => launcher.openFile(p),
    openFolder: (p) => launcher.openFolder(p),
    openWith: (p, id) => launcher.openWith(p, id),
  });

  onFsAppsChange(() => {
    void launcher.refreshApps().then(() => refreshDesktops());
  });

  await step(100, "Welcome to Dragon86.");

  /* reveal */
  const bootEl = document.getElementById("boot")!;
  bootEl.classList.add("fade-out");
  document.getElementById("os")!.hidden = false;
  setTimeout(() => bootEl.remove(), 550);

  /* Installed apps get to ask to become the default opener for their file
     types — once each, in a corner card, after the desktop is visible. */
  setTimeout(() => void requestDefaults(), 1200);
  /* ~/applications gets a .d86 pointer per app entry in the app JSONs
     (iframe-apps.json + ~/system/apps/*.json), regenerated whenever those
     JSONs change and never duplicated. */
  setTimeout(() => {
    void ensureAppShortcuts();
    watchAppPointers();
  }, 1600);
}

void boot();
