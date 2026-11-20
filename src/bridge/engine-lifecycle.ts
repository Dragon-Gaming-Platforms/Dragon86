/** Window ownership for a Terminal VM shared with Engine Viewer windows.
 * Closing the Terminal releases its ownership; the backend is disposed only
 * after every viewer has released its lease too. */
import type { TerminalBackend } from "./engine";

type Ownership = {
  terminalOpen: boolean;
  viewers: number;
  disposed: boolean;
};

const ownership = new WeakMap<TerminalBackend, Ownership>();

export function registerTerminalEngine(backend: TerminalBackend): void {
  ownership.set(backend, { terminalOpen: true, viewers: 0, disposed: false });
}

/** An explicit reconnect/replacement stops the old machine immediately. */
export function disposeEngineNow(backend: TerminalBackend): void {
  const state = ownership.get(backend);
  if (state) {
    state.terminalOpen = false;
    state.disposed = true;
  }
  backend.dispose();
}

/** Release the Terminal window's claim; viewers can keep the VM alive. */
export function releaseTerminalEngine(backend: TerminalBackend): void {
  const state = ownership.get(backend);
  if (!state) {
    backend.dispose();
    return;
  }
  if (state.disposed) return;
  state.terminalOpen = false;
  disposeIfUnowned(backend, state);
}

/** Keep a registered Terminal VM alive for one Engine Viewer window. */
export function retainEngineForViewer(backend: TerminalBackend): () => void {
  const state = ownership.get(backend);
  if (!state || state.disposed) return () => {};
  state.viewers++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.viewers = Math.max(0, state.viewers - 1);
    disposeIfUnowned(backend, state);
  };
}

function disposeIfUnowned(backend: TerminalBackend, state: Ownership): void {
  if (state.disposed || state.terminalOpen || state.viewers > 0) return;
  state.disposed = true;
  backend.dispose();
}
