/**
 * Per-iframe Dragon86 API. The OS's window.d86 API is intentionally powerful;
 * this adapter adds picker-backed file access and controls for the Dragon86
 * window that owns the app. It is available in same-origin app frames as both
 * `window.d86` and `window.Dragon86`.
 */
import type { D86Api } from "../core/dev-api.ts";
import { grantFile } from "../core/fs-access.ts";
import type { Win } from "../core/wm.ts";

export interface AppFilePickOptions {
  accept?: string;
  multiple?: boolean;
  directory?: boolean;
}

export interface D86PickedFile {
  file: File;
  name: string;
  path: string;
  /** Opaque write capability scoped to this app and this exact path. */
  token: string;
  /** Same-origin `/9pf/@open/...` URL, authorized for this app. */
  url: string;
}

export interface D86AppApi extends D86Api {
  app: { id: string };
  files: {
    /** Open one or more files from ZenFS using Dragon86's file picker. */
    open(options?: AppFilePickOptions): Promise<D86PickedFile[]>;
    /** Choose a ZenFS destination and write a Blob there. */
    save(name: string, data: Blob): Promise<boolean>;
    /** Choose a ZenFS destination for a stream-style write. */
    saveAs(name?: string): Promise<{ name: string; path: string; write(data: Blob): Promise<void> } | null>;
    /** Write to a handle returned by open() or saveAs(). */
    write(token: string, data: Blob): Promise<void>;
    /** URL for a path the app has been granted (for example by files.open()). */
    url(path: string): string;
  };
  window: {
    /** Maximize this app's Dragon86 window (not browser-level fullscreen). */
    requestFullscreen(): Promise<void>;
    /** Restore this app's Dragon86 window from maximized mode. */
    exitFullscreen(): void;
    toggleFullscreen(): void;
    isFullscreen(): boolean;
  };
}

interface FrameContext {
  appId: string;
  win: Win;
  baseUrl: string;
}

interface AppBridge {
  install(child: Window, appId: string): void;
}

declare global {
  interface Window {
    __d86AppBridge?: AppBridge;
    d86?: D86Api;
    Dragon86?: D86Api;
  }
}

const FRAME_CONTEXT = new WeakMap<HTMLIFrameElement, FrameContext>();

/** Called before an iframe is attached/navigated, so its parse-time bootstrap can connect. */
export function registerAppFrame(frame: HTMLIFrameElement, appId: string, win: Win, baseUrl: string): void {
  FRAME_CONTEXT.set(frame, { appId, win, baseUrl });
}

/** Install the parent-side connector once. */
export function installAppBridge(): void {
  if (window.__d86AppBridge) return;
  window.__d86AppBridge = {
    install(child, appId) {
      try {
        if (child === window || child.parent !== window || child.location.origin !== window.location.origin) return;
        const frame = child.frameElement as HTMLIFrameElement | null;
        const context = frame ? FRAME_CONTEXT.get(frame) : undefined;
        if (!context || context.appId !== appId) return;
        installChildApi(child, context);
      } catch (error) {
        console.warn("Dragon86 app API could not connect this frame", error);
      }
    },
  };
}

/** Connect a frame after navigation as a fallback for pages without a bootstrap script. */
export function connectAppFrame(child: Window | null, appId: string): void {
  if (!child) return;
  window.__d86AppBridge?.install(child, appId);
}

/** Insert a tiny pre-app script so filesystem apps can use the API at parse time. */
export function injectAppBridge(html: string, appId: string): string {
  const id = JSON.stringify(appId);
  const marker = `parent.__d86AppBridge&&parent.__d86AppBridge.install(window,${id})`;
  if (html.includes(marker)) return html;
  const script = `<script>try{${marker}}catch(e){console.error("Dragon86 app API unavailable",e)}</script>`;
  const head = /<head\b[^>]*>/i;
  return head.test(html) ? html.replace(head, (tag) => `${tag}${script}`) : `${script}${html}`;
}

function installChildApi(child: Window, context: FrameContext): void {
  const base = window.d86 ?? null;
  const files = window.__d86ZenFSFiles;
  if (!base || !files) return;
  files.install(child);

  const appFiles: D86AppApi["files"] = {
    open: async (options = {}) => {
      const picked = await files.open(child, options);
      return picked.map((item) => {
        grantFile(context.appId, item.path);
        return {
          file: item.file,
          name: item.file.name,
          path: item.path,
          token: item.token,
          url: fileUrl(item.path, context.baseUrl),
        };
      });
    },
    save: (name, data) => files.saveFile(child, name, data),
    saveAs: async (name = "Untitled") => {
      const handle = await files.saveAs(child, name);
      if (!handle) return null;
      return {
        name: handle.name,
        path: handle.path,
        write: (data: Blob) => files.write(child, handle.token, data),
      };
    },
    write: (token, data) => files.write(child, token, data),
    url: (path) => fileUrl(path, context.baseUrl),
  };

  const appWindow: D86AppApi["window"] = {
    requestFullscreen: async () => {
      context.win.focus();
      context.win.maximize();
    },
    exitFullscreen: () => {
      if (context.win.isMaximized()) context.win.toggleMaximize();
    },
    toggleFullscreen: () => {
      context.win.focus();
      context.win.toggleMaximize();
    },
    isFullscreen: () => context.win.isMaximized(),
  };
  const api = Object.assign(Object.create(base), {
    app: Object.freeze({ id: context.appId }),
    files: appFiles,
    window: appWindow,
  }) as D86AppApi;
  child.d86 = api;
  child.Dragon86 = api;
  const readyEvent = child.document.createEvent("CustomEvent") as CustomEvent<{ appId: string }>;
  readyEvent.initCustomEvent("d86-ready", false, false, { appId: context.appId });
  child.dispatchEvent(readyEvent);
}

function fileUrl(path: string, baseUrl: string): string {
  const base = new URL(baseUrl, window.location.origin);
  return new URL(`9pf/@open/${encodeURIComponent(path)}`, base).href;
}
