/**
 * fs-bridge — Dragon86's filesystem served to the CheerpX hoster.
 *
 * This is the CheerpX counterpart of p9.ts. v86 can take a raw 9p
 * server over its virtio channel; CheerpX can't (its filesystem
 * devices are fixed: DataDevice = JS writes / guest reads, IDBDevice =
 * guest read-write / JS reads back). So for CheerpX the wire is the
 * hoster bridge itself: protocol v2 `fs-req`/`fs-res` messages, served
 * here directly from ZenFS. The guest-visible root ("/" in fs-req
 * paths) is the OS home (/home/user); the hoster mounts it at
 * /home/user/shared in the guest. See docs/cheerpx-fs-protocol.md.
 *
 * File-level, not byte-range: CheerpX's JS-facing device APIs are
 * whole-file (writeFile / readFileAsBlob), so the protocol is too.
 * Stateful handles would buy nothing here.
 */

import { fs } from "@zenfs/core";
import { logInfo } from "../core/log";

type Promises = typeof fs.promises;

export interface FsEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

export interface FsStat {
  isDir: boolean;
  size: number;
  mtime: number;
}

export type FsRequest = {
  v: 2;
  t: "fs-req";
  id: number;
  op: "list" | "tree" | "read" | "write" | "mkdir" | "remove" | "rename" | "stat";
  /** Guest-view path, "/" = share root. */
  path?: string;
  /** rename destination, same view. */
  to?: string;
  /** write payload (structured-cloneable). */
  data?: Uint8Array;
};

export type FsResponse = {
  v: 2;
  t: "fs-res";
  id: number;
  ok: boolean;
  error?: string;
  entries?: FsEntry[];
  /** tree op: paths relative to the share root, "/" separators. */
  tree?: { path: string; isDir: boolean; size: number; mtime: number }[];
  data?: Uint8Array;
  stat?: FsStat;
};

/** Whole-file cap: fs messages ride postMessage; keep them sane. */
const MAX_FILE = 16 * 1024 * 1024;
const MAX_TREE = 5000;

export function createFsResponder(
  root: string,
  fsImpl: Promises = fs.promises,
): (msg: FsRequest) => Promise<FsResponse> {
  /** Resolve a guest-view path under root; null = escape attempt. */
  const resolve = (p: string | undefined): string | null => {
    const parts: string[] = [];
    for (const seg of (p ?? "/").split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") {
        if (parts.length === 0) return null;
        parts.pop();
      } else parts.push(seg);
    }
    return parts.length === 0 ? root : `${root}/${parts.join("/")}`;
  };

  const statOf = async (path: string): Promise<FsStat> => {
    const st = await fsImpl.stat(path);
    return { isDir: st.isDirectory(), size: st.size, mtime: st.mtimeMs };
  };

  let logged = false;

  return async (msg: FsRequest): Promise<FsResponse> => {
    const res: FsResponse = { v: 2, t: "fs-res", id: msg.id, ok: false };
    try {
      const path = resolve(msg.path);
      if (path === null) throw new Error("path escapes share root");
      switch (msg.op) {
        case "list": {
          const names = (await fsImpl.readdir(path)) as unknown as string[];
          const entries: FsEntry[] = [];
          for (const name of names) {
            try {
              const s = await statOf(`${path}/${name}`);
              entries.push({ name, ...s });
            } catch {
              /* vanished mid-list — skip */
            }
          }
          entries.sort((a, b) =>
            a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1,
          );
          res.entries = entries;
          break;
        }
        case "tree": {
          const out: NonNullable<FsResponse["tree"]> = [];
          const walk = async (dir: string, rel: string): Promise<void> => {
            if (out.length >= MAX_TREE) return;
            const names = (await fsImpl.readdir(dir)) as unknown as string[];
            for (const name of names) {
              if (out.length >= MAX_TREE) return;
              const full = `${dir}/${name}`;
              const r = rel ? `${rel}/${name}` : name;
              try {
                const s = await statOf(full);
                out.push({ path: r, ...s });
                if (s.isDir) await walk(full, r);
              } catch {
                /* skip vanished */
              }
            }
          };
          await walk(path, "");
          res.tree = out;
          break;
        }
        case "read": {
          const s = await statOf(path);
          if (s.isDir) throw new Error("EISDIR");
          if (s.size > MAX_FILE) throw new Error(`file too large for fs bridge (${s.size} bytes)`);
          const data = (await fsImpl.readFile(path)) as unknown as Uint8Array;
          res.data = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
          break;
        }
        case "write": {
          if (!msg.data) throw new Error("write without data");
          if (msg.data.byteLength > MAX_FILE) throw new Error("write too large for fs bridge");
          const parent = path.slice(0, path.lastIndexOf("/")) || "/";
          await fsImpl.mkdir(parent, { recursive: true });
          await fsImpl.writeFile(path, msg.data as never);
          res.stat = await statOf(path);
          break;
        }
        case "mkdir":
          await fsImpl.mkdir(path, { recursive: true });
          res.stat = await statOf(path);
          break;
        case "remove": {
          if (path === root) throw new Error("refusing to remove share root");
          const s = await statOf(path);
          if (s.isDir) await fsImpl.rm(path, { recursive: true, force: true });
          else await fsImpl.unlink(path);
          break;
        }
        case "rename": {
          const to = resolve(msg.to);
          if (to === null || to === root) throw new Error("bad rename destination");
          const parent = to.slice(0, to.lastIndexOf("/")) || "/";
          await fsImpl.mkdir(parent, { recursive: true });
          await fsImpl.rename(path, to);
          res.stat = await statOf(to);
          break;
        }
        case "stat":
          res.stat = await statOf(path);
          break;
        default:
          throw new Error(`unknown fs op: ${String((msg as FsRequest).op)}`);
      }
      res.ok = true;
      if (!logged) {
        logged = true;
        logInfo("bridge", `fs1 share live: CheerpX /home/user/shared ↔ OS ${root} (protocol v2)`);
      }
    } catch (err) {
      const e = err as { code?: string; message?: string };
      res.error = e.code ?? e.message ?? String(err);
    }
    return res;
  };
}
