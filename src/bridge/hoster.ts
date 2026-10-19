/**
 * Hoster bridge — the contract between the OS and the CheerpX hoster page.
 * Protocol v1 (postMessage) — behavior-identical to
 * Dragon-Gaming-Platforms/CheerpX-Bridge `src/bridge/protocol.ts`:
 *
 *   OS  → hoster : { v:1, t: "hello" }                 (repeated until answered)
 *   hoster → OS  : { v:1, t: "ready" }                 (isolated AND bash streaming)
 *   OS  → hoster : { v:1, t: "data",   d: string }     (PTY stdin)
 *   hoster → OS  : { v:1, t: "data",   d: string }     (PTY stdout)
 *   OS  → hoster : { v:1, t: "resize", cols, rows }
 *   hoster → OS  : { v:1, t: "exit",   code }
 *
 * Hardened per the hoster's integration notes:
 *  - The handshake budget RESETS whenever the iframe reloads (the
 *    coi-serviceworker takes control on first visit and reloads the page —
 *    a cold first boot legitimately takes >6 s).
 *  - A timeout reports "offline" but we keep listening: a late `ready`
 *    still brings the terminal up (auto-recovery), no user action needed.
 *  - Inbound messages must come from our iframe and the hoster's origin;
 *    outbound messages are addressed to that origin, never "*".
 */

export type BackendStatus = "ready" | "offline";

export interface TerminalBackend {
  connect(): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
}

export interface BackendHandlers {
  onData: (data: string) => void;
  onStatus: (s: BackendStatus) => void;
}

/** Production hoster (CheerpX-Bridge project site). */
export const DEFAULT_HOSTER_URL =
  "https://dragon-gaming-platforms.github.io/CheerpX-Bridge/";

const PROTOCOL_VERSION = 1;
const HELLO_INTERVAL_MS = 400;
/** Per-load budget: reset on every iframe `load` (see above). */
const LOAD_TIMEOUT_MS = 6_000;
/** Give up on hello entirely after this, but keep listening for `ready`. */
const HELLO_CAP_MS = 60_000;

interface BridgeMessage {
  v: number;
  t: string;
  d?: string;
  cols?: number;
  rows?: number;
  code?: number;
}

class HosterBridge implements TerminalBackend {
  private iframe: HTMLIFrameElement | null = null;
  private helloTimer: number | null = null;
  private loadTimer: number | null = null;
  private helloStopTimer: number | null = null;
  private hostOrigin: string;
  private gotReady = false;
  private reportedOffline = false;
  private listening = false;
  private pendingInput: string[] = [];

  constructor(
    url: string,
    private handlers: BackendHandlers,
  ) {
    this.hostOrigin = new URL(url).origin;
    this.url = url;
  }

  private url: string;

  connect(): void {
    this.teardown();
    this.gotReady = false;
    this.reportedOffline = false;
    this.listening = true;
    this.pendingInput = [];

    const iframe = document.createElement("iframe");
    iframe.src = this.url;
    /* Future-proofing: if the two sites ever end up on different origins,
       the iframe will need this delegation to get SharedArrayBuffer. */
    iframe.allow = "cross-origin-isolated";
    iframe.style.cssText =
      "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;border:0;left:-9999px;";
    iframe.setAttribute("aria-hidden", "true");
    /* The SW installs and reloads this frame once on a cold first visit —
       `load` fires again each time, which resets the handshake budget. */
    iframe.addEventListener("load", () => this.onFrameLoad());
    document.body.append(iframe);
    this.iframe = iframe;

    window.addEventListener("message", this.onMessage);
    this.helloStopTimer = window.setTimeout(() => this.stopHello(), HELLO_CAP_MS);
    /* Start the hello loop immediately (don't wait for `load`) so we reach
       the page the moment it can listen. */
    this.startHello();
    this.armLoadTimer();
  }

