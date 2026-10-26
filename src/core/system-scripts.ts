/**
 * "Run as system script" — running a .js file from your filesystem *inside*
 * this page.
 *
 * There is no sandbox and no worker: the file is inserted as a real
 * <script>, so it can do anything the OS can (write to ZenFS, register an
 * app, open windows) and anything the page can (fetch, storage, the DOM).
 * That power is the feature, so it is never a single click:
 *
 *   the menu item asks; the dialog says what will happen and where the file
 *   came from; only then does anything run.
 *
 * A script gets `window.d86` — see core/dev-api.ts for the surface.
 */

import { showConfirm } from "./dialog";
import * as vfs from "./vfs";
import { logInfo, logWarn } from "./log";
import { notify } from "./toast";
import { devApi } from "./dev-api";

/** Scripts that are currently open in a <script> tag, so one can be re-run. */
const running = new Map<string, HTMLScriptElement>();

/**
 * Ask first, then run. `path` must be a .js file in the OS filesystem.
 */
export async function runSystemScript(path: string): Promise<void> {
  const name = vfs.baseName(path);
  if (!/\.m?js$/i.test(name)) {
    notify({ title: "Not a script", body: `${name} is not a .js file.`, icon: "info" });
    return;
  }

  const ok = await showConfirm(
    `Run ${name} as a system script?`,
    `This runs the file inside Dragon86 itself, with no sandbox: it can read ` +
      `and write anything in your filesystem, load code from the network, and ` +
      `change or break this page (a reload brings the OS back).\n\n` +
      `Only run scripts you trust. From ${vfs.parentOf(path)}.`,
    true,
    "Run it",
  );
  if (!ok) return;

  let source: string;
  try {
    source = await vfs.readText(path);
  } catch (err) {
    logWarn("script", `could not read ${path}`, err);
    notify({ title: "Script could not be read", body: (err as Error).message, icon: "info" });
    return;
  }

  const api = devApi();
  if (!api) {
    notify({
      title: "The scripting API is not ready",
      body: "Dragon86 is still starting; try again in a moment.",
      icon: "info",
    });
    return;
  }

  /* Replace an earlier run of the same file rather than stacking copies. */
  running.get(path)?.remove();

  const el = document.createElement("script");
  el.dataset.d86Script = path;
  /* The sourceURL makes the file show up with its own name in DevTools, which
     matters the first time a script throws. */
  el.textContent = `${source}\n//# sourceURL=d86-script:${encodeURI(path)}`;
  running.set(path, el);

  api.script.path = path;
  const started = performance.now();
  try {
    document.head.append(el);
    const ms = (performance.now() - started).toFixed(0);
    logInfo("script", `ran ${path} (${ms} ms)`);
    notify({
      title: `${name} ran`,
      body: "It is in the page now. A reload removes whatever it added (files stay).",
      icon: "terminal",
      timeout: 5000,
    });
  } catch (err) {
    logWarn("script", `${path} threw while loading`, err);
    notify({
      title: `${name} threw an error`,
      body: `${(err as Error)?.message ?? String(err)} — see the Dev Console.`,
      icon: "info",
      timeout: 0,
    });
  } finally {
    api.script.path = null;
  }
}

/** True when a path looks like something the menu should offer to run. */
export function isRunnableScript(name: string): boolean {
  return /\.m?js$/i.test(name);
}
