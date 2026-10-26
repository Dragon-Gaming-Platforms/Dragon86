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
 * Protocol v2 adds the shared filesystem (capability "fs1"): the OS
 * advertises `caps: ["fs1"]` on hello; a hoster that echoes "fs1" in
 * its ready's caps may then send { v:2, t:"fs-req", … } file requests,
 * served from the OS filesystem (guest /home/user/shared ↔ OS
 * /home/user) and answered with { v:2, t:"fs-res", … }. Spec:
 * docs/cheerpx-fs-protocol.md; server: bridge/fs-bridge.ts. v1 hosters
 * simply never send fs-req, so this is fully backward compatible.
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

import { isolationReport, logError, logInfo, logWarn } from "../core/log";
import * as vfs from "../core/vfs";
import { createFsResponder, type FsRequest } from "./fs-bridge";

export type BackendStatus = "ready" | "offline";

/**
 * What a machine's own display currently shows, one string per text row.
 * Rows may contain ANSI SGR colour escapes (v86 is asked for them), so the
 * reader strips them when it only wants the characters — see
 * apps/engine-viewer.ts.
 */
export interface EngineScreen {
  cols: number;
  rows: number;
  lines: string[];
}

export interface TerminalBackend {
  connect(): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
  /** Tab mode only: (re)open the separate engine tab. */
  openTab?: () => void;
  /** v86 only: snapshot the machine to on-device storage. */
  saveState?: () => Promise<void>;
  /**
   * v86 only: the machine's VGA text screen, as it is right now. This is the
   * display the emulated BIOS and kernel draw on — not the serial console
   * the Terminal shows — which is what the Engine Viewer mirrors.
   */
  getScreen?: () => EngineScreen | null;
  /** v86 "arch" guest only: type the first-run setup into the guest (mount
      /dev, /proc, /sys so a bare `init=/bin/bash` behaves like a real
      system). Explicit user action — nothing is injected behind their back. */
  prepareShell?: () => void;
}

export interface BackendHandlers {
  onData: (data: string) => void;
  onStatus: (s: BackendStatus) => void;
  /** CheerpX only: the hoster confirmed the fs1 shared folder is live. */
  onFsLive?: () => void;
  /** Progress text worth showing in the Terminal (image index, boot steps). */
  onNotice?: (text: string) => void;
}

/** Production hoster (CheerpX-Bridge project site). */
export const DEFAULT_HOSTER_URL =
  "https://dragon-gaming-platforms.github.io/CheerpX-Bridge/";

const PROTOCOL_VERSION = 1;
const HELLO_INTERVAL_MS = 400;
/** Per-load budget: reset on every iframe `load` (see above). */
const LOAD_TIMEOUT_MS = 6_000;
/**
 * Stop hello only after this long. CRITICAL: the hoster answers `hello`
 * with `ready` ONLY once its engine is up (`peerSeen` gate) — if we stop
 * hello-ing before then, `ready` can never arrive and the terminal hangs
 * forever even when the engine boots fine. The 6 s timeout above only
 * reports "still starting"; it must never silence the probe.
 */
const HELLO_CAP_MS = 180_000;

interface BridgeMessage {
  v: number;
  t: string;
  d?: string;
  cols?: number;
  rows?: number;
  code?: number;
  /** Protocol-v2 capability list ("fs1" = shared filesystem). */
  caps?: string[];
}

class HosterBridge implements TerminalBackend {
  private fsRespond = createFsResponder(vfs.HOME);
  private fsLive = false;
  private iframe: HTMLIFrameElement | null = null;
  private helloTimer: number | null = null;
  private loadTimer: number | null = null;
  private helloStopTimer: number | null = null;
  private hostOrigin: string;
  private gotReady = false;
  private reportedOffline = false;
  private listening = false;
  private pendingInput: string[] = [];
  /* --- diagnostics --- */
  private startedAt = 0;
  private helloCount = 0;
  private loadCount = 0;
  private rxCount = 0;
  private ignoredCount = 0;
  private firstDataLogged = false;

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
    this.fsLive = false;
    this.listening = true;
    this.pendingInput = [];
    this.startedAt = performance.now();
    this.helloCount = 0;
    this.loadCount = 0;
    this.rxCount = 0;
    this.ignoredCount = 0;
    this.firstDataLogged = false;

