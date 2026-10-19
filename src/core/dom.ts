/** Tiny DOM helpers. */

/**
 * Long-press → handler (for touch context menus).
 * Mouse users keep using right-click; this is pointer:finger only.
 * Cancels on move (>10px) so scrolling never triggers it.
 */
export function attachLongPress(
  node: HTMLElement,
  handler: (x: number, y: number) => void,
): void {
  let timer: number | null = null;
  let sx = 0;
  let sy = 0;
  const cancel = () => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };
  node.addEventListener("pointerdown", (e: PointerEvent) => {
    if (e.pointerType === "mouse") return;
    sx = e.clientX;
    sy = e.clientY;
    cancel();
    timer = window.setTimeout(() => {
      timer = null;
      handler(sx, sy);
    }, 480);
  });
  node.addEventListener("pointerup", cancel);
  node.addEventListener("pointercancel", cancel);
  node.addEventListener("pointermove", (e: PointerEvent) => {
    if (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10) cancel();
  });
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function icon(name: string, className?: string): HTMLElement {
  const wrap = el("span", `icon ${className ?? ""}`.trim());
  wrap.innerHTML = ICONS[name] ?? ICONS.file;
  return wrap;
}

/** Inline stroke-icon set (24×24, currentColor). */
export const ICONS: Record<string, string> = {
  terminal:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2.5" y="4" width="19" height="16" rx="2"/><path d="M7 9l3.5 2.8L7 14.5"/><path d="M12.5 15.5H17"/></svg>',
  folder:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2l2 2.2h8.8A1.5 1.5 0 0 1 21 8.7V18a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18z"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5"/></svg>',
  text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 16.5h6"/></svg>',
  editor:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19z"/><path d="M14.5 6.5l3 3"/></svg>',
  settings:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3.2"/><path d="M19 12a7 7 0 0 0-.14-1.4l2.02-1.58-2-3.46-2.4.96a7 7 0 0 0-2.42-1.4L13.7 2.5h-4l-.36 2.62a7 7 0 0 0-2.42 1.4l-2.4-.96-2 3.46L4.14 10.6a7 7 0 0 0 0 2.8l-2.02 1.58 2 3.46 2.4-.96a7 7 0 0 0 2.42 1.4l.36 2.62h4l.36-2.62a7 7 0 0 0 2.42-1.4l2.4.96 2-3.46L18.86 13.4A7 7 0 0 0 19 12z"/></svg>',
  browser:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.5 3.9 5.6 3.9 9S14.6 18.5 12 21c-2.6-2.5-3.9-5.6-3.9-9S9.4 5.5 12 3z"/></svg>',
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3.5 11L12 4l8.5 7"/><path d="M5.5 10v9.5h13V10"/><path d="M10 19.5v-5h4v5"/></svg>',
  download:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 4v11"/><path d="M7.5 11L12 15.5 16.5 11"/><path d="M4.5 19.5h15"/></svg>',
  desktop:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="12.5" rx="1.5"/><path d="M8.5 20h7M12 16.5V20"/></svg>',
  linux:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2.5" y="5" width="19" height="11" rx="1.5"/><path d="M6 8.5l2.5 2L6 12.5M10.5 12.5H14"/><path d="M8 20h8"/></svg>',
  close:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  minimize:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M5 12h14"/></svg>',
  maximize:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="5" width="14" height="14" rx="1"/></svg>',
  restore:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="8" width="12" height="12" rx="1"/><path d="M8 8V4h12v12h-4"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.5 5.5L8 12l6.5 6.5"/></svg>',
  forward:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9.5 5.5L16 12l-6.5 6.5"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5.5 14.5L12 8l6.5 6.5"/></svg>',
  refresh:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v4h-4"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>',
  trash:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4.5 7h15M9 7V4.5h6V7"/><path d="M6.5 7l1 13h9l1-13"/><path d="M10 11v6M14 11v6"/></svg>',
  rename:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19z"/><path d="M14.5 6.5l3 3"/></svg>',
  save: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4"/><rect x="8" y="13" width="8" height="7"/></svg>',
  power:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 4v8"/><path d="M7.2 6.8a7 7 0 1 0 9.6 0"/></svg>',
  dragon:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3l7 4v6c0 4-3 7-7 8-4-1-7-4-7-8V7z"/><path d="M9 11l2 2 4-4"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.5v.5"/></svg>',
  wallpaper:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M3 15l4.5-4 3.5 3 3-2.5L21 15"/><circle cx="8.5" cy="9" r="1.2"/></svg>',
};
