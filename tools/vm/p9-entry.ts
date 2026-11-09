/* Bundled for the headless harness only: exports the real 9p server, so the
   VM test exercises src/bridge/p9.ts rather than a stand-in. The union-fs
   exports are for tools/test-p9-symlink.mjs, which drives the *production*
   stack (p9 over unionAsPromises(createDirectFs) over ZenFS) with raw 9p
   frames — the exact combination where guest-created symlinks once failed. */
export { createP9Handler } from "../../src/bridge/p9";
export { createDirectFs, createUnionFs, unionAsPromises, withSubmount } from "../../src/bridge/union-fs";