  private onFrameLoad(): void {
    if (!this.listening || this.gotReady) return;
    this.armLoadTimer();
    this.startHello();
  }

  private armLoadTimer(): void {
    if (this.loadTimer !== null) window.clearTimeout(this.loadTimer);
    this.loadTimer = window.setTimeout(() => this.reportTimeout(), LOAD_TIMEOUT_MS);
  }

  private startHello(): void {
    if (this.helloTimer !== null || this.gotReady) return;
    const send = () => {
      this.iframe?.contentWindow?.postMessage(
        { v: PROTOCOL_VERSION, t: "hello" } satisfies BridgeMessage,
        this.hostOrigin,
      );
    };
    send();
    this.helloTimer = window.setInterval(send, HELLO_INTERVAL_MS);
  }

  private stopHello(): void {
    if (this.helloTimer !== null) window.clearInterval(this.helloTimer);
    this.helloTimer = null;
    if (this.loadTimer !== null) window.clearTimeout(this.loadTimer);
    this.loadTimer = null;
  }

  private onMessage = (ev: MessageEvent): void => {
    if (!this.listening) return;
    if (ev.source !== this.iframe?.contentWindow) return;
    if (ev.origin !== this.hostOrigin) return;
    const msg = ev.data as BridgeMessage | null;
    if (!msg || msg.v !== PROTOCOL_VERSION) return;
    switch (msg.t) {
      case "ready":
        this.succeed();
        break;
      case "data":
        if (typeof msg.d === "string") this.handlers.onData(msg.d);
        break;
      case "exit":
        this.handlers.onData(
          `\r\n\x1b[38;2;231;76;60m[process exited: ${msg.code ?? 0}]\x1b[0m` +
            `\r\n\x1b[38;2;102;102;102mHit Reconnect to start a new shell.\x1b[0m\r\n`,
        );
        break;
    }
  };

  /** Timeout: report offline, but stay listening — a late `ready` still wins. */
  private reportTimeout(): void {
    if (this.gotReady || this.reportedOffline) return;
    this.reportedOffline = true;
    this.stopHello();
    this.handlers.onStatus("offline");
  }

  private succeed(): void {
    if (this.gotReady) return;
    this.gotReady = true;
    this.stopHello();
    if (this.helloStopTimer !== null) window.clearTimeout(this.helloStopTimer);
    this.helloStopTimer = null;
    /* Flush anything typed while we waited. */
    if (this.pendingInput.length > 0) {
      const d = this.pendingInput.join("");
      this.pendingInput = [];
      this.iframe?.contentWindow?.postMessage(
        { v: PROTOCOL_VERSION, t: "data", d } satisfies BridgeMessage,
        this.hostOrigin,
      );
    }
    this.handlers.onStatus("ready");
  }

  write(data: string): void {
    if (!this.gotReady) {
      this.pendingInput.push(data);
      return;
    }
    this.iframe?.contentWindow?.postMessage(
      { v: PROTOCOL_VERSION, t: "data", d: data } satisfies BridgeMessage,
      this.hostOrigin,
    );
  }

  resize(cols: number, rows: number): void {
    if (!this.iframe) return;
    this.iframe.contentWindow?.postMessage(
      { v: PROTOCOL_VERSION, t: "resize", cols, rows } satisfies BridgeMessage,
      this.hostOrigin,
    );
  }

  private teardown(): void {
    this.stopHello();
    if (this.helloStopTimer !== null) window.clearTimeout(this.helloStopTimer);
    this.helloStopTimer = null;
    window.removeEventListener("message", this.onMessage);
    this.iframe?.remove();
    this.iframe = null;
    this.listening = false;
    this.pendingInput = [];
    this.gotReady = false;
    this.reportedOffline = false;
  }

  dispose(): void {
    this.teardown();
  }
}

export function getBackend(url: string, handlers: BackendHandlers): TerminalBackend {
  return new HosterBridge(url, handlers);
}
