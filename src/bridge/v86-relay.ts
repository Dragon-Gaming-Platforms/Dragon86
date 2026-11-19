/**
 * v86's network backend: naming and probing.
 *
 * The NIC is emulated by v86, and DHCP/traffic is answered by the backend
 * behind it — a wsproxy relay, a wisp server, or the in-page stack. If the
 * relay is unreachable the guest still boots, still loads virtio_net and
 * still shows an interface; it just never gets a lease, which is
 * indistinguishable from "networking is broken" without a probe. Hence this.
 */

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
import { SHARED_WISP_V86, SHARED_WISP_WSS } from "../core/settings.ts";

/** Normalize the shared WSS address to v86's explicit secure-Wisp selector. */
export function normalizeV86Relay(raw: string): string {
  const value = (raw || "").trim();
  try {
    const wss = new URL(value.replace(/^wisps:/i, "wss:"));
    if (wss.href === SHARED_WISP_WSS) return SHARED_WISP_V86;
  } catch { /* pass through for the normal validation/probe path */ }
  return value;
}

/** Present the shared endpoint identically in the v86 and Scramjet settings. */
export function displayV86Relay(raw: string): string {
  return normalizeV86Relay(raw) === SHARED_WISP_V86 ? SHARED_WISP_WSS : raw;
}

export interface RelayProbe {
  ok: boolean;
  url: string;
  backend: string;
  message: string;
  ms: number;
}

export function relayBackendName(raw: string): string {
  const v = normalizeV86Relay(raw).toLowerCase();
  if (!v || v === "off" || v === "none") return "off";
  if (v.startsWith("wss://") || v.startsWith("ws://")) return "wsproxy";
  if (v.startsWith("wisps://") || v.startsWith("wisp://")) return "wisp";
  if (v.startsWith("fetch")) return "fetch (in-page)";
  if (v === "inbrowser") return "in-page stack";
  return "unknown";
}

export function probeRelay(rawUrl: string, timeoutMs = 8000): Promise<RelayProbe> {
  const url = (rawUrl || "").trim();
  const relayUrl = normalizeV86Relay(url);
  const started = performance.now();
  const backend = relayBackendName(relayUrl);
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
  const wsUrl = relayUrl.replace(/^wisp:\/\//i, "ws://").replace(/^wisps:\/\//i, "wss://");
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
