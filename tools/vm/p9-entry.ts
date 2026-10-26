/* Bundled for the headless harness only: exports the real 9p server, so the
   VM test exercises src/bridge/p9.ts rather than a stand-in. */
export { createP9Handler } from "../../src/bridge/p9";
