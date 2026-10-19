/**
 * Hoster bridge — the contract between the OS and the CheerpX hoster page.
 *
 * Protocol v1 (postMessage, MessagePort-friendly):
 *   OS  → hoster : { v:1, t: "hello" }                 (repeated until answered)
 *   hoster → OS  : { v:1, t: "ready" }                 (handshake OK, isolated)
 *   OS  → hoster : { v:1, t: "data",   d: string }     (PTY stdin)
 *   hoster → OS  : { v:1, t: "data",   d: string }     (PTY stdout)
 *   OS  → hoster : { v:1, t: "resize", cols, rows }
 *   hoster → OS  : { v:1, t: "exit",   code }
 *
 * v1 ships the skeleton: the iframe is created and the handshake is attempted;
 * until the hoster repo exists it reports "offline".
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
  private timeoutTimer: number | null = null;
  private settled = false;

  constructor(
    private url: string,
    private handlers: BackendHandlers,
  ) {}

  connect(): void {
    this.dispose();
    this.settled = false;

    const iframe = document.createElement("iframe");
    iframe.src = this.url;
    iframe.style.cssText =
      "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;border:0;left:-9999px;";
    iframe.setAttribute("aria-hidden", "true");
    iframe.addEventListener("load", () => this.startHandshake());
    iframe.addEventListener("error", () => this.fail());
    document.body.append(iframe);
    this.iframe = iframe;

    window.addEventListener("message", this.onMessage);
    /* no answer within 6s → offline */
    this.timeoutTimer = window.setTimeout(() => this.fail(), 6000);
  }

  private startHandshake(): void {
    const send = () => {
      this.iframe?.contentWindow?.postMessage({ v: 1, t: "hello" } satisfies BridgeMessage, "*");
    };
    send();
    this.helloTimer = window.setInterval(send, 400);
  }

  private onMessage = (ev: MessageEvent): void => {
    const msg = ev.data as BridgeMessage | null;
    if (!msg || msg.v !== 1) return;
    switch (msg.t) {
      case "ready":
        this.succeed();
        break;
      case "data":
        if (typeof msg.d === "string") this.handlers.onData(msg.d);
        break;
      case "exit":
        this.handlers.onData(`\r\n\x1b[38;2;231;76;60m[process exited: ${msg.code ?? 0}]\x1b[0m\r\n`);
        break;
    }
  };

  private succeed(): void {
    if (this.settled) return;
    this.settled = true;
    this.clearTimers();
    this.handlers.onStatus("ready");
  }

  private fail(): void {
    if (this.settled) return;
    this.settled = true;
    this.clearTimers();
    this.handlers.onStatus("offline");
  }

  write(data: string): void {
    this.iframe?.contentWindow?.postMessage({ v: 1, t: "data", d: data } satisfies BridgeMessage, "*");
  }

  resize(cols: number, rows: number): void {
    this.iframe?.contentWindow?.postMessage(
      { v: 1, t: "resize", cols, rows } satisfies BridgeMessage,
      "*",
    );
  }

  private clearTimers(): void {
    if (this.helloTimer !== null) window.clearInterval(this.helloTimer);
    if (this.timeoutTimer !== null) window.clearTimeout(this.timeoutTimer);
    this.helloTimer = this.timeoutTimer = null;
  }

  dispose(): void {
    this.clearTimers();
    window.removeEventListener("message", this.onMessage);
    this.iframe?.remove();
    this.iframe = null;
    this.settled = true;
  }
}

export function getBackend(url: string, handlers: BackendHandlers): TerminalBackend {
  return new HosterBridge(url, handlers);
}