    logInfo("bridge", `connect() → ${this.url}`);
    logInfo("bridge", "OS page environment:", isolationReport());
    logInfo(
      "bridge",
      `hoster origin=${this.hostOrigin} sameOriginAsOS=${this.hostOrigin === window.location.origin}`,
    );
    if (!window.crossOriginIsolated) {
      logWarn(
        "bridge",
        "OS top page is NOT cross-origin isolated. A hidden iframe can only " +
          "get SharedArrayBuffer if the top page is isolated (COOP/COEP) — " +
          "watch the iframe probe below: if the iframe also reports " +
          "crossOriginIsolated=false, the hoster engine never starts and " +
          "no `ready` will ever arrive. That is a COI problem, not a " +
          "handshake-timing problem.",
      );
    }

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
      this.helloCount++;
      try {
        this.iframe?.contentWindow?.postMessage(
          { v: PROTOCOL_VERSION, t: "hello", caps: ["fs1"] } satisfies BridgeMessage,
          this.hostOrigin,
        );
      } catch (err) {
        logError("bridge", "hello postMessage threw:", err);
      }
      if (this.helloCount === 1 || this.helloCount % 25 === 0) {
        logInfo(
          "bridge",
          `hello #${this.helloCount} sent → ${this.hostOrigin} ` +
            `(+${Math.round(performance.now() - this.startedAt)}ms, loads=${this.loadCount}, rx=${this.rxCount})`,
        );
      }
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

  private noteIgnored(reason: string, ev: MessageEvent): void {
    this.ignoredCount++;
    if (this.ignoredCount <= 5) {
      logWarn(
        "bridge",
        `ignored message (${reason}) origin=${ev.origin} data=`,
        ev.data,
      );
    }
  }

  private onMessage = (ev: MessageEvent): void => {
    if (!this.listening) return;
    if (ev.source !== this.iframe?.contentWindow) {
      /* Only whisper about plausible bridge traffic, not every stray post. */
      const d = ev.data as BridgeMessage | null;
      if (d && typeof d === "object" && d.v === PROTOCOL_VERSION) {
        this.noteIgnored("source is not our iframe", ev);
      }
      return;
    }
    if (ev.origin !== this.hostOrigin) {
      this.noteIgnored(`origin ≠ ${this.hostOrigin}`, ev);
      return;
    }
    const raw = ev.data as (BridgeMessage | FsRequest) | null;
    /* Protocol v2 file service: answered from ZenFS, whatever the
       terminal state — the hoster may sync files before bash is up. */
    if (raw && raw.v === 2 && raw.t === "fs-req") {
      void this.fsRespond(raw as FsRequest).then((res) =>
        this.iframe?.contentWindow?.postMessage(res, this.hostOrigin),
      );
      return;
    }
    const msg = raw as BridgeMessage | null;
    if (!msg || msg.v !== PROTOCOL_VERSION) {
      this.noteIgnored("bad/absent protocol version", ev);
      return;
    }
    this.rxCount++;
    switch (msg.t) {
      case "ready":
        logInfo(
          "bridge",
          `← ready received at +${Math.round(performance.now() - this.startedAt)}ms ` +
            `(hellos=${this.helloCount}, loads=${this.loadCount})`,
        );
        if (msg.caps?.includes("fs1")) this.noteFsLive();
        this.succeed();
        break;
      case "data":
        if (typeof msg.d === "string") {
          if (!this.firstDataLogged) {
            this.firstDataLogged = true;
            logInfo("bridge", `← first data chunk (${msg.d.length} chars)`);
          }
          this.handlers.onData(msg.d);
        }
        break;
      case "exit":
        this.handlers.onData(
          `\r\n\x1b[38;2;231;76;60m[process exited: ${msg.code ?? 0}]\x1b[0m` +
            `\r\n\x1b[38;2;102;102;102mHit Reconnect to start a new shell.\x1b[0m\r\n`,
        );
        break;
    }
  };

