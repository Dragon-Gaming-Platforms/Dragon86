/**
 * Dragon86 — boot sequence.
 */

import "./styles/theme.css";
import "./styles/os.css";
import { applySettings } from "./core/settings";
import { initVfs } from "./core/vfs";
import { WindowManager } from "./core/wm";
import { buildDesktop } from "./core/desktop";
import { buildTaskbar, coreApps } from "./core/taskbar";
import { createLauncher } from "./apps/registry";
import { isolationReport, logInfo, logWarn } from "./core/log";
import { loadFsApps, startFsAppBridge } from "./core/fs-apps";

async function boot(): Promise<void> {
  /* Isolation is what lets the embedded CheerpX hoster get
     SharedArrayBuffer. The coi-serviceworker (index.html) makes this page
     isolated from the second load onward; log it every boot so diagnostics
     always show which state we're in. */
  logInfo("os", "boot environment:", isolationReport());
  if (!window.crossOriginIsolated) {
    logWarn(
      "os",
      "not cross-origin isolated yet — first visit installs the COI " +
        "service worker and reloads; the engine cannot start until this " +
        "reports true.",
    );
  }
  const status = document.querySelector<HTMLParagraphElement>(".boot-status");
  const barFill = document.querySelector<HTMLElement>(".boot-bar-fill");

  const step = async (pct: number, label: string, fn?: () => Promise<void> | void) => {
    if (barFill) barFill.style.width = `${pct}%`;
    if (status) status.textContent = label;
    await new Promise((r) => setTimeout(r, 180));
    if (fn) await fn();
  };

  await step(15, "Loading theme…", () => applySettings());
  await step(45, "Mounting virtual filesystem…", () => initVfs());
  /* Filesystem apps have to be known before the launcher is built (the
     start menu and desktop get their entries from the registry), and the
     service worker has to be live before any app window asks for a file. */
  await step(60, "Loading filesystem apps…", async () => {
    await loadFsApps();
    startFsAppBridge();
  });
  await step(75, "Starting window manager…");

  /* build the shell */
  const wmHost = document.getElementById("windows")!;
  const wm = new WindowManager(wmHost);
  const launcher = createLauncher(wm);

  const apps = coreApps(launcher.launch);
  buildTaskbar(wm, apps);
  buildDesktop(apps, {
    openApp: (id) => launcher.launch[id]?.(),
    openFile: (p) => launcher.openFile(p),
    openFolder: (p) => launcher.openFolder(p),
  });

  await step(100, "Welcome to Dragon86.");

  /* reveal */
  const bootEl = document.getElementById("boot")!;
  bootEl.classList.add("fade-out");
  document.getElementById("os")!.hidden = false;
  setTimeout(() => bootEl.remove(), 550);
}

void boot();
