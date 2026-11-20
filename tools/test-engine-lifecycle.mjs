#!/usr/bin/env node
/** Regression coverage for the Terminal / Engine Viewer VM ownership rules. */
import { retainEngineForViewer, registerTerminalEngine, releaseTerminalEngine, disposeEngineNow } from "../src/bridge/engine-lifecycle.ts";

let failures = 0;
const check = (name, ok) => {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}`);
  if (!ok) failures++;
};
const backend = () => {
  const machine = { disposals: 0, dispose() { this.disposals++; } };
  return machine;
};

// Terminal closes first: viewer lease keeps the machine alive until its close.
{
  const vm = backend();
  registerTerminalEngine(vm);
  const releaseViewer = retainEngineForViewer(vm);
  releaseTerminalEngine(vm);
  check("Terminal close keeps VM alive while Viewer is open", vm.disposals === 0);
  releaseViewer();
  check("closing last Viewer disposes VM after Terminal", vm.disposals === 1);
  releaseViewer();
  check("Viewer release is idempotent", vm.disposals === 1);
}

// Viewer closes first: the Terminal continues to own the live VM.
{
  const vm = backend();
  registerTerminalEngine(vm);
  const releaseViewer = retainEngineForViewer(vm);
  releaseViewer();
  check("Viewer close keeps VM alive while Terminal is open", vm.disposals === 0);
  releaseTerminalEngine(vm);
  check("Terminal close disposes VM after Viewer", vm.disposals === 1);
}

// Multiple viewers each own their own lease.
{
  const vm = backend();
  registerTerminalEngine(vm);
  const closeA = retainEngineForViewer(vm);
  const closeB = retainEngineForViewer(vm);
  releaseTerminalEngine(vm);
  closeA();
  check("one of multiple viewers cannot dispose the shared VM", vm.disposals === 0);
  closeB();
  check("last of multiple viewers disposes shared VM", vm.disposals === 1);
}

// Reconnect/replacement is an explicit hard stop regardless of viewer leases.
{
  const vm = backend();
  registerTerminalEngine(vm);
  const closeViewer = retainEngineForViewer(vm);
  disposeEngineNow(vm);
  check("explicit reconnect disposes even with Viewer open", vm.disposals === 1);
  releaseTerminalEngine(vm);
  closeViewer();
  check("later window closes do not dispose twice", vm.disposals === 1);
}

// A backend which was never registered retains the historical direct-close behavior.
{
  const vm = backend();
  releaseTerminalEngine(vm);
  check("unregistered backend still disposes on Terminal close", vm.disposals === 1);
}

process.exit(failures ? 1 : 0);
