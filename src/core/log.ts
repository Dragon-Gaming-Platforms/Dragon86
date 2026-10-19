/**
 * Tiny scoped logger for diagnostics.
 *
 * Everything goes through console.* with a `[D86:<scope>]` prefix so it shows
 * up both in real DevTools and in the in-terminal Eruda console. Keep logs
 * terse and rate-limited at call sites — this is for diagnosing the engine
 * handshake, not a firehose.
 */

export type LogScope = "bridge" | "terminal" | "os" | "v86";

function fmt(scope: LogScope, msg: string): string {
  return `[D86:${scope}] ${msg}`;
}

export function logInfo(scope: LogScope, msg: string, ...rest: unknown[]): void {
  console.info(fmt(scope, msg), ...rest);
}

export function logWarn(scope: LogScope, msg: string, ...rest: unknown[]): void {
  console.warn(fmt(scope, msg), ...rest);
}

export function logError(scope: LogScope, msg: string, ...rest: unknown[]): void {
  console.error(fmt(scope, msg), ...rest);
}

/** Snapshot of the isolation facts that decide whether CheerpX can run. */
export function isolationReport(): Record<string, unknown> {
  return {
    origin: window.location.origin,
    crossOriginIsolated: window.crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
    secureContext: window.isSecureContext,
    serviceWorkerController: navigator.serviceWorker?.controller?.scriptURL ?? null,
    userAgent: navigator.userAgent,
  };
}
