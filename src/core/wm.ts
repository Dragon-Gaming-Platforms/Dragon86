/**
 * Window manager — draggable, resizable, focusable windows.
 */

import { el, icon } from "./dom";

export interface WindowOpts {
  title: string;
  icon: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  onClose?: () => void;
}

export interface Win {
  id: number;
  el: HTMLElement;
  setTitle(t: string): void;
  focus(): void;
  close(): void;
  minimize(): void;
  toggleMaximize(): void;
  isMinimized(): boolean;
}

interface WinState {
  id: number;
  win: Win;
  frame: HTMLElement;
  titleEl: HTMLElement;
  iconId: string;
  title: string;
  minimized: boolean;
  maximized: boolean;
  restore: { x: number; y: number; w: number; h: number } | null;
  zIndex: number;
}

type WmListener = (states: { id: number; title: string; icon: string; minimized: boolean; focused: boolean }[]) => void;

export class WindowManager {
  private states = new Map<number, WinState>();
  private nextId = 1;
  private zCounter = 100;
  private listeners = new Set<WmListener>();
  private container: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  onChange(fn: WmListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    const focused = this.focusedId();
    const list = [...this.states.values()].map((s) => ({
      id: s.id,
      title: s.title,
      icon: s.iconId,
      minimized: s.minimized,
      focused: s.id === focused,
    }));
    for (const fn of this.listeners) fn(list);
  }

  private focusedId(): number | null {
    let best: WinState | null = null;
    for (const s of this.states.values()) {
      if (!s.minimized && (!best || s.zIndex > best.zIndex)) best = s;
    }
    return best?.id ?? null;
  }

