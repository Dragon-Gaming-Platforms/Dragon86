/**
 * Who may read which file through the `9pf/@open/` route.
 *
 * `/9pf/@open/<absolute path>` hands the page any file the OS can reach, so
 * it is the one route that can leave an app's own folder. The rules:
 *
 *   - the OS itself (Files, Preview, the viewer) and apps that are NOT
 *     folder-isolated may read anything under the home folder or /tmp;
 *   - a folder-isolated app may read files inside its own folder, plus the
 *     exact files the OS granted it with `?file=` when it was opened (for
 *     example a .jar handed to CheerpJ);
 *   - a request whose requester cannot be identified is refused.
 *
 * This module is pure (no DOM, no ZenFS) so tools/test-fs-access.mjs can run
 * the policy directly. The service worker supplies the requester; the page
 * holds the app registry and decides.
 */

/** Resolve `rel` against `dir`, honouring `.` and `..`. Null if it escapes `/`. */
export function resolvePath(dir: string, rel: string): string | null {
  const parts = dir.split("/").filter(Boolean);
  for (const seg of rel.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return null;
      parts.pop();
      continue;
    }
    if (seg.includes("\0")) return null;
    parts.push(seg);
  }
  return `/${parts.join("/")}`;
}

/** True when `path` is `root` or lies beneath it. Both must be normalized. */
export function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
}

export type Requester =
  | { kind: "os" }
  | { kind: "unknown" }
  | { kind: "app"; id: string };

/** Parse the service worker's requester tag: "os", "unknown" or "app:<id>". */
export function parseRequester(tag: unknown): Requester {
  if (typeof tag !== "string") return { kind: "unknown" };
  if (tag === "os") return { kind: "os" };
  if (tag.startsWith("app:") && tag.length > 4) return { kind: "app", id: tag.slice(4) };
  return { kind: "unknown" };
}

/* Files the OS has handed to a specific app with `?file=`. Session-only:
   nothing is written to disk. Bounded so a long session cannot grow it
   without limit. */
const MAX_GRANTS_PER_APP = 64;
const grants = new Map<string, string[]>();

/** Record that the OS handed `path` to app `appId`. */
export function grantFile(appId: string, path: string): void {
  const norm = resolvePath("/", path);
  if (!norm) return;
  const list = (grants.get(appId) ?? []).filter((p) => p !== norm);
  list.push(norm);
  if (list.length > MAX_GRANTS_PER_APP) list.splice(0, list.length - MAX_GRANTS_PER_APP);
  grants.set(appId, list);
}

/** Whether the OS has handed `path` to app `appId`. */
export function isGranted(appId: string, path: string): boolean {
  return (grants.get(appId) ?? []).includes(path);
}

export interface AppRef {
  id: string;
  dir: string;
  isolated: boolean;
}

export type OpenDecision = { ok: true; path: string } | { ok: false; status: number; error: string };

/**
 * Decide whether `rawPath` may be read for `requester`. `rawPath` must already
 * be URL-decoded once (the service worker does that). `app` is the registered
 * app for an app requester, or undefined when it is not registered.
 */
export function decideOpenRead(input: {
  rawPath: string;
  home: string;
  requester: Requester;
  app?: AppRef;
}): OpenDecision {
  const { rawPath, home, requester, app } = input;
  if (!rawPath || rawPath.includes("\0")) {
    return { ok: false, status: 400, error: "no file was named" };
  }
  /* Normalize BEFORE any prefix check: "/home/user/../../etc/passwd" starts
     with the home folder as a string, but it is not inside it. */
  const path = resolvePath("/", rawPath.startsWith("/") ? rawPath : `/${rawPath}`);
  if (!path) return { ok: false, status: 403, error: `"${rawPath}" is outside your home folder` };

  if (requester.kind === "unknown") {
    return { ok: false, status: 403, error: "the OS cannot tell which app asked for this file" };
  }

  const shared = [home, "/tmp"];
  if (requester.kind === "os") {
    return within(path, home) || within(path, "/tmp")
      ? { ok: true, path }
      : { ok: false, status: 403, error: `"${path}" is outside your home folder` };
  }

  if (!app || app.id !== requester.id) {
    return { ok: false, status: 403, error: `no filesystem app called "${requester.id}"` };
  }
  if (app.isolated) {
    const dir = resolvePath("/", app.dir) ?? app.dir;
    if (within(path, dir) || isGranted(app.id, path)) return { ok: true, path };
    return {
      ok: false,
      status: 403,
      error: `${app.id} is folder-isolated: "${path}" is outside its folder`,
    };
  }
  return shared.some((root) => within(path, root))
    ? { ok: true, path }
    : { ok: false, status: 403, error: `"${path}" is outside the OS home` };
}