  private noteFsLive(): void {
    if (this.fsLive) return;
    this.fsLive = true;
    logInfo("bridge", "hoster confirmed fs1: guest /home/user/shared is the OS filesystem");
    this.handlers.onFsLive?.();
  }

  /**
   * Timeout: report "still starting", but KEEP hello-ing — the hoster only
   * announces `ready` in reply to a hello, so silencing the probe here
   * would guarantee a hang even when the engine boots successfully.
   * A late `ready` still wins (auto-recovery).
   */
  private reportTimeout(): void {
    if (this.gotReady || this.reportedOffline) return;
    this.reportedOffline = true;
    logWarn(
      "bridge",
      `${LOAD_TIMEOUT_MS}ms elapsed with no ready. hellos=${this.helloCount} ` +
        `loads=${this.loadCount} rx=${this.rxCount} ignored=${this.ignoredCount}. ` +
        "Still probing — a late ready will recover automatically.",
    );
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

/* ------------------------------------------------------------------ */
/* Separate-tab backend                                                */
/*                                                                     */
/* The hoster runs as its own top-level browser tab (where it isolates  */
/* itself — Dragon86 doesn't need to). Same protocol v1 messages, but   */
/* carried over a BroadcastChannel instead of parent↔iframe             */
/* postMessage: BroadcastChannel reaches same-origin tabs regardless    */
/* of COOP context groups (window.opener is severed by the hoster's     */
/* COOP, so direct postMessage between the tabs is NOT available).      */
/* The engine tab keeps zero terminal UI — the hoster's status page is  */
/* all that renders there; xterm stays here in Dragon86.                */
/*                                                                     */
/* REQUIRES the hoster to listen on this channel too (CheerpX-Bridge    */
/* task; see README). Until it does, hello goes unanswered and this     */
/* behaves exactly like a hoster that never boots.                      */
/* ------------------------------------------------------------------ */

export const HOSTER_CHANNEL = "dragon86-hoster-v1";

class TabHosterBridge implements TerminalBackend {
  private fsRespond = createFsResponder(vfs.HOME);
  private fsLive = false;
  private channel: BroadcastChannel | null = null;
  private tab: Window | null = null;
  private helloTimer: number | null = null;
  private loadTimer: number | null = null;
  private helloStopTimer: number | null = null;
  private gotReady = false;
  private reportedOffline = false;
  private listening = false;
  private pendingInput: string[] = [];
  private url: string;

  constructor(
    url: string,
    private handlers: BackendHandlers,
  ) {
    this.url = url;
  }

  connect(): void {
    this.teardownChannel();
    this.gotReady = false;
    this.reportedOffline = false;
    this.fsLive = false;
    this.listening = true;
    this.pendingInput = [];

    logInfo("bridge", `tab-mode connect() → engine tab: ${this.url}`);
    logInfo(
      "bridge",
      `BroadcastChannel "${HOSTER_CHANNEL}" (same-origin tabs only; ` +
        `OS origin=${window.location.origin}, OS isolated=${window.crossOriginIsolated} — isolation NOT required in tab mode)`,
    );

    this.channel = new BroadcastChannel(HOSTER_CHANNEL);
    this.channel.addEventListener("message", this.onChannelMessage);
    this.openTab();

    this.helloStopTimer = window.setTimeout(() => {
      logError("bridge", "tab-mode: HELLO_CAP reached — no answer on channel.");
      this.stopHello();
    }, HELLO_CAP_MS);
    this.startHello();
    this.armLoadTimer();
  }

  openTab(): void {
    if (this.tab && !this.tab.closed) {
      this.tab.focus();
      return;
    }
    this.tab = window.open(this.url, "_blank");
    if (!this.tab) {
      logWarn(
        "bridge",
        "tab-mode: window.open was blocked — use the 'Open Engine Tab' button (a direct click always works).",
      );
    } else {
      logInfo("bridge", "tab-mode: engine tab opened.");
    }
  }

  private startHello(): void {
    if (this.helloTimer !== null || this.gotReady) return;
    const send = () => {
      if (this.tab && this.tab.closed) {
        logWarn("bridge", "tab-mode: engine tab was closed — reopen it to reconnect.");
        this.tab = null;
      }
      this.channel?.postMessage({
        v: PROTOCOL_VERSION,
        t: "hello",
        caps: ["fs1"],
      } satisfies BridgeMessage);
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

  private armLoadTimer(): void {
    if (this.loadTimer !== null) window.clearTimeout(this.loadTimer);
    this.loadTimer = window.setTimeout(() => {
      if (this.gotReady || this.reportedOffline) return;
      this.reportedOffline = true;
      logWarn(
        "bridge",
        "tab-mode: no ready on BroadcastChannel yet. Either the engine tab " +
          "is still booting, it was closed/blocked, or the hoster doesn't " +
          "listen on the channel yet (CheerpX-Bridge update pending).",
      );
      this.handlers.onStatus("offline");
    }, LOAD_TIMEOUT_MS);
  }

  private onChannelMessage = (ev: MessageEvent): void => {
    if (!this.listening) return;
    const raw = ev.data as (BridgeMessage | FsRequest) | null;
    /* Protocol v2 file service (see HosterBridge). */
    if (raw && raw.v === 2 && raw.t === "fs-req") {
      void this.fsRespond(raw as FsRequest).then((res) => this.channel?.postMessage(res));
      return;
    }
    const msg = raw as BridgeMessage | null;
    if (!msg || msg.v !== PROTOCOL_VERSION) return;
    switch (msg.t) {
      case "ready":
        logInfo("bridge", "tab-mode: ← ready received over BroadcastChannel");
        if (msg.caps?.includes("fs1") && !this.fsLive) {
          this.fsLive = true;
          logInfo("bridge", "tab-mode: hoster confirmed fs1: guest /home/user/shared is the OS filesystem");
          this.handlers.onFsLive?.();
        }
        this.succeed();
        break;
      case "data":
        if (typeof msg.d === "string") this.handlers.onData(msg.d);
        break;
      case "exit":
        logInfo("bridge", `tab-mode: ← exit code=${msg.code ?? 0}`);
        this.handlers.onData(
          `\r\n\x1b[38;2;231;76;60m[process exited: ${msg.code ?? 0}]\x1b[0m` +
            `\r\n\x1b[38;2;102;102;102mHit Reconnect to start a new shell.\x1b[0m\r\n`,
        );
        break;
    }
  };

  private succeed(): void {
    if (this.gotReady) return;
    this.gotReady = true;
    this.stopHello();
    if (this.helloStopTimer !== null) window.clearTimeout(this.helloStopTimer);
    this.helloStopTimer = null;
    if (this.pendingInput.length > 0) {
      const d = this.pendingInput.join("");
      this.pendingInput = [];
      this.channel?.postMessage({ v: PROTOCOL_VERSION, t: "data", d } satisfies BridgeMessage);
    }
    this.handlers.onStatus("ready");
  }

  write(data: string): void {
    if (!this.gotReady) {
      this.pendingInput.push(data);
      return;
    }
    this.channel?.postMessage({ v: PROTOCOL_VERSION, t: "data", d: data } satisfies BridgeMessage);
  }

  resize(cols: number, rows: number): void {
    this.channel?.postMessage({
      v: PROTOCOL_VERSION,
      t: "resize",
      cols,
      rows,
    } satisfies BridgeMessage);
  }

  private teardownChannel(): void {
    this.stopHello();
    if (this.helloStopTimer !== null) window.clearTimeout(this.helloStopTimer);
    this.helloStopTimer = null;
    this.channel?.removeEventListener("message", this.onChannelMessage);
    this.channel?.close();
    this.channel = null;
    this.listening = false;
    this.pendingInput = [];
    this.gotReady = false;
    this.reportedOffline = false;
  }

  dispose(): void {
    logInfo("bridge", "tab-mode: dispose() (engine tab left open for reuse)");
    this.teardownChannel();
    /* Deliberately NOT closing the engine tab: it's fast to reuse, and
       closing tabs the user can see is rude. It closes with the browser. */
  }
}

export function getTabBackend(url: string, handlers: BackendHandlers): TerminalBackend {
  return new TabHosterBridge(url, handlers);
}
