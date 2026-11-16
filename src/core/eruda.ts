/** Local Eruda loader. The vendor bundle and polyfill ship with Dragon86. */

interface ErudaConsole {
  init(options?: Record<string, unknown>): void;
  show(tool?: string): void;
  hide(): void;
  destroy(): void;
  _d86Initialized?: boolean;
}

declare global {
  interface Window { eruda?: ErudaConsole; }
}

let loading: Promise<ErudaConsole> | null = null;

export function loadEruda(): Promise<ErudaConsole> {
  if (window.eruda) return Promise.resolve(window.eruda);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.id = "dragon86-eruda-vendor";
    script.src = `${import.meta.env.BASE_URL}vendor/eruda/eruda.js`;
    script.async = true;
    script.onload = () => window.eruda ? resolve(window.eruda) : reject(new Error("Eruda did not initialize"));
    script.onerror = () => { loading = null; reject(new Error("Could not load Dragon86's local Eruda bundle")); };
    document.head.append(script);
  });
  return loading;
}

export async function startDeveloperConsole(): Promise<void> {
  const eruda = await loadEruda();
  if (!eruda._d86Initialized) {
    eruda.init({ tool: ["console", "elements", "network", "resources", "info"], defaults: { theme: "Dark" } });
    eruda._d86Initialized = true;
  }
  eruda.show();
}

export function stopDeveloperConsole(): void {
  window.eruda?.destroy();
  delete window.eruda;
  document.getElementById("dragon86-eruda-vendor")?.remove();
  loading = null;
}
