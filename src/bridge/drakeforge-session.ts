/**
 * A private-per-launch transport for DrakeForge's existing hello/fs1 wire
 * messages. It is not enabled by the launcher until DrakeForge supports the
 * `channel` URL parameter and uses only the selected transport.
 *
 * Random channel names prevent accidental cross-talk; they are not an
 * authorization boundary against other scripts on the same origin.
 */
import type { FsRequest, FsResponse } from "./fs-bridge";

export const DRAKEFORGE_CONNECTED_URL = "https://dragon-gaming-platforms.github.io/DrakeForge/dragon86";
export const DRAKEFORGE_CHANNEL_PREFIX = "dragon86-drakeforge-";

export function drakeforgeSessionUrl(id: string): URL {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid DrakeForge session ID");
  const url = new URL(DRAKEFORGE_CONNECTED_URL);
  url.searchParams.set("channel", DRAKEFORGE_CHANNEL_PREFIX + id);
  return url;
}

type State = "connecting" | "ready" | "fs1" | "offline";
type Channel = Pick<BroadcastChannel, "postMessage" | "addEventListener" | "removeEventListener" | "close">;

/** The bridge owns its channel and timer; closing the app disposes both. */
export function startDrakeforgeSession(
  channel: Channel,
  respond: (req: FsRequest) => Promise<FsResponse>,
  onState: (state: State) => void,
): () => void {
  let closed = false;
  let ready = false;
  const hello = () => channel.postMessage({ v: 1, t: "hello", caps: ["fs1"] });
  const onMessage = (event: MessageEvent): void => {
    const msg = event.data;
    if (closed || !msg || typeof msg !== "object" || msg.via !== "bc-hoster") return;
    if (msg.v === 2 && msg.t === "fs-req" && Number.isSafeInteger(msg.id) && typeof msg.op === "string") {
      void respond(msg as FsRequest).then((res) => {
        if (!closed) channel.postMessage(res);
      }).catch((error: unknown) => {
        if (!closed) channel.postMessage({ v: 2, t: "fs-res", id: msg.id, ok: false, error: String(error) });
      });
      return;
    }
    if (msg.v !== 1 || msg.t !== "ready") return;
    ready = true;
    const fsLive = Array.isArray(msg.caps) && msg.caps.includes("fs1");
    onState(fsLive ? "fs1" : "ready");
  };
  channel.addEventListener("message", onMessage as EventListener);
  onState("connecting");
  hello();
  // Continue probing after a timeout and after ready: the page may reload and
  // must be able to announce itself again without restarting the app.
  const timer = setInterval(hello, 400);
  const timeout = setTimeout(() => { if (!closed && !ready) onState("offline"); }, 6000);
  return () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    clearTimeout(timeout);
    channel.removeEventListener("message", onMessage as EventListener);
    channel.close();
  };
}
