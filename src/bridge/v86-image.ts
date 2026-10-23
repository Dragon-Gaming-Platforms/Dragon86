/**
 * Full-Arch image store: probing and boot configuration.
 *
 * copy/v86's Arch demo has no disk image. It boots `root=host9p` and v86
 * serves the entire root filesystem over 9p from a flat, content-addressed
 * HTTP store: `fs.json` (the directory tree) plus `arch/<sha256-prefix>.bin`
 * blobs, fetched lazily as the guest touches them.
 *
 * Those files live on a different origin (`i.copy.sh`). It does allow CORS
 * (`Access-Control-Allow-Origin: *`) but it requires a `Referer` header and
 * will refuse the connection without one, which is how Safari ends up with a
 * bare failure. The loader therefore sends `referrerPolicy: "origin"` (see
 * CROSS_ORIGIN in image-store.ts), serves the file list from our own origin
 * instead of asking for it, and can retry contents against a mirror.
 * `probeImage()` reports all of that precisely on the device instead of
 * leaving the user with an emulator that never boots.
 */

export const DEFAULT_IMAGE_BASE = "https://i.copy.sh/";

/* "Is this a blob name?" has one definition, in image-store.ts. Three copies
   of that regex drifted apart once already, and a pinned prefix length made
   the whole image look like symlinks. */

/** Accept `i.copy.sh`, `https://i.copy.sh`, `https://host/x/` alike. */
export function normalizeImageBase(raw: string): string {
  let s = (raw || DEFAULT_IMAGE_BASE).trim();
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  if (!s.endsWith("/")) s += "/";
  return s;
}

export interface ImageProbe {
  ok: boolean;
  base: string;
  fsStatus: number | null;
  fsBytes: number | null;
  blobs: number | null;
  blobStatus: number | null;
  cors: boolean;
  message: string;
}

import { isBlobName } from "./image-store";

/** Collect every blob filename referenced by an fs.json tree. */
function collectBlobs(node: unknown, out: Set<string>): void {
  if (!Array.isArray(node) || node.length === 0 || typeof node[0] !== "string") return;
  // [name, size, mtime, mode, uid, gid, last] — upstream trims trailing nulls
  if (node.length < 7) return;
  const last = node[6];
  if (typeof last === "string") {
    if (isBlobName(last)) out.add(last);
  } else if (Array.isArray(last)) {
    for (const child of last) collectBlobs(child, out);
  }
}

/**
 * Fetch fs.json (and the first blob) from an image store and report exactly
 * what happened. Safe to run from the OS page: read-only, no emulator.
 */
export async function probeImage(baseRaw: string, mirrorBase = ""): Promise<ImageProbe> {
  const base = normalizeImageBase(baseRaw);
  const result: ImageProbe = {
    ok: false,
    base,
    fsStatus: null,
    fsBytes: null,
    blobs: null,
    blobStatus: null,
    cors: true,
    message: "",
  };

  let text: string;
  try {
    /* Same referrer demand as the real loader — see CROSS_ORIGIN in
       image-store.ts. A Test button that succeeds where the engine fails
       would be worse than no Test button. */
    const res = await fetch(`${base}fs.json`, { cache: "no-store", referrerPolicy: "origin" });
    result.fsStatus = res.status;
    if (!res.ok) {
      result.message =
        res.status === 404
          ? `${base}fs.json returned 404 — this image base has no fs.json.`
          : `${base}fs.json returned HTTP ${res.status}.`;
      return result;
    }
    text = await res.text();
    result.fsBytes = text.length;
  } catch (err) {
    /* A CORS rejection and an offline browser both surface as TypeError
       with an opaque message; the browser console has the real reason. */
    result.cors = false;
    result.message =
      `could not fetch ${base}fs.json (${(err as Error).message}). ` +
      `Either the browser is offline, or that origin refuses cross-origin ` +
      `requests (CORS). Open DevTools → Console: a red CORS line confirms it. ` +
      `Workaround: point Settings -> v86 image -> Image mirror at a copy of ` +
      `this image on GitHub Pages (tools/arch-image/ builds one).`;
    return result;
  }

  let tree: unknown;
  try {
    tree = JSON.parse(text);
  } catch {
    result.message = `${base}fs.json is not valid JSON.`;
    return result;
  }

  const blobs = new Set<string>();
  collectBlobs(tree, blobs);
  result.blobs = blobs.size;
  if (blobs.size === 0) {
    result.message = `${base}fs.json parsed but references no blobs — wrong file?`;
    return result;
  }

  const sample = [...blobs][0]!;
  /* Report the mirror too: it is where blobs come from in practice, and a
     probe that only tests the origin would call a working setup broken. */
  const mirror = (mirrorBase || "").trim();
  try {
    const res = await fetch(`${base}arch/${sample}`, {
      headers: { Range: "bytes=0-1023" },
      cache: "no-store",
      referrerPolicy: "origin",
    });
    result.blobStatus = res.status;
    if (res.ok || res.status === 206) {
      result.ok = true;
      result.message =
        `image store OK — fs.json ${(result.fsBytes! / 1024).toFixed(0)} KB, ` +
        `${blobs.size} blobs, sample blob fetched (HTTP ${res.status}).`;
    } else if (mirror) {
      /* The origin refusing is expected (it only answers copy.sh's referer);
         what matters is whether the mirror serves this file. */
      const alt = `${normalizeImageBase(mirror)}arch/${sample}`;
      try {
        const m = await fetch(alt, { headers: { Range: "bytes=0-1023" }, cache: "no-store", ...{} });
        result.blobStatus = m.status;
        if (m.ok || m.status === 206) {
          result.ok = true;
          result.message =
            `origin refuses blobs (HTTP ${res.status}, a referer allowlist) but the mirror serves them — ` +
            `sample blob HTTP ${m.status} from ${normalizeImageBase(mirror)}. Full Arch will boot.`;
          return result;
        }
        result.message = `sample blob HTTP ${res.status} from the origin and HTTP ${m.status} from the mirror.`;
      } catch (err) {
        result.message = `sample blob HTTP ${res.status} from the origin; the mirror failed too (${(err as Error).message}).`;
      }
    } else {
      result.message = `fs.json is fine but arch/${sample} returned HTTP ${res.status}.`;
    }
  } catch (err) {
    result.cors = false;
    result.message = `blob fetch blocked (${(err as Error).message}) — likely CORS.`;
  }
  return result;
}