  create(opts: WindowOpts): Win {
    const id = this.nextId++;
    const frame = el("div", "d86-window");
    const width = Math.min(opts.width ?? 720, window.innerWidth - 40);
    const height = Math.min(opts.height ?? 480, window.innerHeight - 100);
    const x = opts.x ?? 60 + ((id * 28) % 180);
    const y = opts.y ?? 40 + ((id * 24) % 140);
    frame.style.width = `${width}px`;
    frame.style.height = `${height}px`;
    frame.style.left = `${x}px`;
    frame.style.top = `${y}px`;

    /* titlebar */
    const bar = el("div", "d86-titlebar");
    const titleIcon = icon(opts.icon, "title-icon");
    const titleEl = el("div", "title-text");
    const em = el("em");
    em.textContent = opts.title;
    titleEl.append(em);
    const controls = el("div", "d86-win-controls");

    const minBtn = el("button", "d86-win-btn");
    minBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M5 12h14"/></svg>`;
    minBtn.title = "Minimize";
    const maxBtn = el("button", "d86-win-btn");
    maxBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="5" width="14" height="14" rx="1"/></svg>`;
    maxBtn.title = "Maximize";
    const closeBtn = el("button", "d86-win-btn close");
    closeBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
    closeBtn.title = "Close";
    controls.append(minBtn, maxBtn, closeBtn);
    bar.append(titleIcon, titleEl, controls);

    /* body + resize grips */
    const body = el("div", "d86-window-body");
    const gripE = el("div", "d86-resize e");
    const gripS = el("div", "d86-resize s");
    const gripSE = el("div", "d86-resize se");
    frame.append(bar, body, gripE, gripS, gripSE);

    const state: WinState = {
      id,
      frame,
      titleEl,
      iconId: opts.icon,
      title: opts.title,
      minimized: false,
      maximized: false,
      restore: null,
      zIndex: ++this.zCounter,
      win: null as unknown as Win,
    };
    frame.style.zIndex = String(state.zIndex);

    const win: Win = {
      id,
      el: body,
      setTitle: (t: string) => {
        state.title = t;
        em.textContent = t;
        this.emit();
      },
      focus: () => this.focus(id),
      close: () => this.close(id),
      minimize: () => this.minimize(id),
      toggleMaximize: () => this.toggleMaximize(id),
      isMinimized: () => state.minimized,
    };
    state.win = win;
    this.states.set(id, state);

    /* interactions */
    frame.addEventListener("pointerdown", () => this.focus(id), true);
    minBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.minimize(id);
    });
    maxBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleMaximize(id);
    });
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.close(id);
    });
    bar.addEventListener("dblclick", (e) => {
      if (e.target === bar || e.target === titleEl || (e.target as HTMLElement).tagName === "EM") {
        this.toggleMaximize(id);
      }
    });

    /* drag */
    bar.addEventListener("pointerdown", (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest(".d86-win-controls")) return;
      if (state.maximized) return;
      const startX = e.clientX;
      const startY = e.clientY;
      const origX = frame.offsetLeft;
      const origY = frame.offsetTop;
      bar.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        frame.style.left = `${origX + ev.clientX - startX}px`;
        frame.style.top = `${Math.max(0, origY + ev.clientY - startY)}px`;
      };
      const up = () => {
        bar.removeEventListener("pointermove", move);
        bar.removeEventListener("pointerup", up);
      };
      bar.addEventListener("pointermove", move);
      bar.addEventListener("pointerup", up);
    });

    /* resize */
    const startResize = (e: PointerEvent, dir: "e" | "s" | "se") => {
      if (state.maximized) return;
      e.preventDefault();
      e.stopPropagation();
      const grip = e.currentTarget as HTMLElement;
      const startX = e.clientX;
      const startY = e.clientY;
      const origW = frame.offsetWidth;
      const origH = frame.offsetHeight;
      grip.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        if (dir === "e" || dir === "se") {
          frame.style.width = `${Math.max(320, origW + ev.clientX - startX)}px`;
        }
        if (dir === "s" || dir === "se") {
          frame.style.height = `${Math.max(200, origH + ev.clientY - startY)}px`;
        }
      };
      const up = () => {
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up);
    };
    gripE.addEventListener("pointerdown", (e) => startResize(e, "e"));
    gripS.addEventListener("pointerdown", (e) => startResize(e, "s"));
    gripSE.addEventListener("pointerdown", (e) => startResize(e, "se"));

    this.container.append(frame);
    this.focus(id);
    this.emit();
    return win;
  }

  private stateOf(id: number): WinState | undefined {
    return this.states.get(id);
  }

  focus(id: number): void {
    const s = this.stateOf(id);
    if (!s) return;
    if (s.minimized) {
      s.minimized = false;
      s.frame.style.display = "";
    }
    s.zIndex = ++this.zCounter;
    s.frame.style.zIndex = String(s.zIndex);
    for (const other of this.states.values()) {
      other.frame.classList.toggle("focused", other.id === id);
    }
    this.emit();
  }

  minimize(id: number): void {
    const s = this.stateOf(id);
    if (!s) return;
    s.minimized = true;
    s.frame.style.display = "none";
    this.emit();
  }

  toggleMaximize(id: number): void {
    const s = this.stateOf(id);
    if (!s) return;
    if (s.maximized && s.restore) {
      const r = s.restore;
      s.frame.style.left = `${r.x}px`;
      s.frame.style.top = `${r.y}px`;
      s.frame.style.width = `${r.w}px`;
      s.frame.style.height = `${r.h}px`;
      s.frame.classList.remove("maximized");
      s.maximized = false;
      s.restore = null;
    } else {
      s.restore = {
        x: s.frame.offsetLeft,
        y: s.frame.offsetTop,
        w: s.frame.offsetWidth,
        h: s.frame.offsetHeight,
      };
      s.frame.style.left = "0";
      s.frame.style.top = "0";
      s.frame.style.width = "100%";
      s.frame.style.height = "100%";
      s.frame.classList.add("maximized");
      s.maximized = true;
    }
    this.emit();
  }

  close(id: number): void {
    const s = this.stateOf(id);
    if (!s) return;
    s.frame.remove();
    this.states.delete(id);
    this.emit();
    /* focus next window */
    const next = this.focusedId();
    if (next !== null) this.focus(next);
  }

  getWindows() {
    return [...this.states.values()].map((s) => s.win);
  }
}
