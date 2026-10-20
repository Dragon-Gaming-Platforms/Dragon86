# CheerpX ↔ Dragon86 filesystem protocol ("fs1", bridge protocol v2)

Goal: the CheerpX guest's `/home/user/shared` **is** the Dragon86 OS
filesystem (`/home/user` in ZenFS) — the same arrangement the v86
engine already has via 9p (guest `/shared` ↔ OS `/home/user`, live
both ways, including creates/deletes/renames).

CheerpX can't take a 9p-style server: its JS-facing filesystem
devices are fixed (per LeaningTech's filesystem guide):

| Device | JS side | Guest side |
| --- | --- | --- |
| `DataDevice` | `writeFile(path, data)` | read-only |
| `IDBDevice` (dir-mounted) | `readFileAsBlob(path)` | read-write, persistent |
| `WebDevice` | — (HTTP) | read-only |

So the wire between Dragon86 and the CheerpX-Bridge hoster is the
bridge message channel itself. Dragon86's side is implemented in
`src/bridge/fs-bridge.ts` and wired into both transports in
`src/bridge/hoster.ts` (embedded iframe postMessage and tab-mode
BroadcastChannel). **This document is the contract for the hoster
side.**

## Negotiation

- Every OS `hello` now carries `caps: ["fs1"]`:
  `{ v: 1, t: "hello", caps: ["fs1"] }`
- A hoster that implements this spec includes `"fs1"` in the caps of
  its `ready`: `{ v: 1, t: "ready", caps: ["fs1"] }`.
- That echo is the only gate. Dragon86 answers `fs-req` messages from
  the hoster whenever they arrive, and never initiates fs messages.
- A v1 hoster (no caps echo) behaves exactly as before.

## Messages

Requests (hoster → OS):

```ts
{ v: 2, t: "fs-req", id: number,            // id: caller-chosen, echoed back
  op: "list" | "tree" | "read" | "write" | "mkdir" | "remove" | "rename" | "stat",
  path?: string,     // guest-view path; "/" or "" = share root (OS /home/user)
  to?: string,       // rename destination, same view
  data?: Uint8Array  // write payload
}
```

Responses (OS → hoster), exactly one per request:

```ts
{ v: 2, t: "fs-res", id, ok: boolean,
  error?: string,                         // errno-ish ("ENOENT", …) or message
  entries?: { name, isDir, size, mtime }[],   // list
  tree?: { path, isDir, size, mtime }[],      // tree: recursive, root-relative
  data?: Uint8Array,                          // read
  stat?: { isDir, size, mtime } }
```

Rules:

- Paths are relative to the share root with `/` separators. `..`
  that would escape the root is rejected; the OS never serves
  anything outside `/home/user`.
- `read`/`write` are whole-file, capped at 16 MB per message
  (larger files return an error). `tree` is capped at 5000 entries.
- `remove` deletes files and (recursively) directories. Removing the
  root is refused.
- `write` and `rename` create missing parent directories.
- Messages ride the existing transports (iframe postMessage to the
  hoster origin / the `dragon86-hoster-v1` BroadcastChannel), so
  `Uint8Array` payloads work via structured clone.
- Requests may be answered out of order; match on `id`.

## Suggested hoster-side implementation

The OS side is deliberately a stateless file server (poll `tree`,
diff by `path`+`size`+`mtime` — same pattern an rsync would use).
What the hoster does inside CheerpX is its own choice; two shapes
fit the public device APIs:

**Option A (preferred if it works): one folder, IDBDevice + agent**

1. Mount an `IDBDevice` (`create("dragon86-shared")`) at
   `/home/user/shared` — guest read-write, persistent.
2. guest→OS: a tiny guest-side agent (started by the hoster)
   periodically writes a manifest (path/size/mtime per file) *into
   the shared folder itself*; the hoster polls it with
   `readFileAsBlob`, diffs, reads changed files the same way, and
   forwards `write`/`remove`/`rename` fs-reqs to Dragon86.
3. OS→guest: reverse channel — the hoster places changed OS files
   plus a plan file into a `DataDevice` inbox mount; the agent
   applies them into the shared folder and notes what it applied in
   the manifest. (Verify: does `DataDevice.writeFile` overwrite an
   existing file? Does `cx.run` a background agent disturb the
   interactive console? Test in the hoster.)
4. Exclude the manifest/plan files themselves from syncing.

**Option B (fallback): one-way live view**

Mount a `DataDevice` at `/home/user/shared` and mirror the OS into
it (`tree` + `read` on changes). Guest reads OS files live; guest
writes to that mount fail (device is guest-read-only), and
deleted-on-OS files linger in the in-memory device until restart.
Simple, robust, honest subset — ship it only if A proves flaky, and
say so in the terminal banner text.

Whichever option: echo `caps: ["fs1"]` only when the guest folder is
actually mounted and mirroring, so Dragon86's "Shared folder live"
notice never lies.

## Testing (hoster side)

1. OS Files has `hello.txt`; boot hoster; in guest:
   `cat /home/user/shared/hello.txt` → contents.
2. In guest: `echo guest > /home/user/shared/from-guest.txt` → the
   file appears in Dragon86 Files (Option A only).
3. Delete it in Dragon86 Files → disappears in guest (A; B: after
   restart).
4. Restart both sides → shared folder content persists.