/* ---------- network backend probe ---------- */

/**
 * Check that a relay URL is usable from THIS browser.
 *
 * v86's network backend lives entirely outside the guest: the NIC is
 * emulated, and DHCP/traffic is answered by the backend behind it. If the
 * relay is unreachable the guest still boots, still loads virtio_net, and
 * still shows an interface — it just never gets a lease. That failure is
 * indistinguishable from "networking is broken" without a probe, so this
 * opens the socket the emulator would open and reports the outcome.
 */
export interface RelayProbe {
  ok: boolean;
  url: string;
  backend: string;
  message: string;
  ms: number;
}

export function relayBackendName(raw: string): string {
  const v = (raw || "").trim().toLowerCase();
  if (!v || v === "off" || v === "none") return "off";
  if (v.startsWith("wss://") || v.startsWith("ws://")) return "wsproxy";
  if (v.startsWith("wisps://") || v.startsWith("wisp://")) return "wisp";
  if (v.startsWith("fetch")) return "fetch (in-page)";
  if (v === "inbrowser") return "in-page stack";
  return "unknown";
}

export function probeRelay(rawUrl: string, timeoutMs = 8000): Promise<RelayProbe> {
  const url = (rawUrl || "").trim();
  const started = performance.now();
  const backend = relayBackendName(url);
  const base = { url, backend };

  if (backend === "off") {
    return Promise.resolve({
      ...base,
      ok: false,
      ms: 0,
      message: "Network is off: the guest gets loopback only. Set a relay URL to give it a NIC.",
    });
  }
  if (backend === "fetch (in-page)" || backend === "in-page stack") {
    return Promise.resolve({
      ...base,
      ok: true,
      ms: 0,
      message:
        "In-page backend: no server needed, DHCP is answered by v86 itself. " +
        "Only traffic the browser is allowed to make will get through (CORS applies).",
    });
  }

  /* wisp:// is just ws:// with a different upgrade path. */
  const wsUrl = url.replace(/^wisp:\/\//i, "ws://").replace(/^wisps:\/\//i, "wss://");
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean, message: string) => {
      if (settled) return;
      settled = true;
      resolve({ ...base, ok, ms: Math.round(performance.now() - started), message });
    };
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      finish(false, `could not even open a socket to ${wsUrl}: ${(err as Error).message}`);
      return;
    }
    const timer = setTimeout(
      () => finish(false, `${wsUrl} did not answer within ${timeoutMs} ms — the relay is unreachable or blocked.`),
      timeoutMs,
    );
    ws.onopen = () => {
      clearTimeout(timer);
      finish(true, `relay reachable (${backend}) — v86 will answer DHCP and pass traffic through it.`);
      try { ws.close(); } catch { /* ignore */ }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      finish(false, `${wsUrl} refused the connection — wrong URL, offline, or blocked by the network.`);
    };
  });
}
