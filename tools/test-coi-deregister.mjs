#!/usr/bin/env node
/**
 * Page-half behaviour test for public/coi-serviceworker.js.
 *
 * The worker is the thing that makes Dragon86 cross-origin isolated — and
 * the thing that must be GONE when the selected engine doesn't need it
 * (v86, separate tab). It used to rely on postMessage to a controller that
 * might already be dead, and its deregister handler wasn't waitUntil()-ed,
 * so v86 could keep running under a live worker and a COOP/COEP document.
 *
 * This runs the real shipped file against stubbed browser APIs and asserts
 * the contract: unregister + exactly one reload when turning isolation off,
 * no reload loop when unregister() itself fails, and never a deregister in
 * embedded mode.
 *
 *   node tools/test-coi-deregister.mjs [path-to-worker.js]
 *
 * No dependencies, no browser — node:vm only.
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SRC = readFileSync(
  process.argv[2] || new URL("../public/coi-serviceworker.js", import.meta.url),
  "utf8",
);

function run({ shouldDeregister, controller = null, regs = [], unregisterFails = false, crossOriginIsolated = false, session = new Map(), coiEnabled = true }) {
  const calls = { unregister: 0, reload: 0, register: 0, postMessage: [], navigations: 0, logs: [] };
  const registrations = regs.map(() => ({
    active: { scriptURL: "https://x/Dragon86/coi-serviceworker.js" },
    unregister() {
      calls.unregister++;
      return unregisterFails ? Promise.reject(new Error("nope")) : Promise.resolve(true);
    },
  }));

  const consoleStub = {
    log: (...a) => calls.logs.push(a.join(" ")),
    warn: (...a) => calls.logs.push("WARN " + a.join(" ")),
    error: (...a) => calls.logs.push("ERR " + a.join(" ")),
  };

  const doc = { currentScript: { src: "https://x/Dragon86/coi-serviceworker.js" } };
  const ctx = {
    console: consoleStub,
    document: doc,
    window: {
      sessionStorage: {
        getItem: (k) => (session.has(k) ? session.get(k) : null),
        setItem: (k, v) => session.set(k, v),
        removeItem: (k) => session.delete(k),
      },
      crossOriginIsolated,
      isSecureContext: true,
      /* public/coi-serviceworker.js reads this master switch; the tests opt
         in so they exercise the logic even though the shipped default is off. */
      D86_COI: coiEnabled,
      document: doc,
      coi: {
        shouldRegister: () => !shouldDeregister,
        shouldDeregister: () => shouldDeregister,
        coepCredentialless: () => false,
        quiet: true,
      },
      location: { reload: () => { calls.reload++; } },
    },
    navigator: {
      serviceWorker: {
        controller: controller ? { scriptURL: "https://x/coi-serviceworker.js", postMessage: (m) => calls.postMessage.push(m) } : null,
        getRegistrations: () => Promise.resolve(registrations),
        register: () => { calls.register++; return Promise.resolve({ active: null, addEventListener() {} }); },
      },
    },
  };
  ctx.window.navigator = ctx.navigator;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return new Promise((res) => setTimeout(() => res({ calls, session }), 40));
}

const results = [];
const check = (name, cond, detail = "") => results.push({ name, ok: !!cond, detail });

/* 1. v86 / tab mode with an active worker: unregister + exactly one reload */
{
  const { calls } = await run({
    shouldDeregister: true,
    controller: {},
    regs: [{}],
    crossOriginIsolated: true,
  });
  check("v86 mode unregisters the worker", calls.unregister === 1, `unregister=${calls.unregister}`);
  check("v86 mode reloads once to drop COOP/COEP", calls.reload === 1, `reload=${calls.reload}`);
  check("v86 mode never re-registers", calls.register === 0, `register=${calls.register}`);
  check("v86 mode sends no stale deregister message", calls.postMessage.length === 0);
}

/* 2. v86 mode where unregister() REJECTS: one reload, then stop (no loop) */
{
  const first = await run({ shouldDeregister: true, controller: {}, regs: [{}], unregisterFails: true, crossOriginIsolated: true });
  const second = await run({ shouldDeregister: true, controller: {}, regs: [{}], unregisterFails: true, crossOriginIsolated: true, session: first.session });
  check("failed unregister still reloads once", first.calls.reload === 1, `reload=${first.calls.reload}`);
  check("failed unregister does not loop on the next load", second.calls.reload === 0, `reload=${second.calls.reload}`);
}

/* 3. v86 mode, already clean: no reload at all */
{
  const { calls } = await run({ shouldDeregister: true, controller: null, regs: [] });
  check("clean v86 load does not reload", calls.reload === 0, `reload=${calls.reload}`);
  check("clean v86 load still unregisters leftovers", calls.unregister === 0, `unregister=${calls.unregister}`);
}

/* 4. embedded mode: registers, never unregisters */
{
  const { calls } = await run({ shouldDeregister: false, controller: null, regs: [] });
  check("embedded mode registers the worker", calls.register === 1, `register=${calls.register}`);
  check("embedded mode does not unregister", calls.unregister === 0);
}

/* 5. embedded mode with a live controller: keeps it, sends coep setting */
{
  const { calls } = await run({ shouldDeregister: false, controller: {}, regs: [{}], crossOriginIsolated: true });
  check("embedded mode leaves the worker alone", calls.unregister === 0, `unregister=${calls.unregister}`);
  check("embedded mode still tells the worker the COEP mode",
    calls.postMessage.some((m) => m.type === "coepCredentialless"), JSON.stringify(calls.postMessage));
}

/* 6. shipped default: the COI half is off, so the worker must stay inert —
   no registration, no unregistration, no reload — because app-sw.js owns the
   scope now. */
{
  const { calls } = await run({ shouldDeregister: false, coiEnabled: false, regs: [{}], controller: {} });
  check("COI disabled: never registers", calls.register === 0, `register=${calls.register}`);
  check("COI disabled: never unregisters", calls.unregister === 0, `unregister=${calls.unregister}`);
  check("COI disabled: never reloads", calls.reload === 0, `reload=${calls.reload}`);
  const tab = await run({ shouldDeregister: true, coiEnabled: false, regs: [{}], controller: {}, crossOriginIsolated: true });
  check("COI disabled: v86 mode leaves other workers alone", tab.calls.unregister === 0, `unregister=${tab.calls.unregister}`);
  check("COI disabled: v86 mode does not reload", tab.calls.reload === 0, `reload=${tab.calls.reload}`);
}

for (const r of results) console.log(`[${r.ok ? "PASS" : "FAIL"}] ${r.name}${r.detail ? "  (" + r.detail + ")" : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
