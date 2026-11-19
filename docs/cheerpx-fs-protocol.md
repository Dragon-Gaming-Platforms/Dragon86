# DrakeForge ↔ Dragon86 filesystem protocol (fs1, bridge v2)

The built-in DrakeForge launcher opens the deployed
`/DrakeForge/dragon86` route in a separate tab. Each app launch uses a private
BroadcastChannel named `dragon86-drakeforge-<uuid>`. The channel carries the
fs1 workspace bridge between DrakeForge and Dragon86's `/home/user` tree in
ZenFS. It does **not** mount Dragon86's Terminal 9P interface.

The implementation is in `src/bridge/drakeforge-session.ts`,
`src/bridge/fs-bridge.ts`, and the DrakeForge launcher in
`src/apps/iframe-app.ts`.

## Handshake

Dragon86 sends immediately and retries every 400 ms:

```ts
{ v: 1, t: "hello", caps: ["fs1"] }
```

DrakeForge replies with a ready message; fs1 is enabled only when the reply
includes `caps: ["fs1"]`:

```ts
{ v: 1, t: "ready", caps: ["fs1"] }
```

A ready message may omit `via`; v2 filesystem requests must include
`via: "bc-hoster"`. Requests received before fs1 is negotiated get an error
response rather than accessing the filesystem. Dragon86 never initiates fs
requests.

## Messages

Requests (DrakeForge → Dragon86):

```ts
{
  v: 2,
  t: "fs-req",
  via: "bc-hoster",
  id: number, // caller-chosen; echoed in the response
  op: "list" | "tree" | "read" | "write" | "mkdir" | "remove" | "rename" | "stat",
  path?: string, // "/" or "" is the share root (/home/user)
  to?: string,  // rename destination, relative to the same root
  data?: Uint8Array // whole-file write payload
}
```

Responses (Dragon86 → DrakeForge), matched by the request `id`:

```ts
{
  v: 2,
  t: "fs-res",
  id: number,
  ok: boolean,
  error?: string,
  entries?: { name: string, isDir: boolean, size: number, mtime: number }[],
  tree?: { path: string, isDir: boolean, size: number, mtime: number }[],
  data?: Uint8Array,
  stat?: { isDir: boolean, size: number, mtime: number }
}
```

## Limits and safety notes

- Paths use `/` separators and are resolved under `/home/user`; lexical `..`
  traversal outside the share root is rejected.
- `read` and `write` are whole-file operations capped at 16 MiB per message.
  `tree` is capped at 5,000 entries.
- `remove` is recursive for directories but refuses to remove the share root.
  `write` and `rename` create missing parent directories.
- Responses can complete out of order; clients must match them by `id`.
- BroadcastChannel structured-clones `Uint8Array` payloads.
- The per-launch random channel name prevents accidental cross-talk; it is
  **not** authentication or an authorization boundary against malicious
  same-origin scripts. Do not share sensitive data with untrusted same-origin
  code.

## Verification

`npm run build` runs `tools/test-drakeforge-session.mjs`, which exercises the
handshake, request IDs, real fs-bridge reads/writes, and path-escape rejection.
`npm run test:ui` exercises the launcher route, channel naming, fs1 status, and
read/write requests through a fake BroadcastChannel backed by Dragon86's real
ZenFS.
