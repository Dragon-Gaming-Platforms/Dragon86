/** Modal dialogs (input / confirm) and context menus. */

import { el } from "./dom";

export function showInput(title: string, message: string, initial = ""): Promise<string | null> {
  return new Promise((resolve) => {
    const backdrop = el("div", "dlg-backdrop");
    const dlg = el("div", "dlg");
    const h = el("h3", undefined, title);
    const p = el("p", undefined, message);
    const input = el("input", "input");
    input.value = initial;
    input.spellcheck = false;
    const actions = el("div", "dlg-actions");
    const cancel = el("button", "btn", "Cancel");
    const ok = el("button", "btn", "OK");

    const done = (v: string | null) => {
      backdrop.remove();
      resolve(v);
    };
    cancel.addEventListener("click", () => done(null));
    ok.addEventListener("click", () => done(input.value.trim() || null));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") done(input.value.trim() || null);
      if (e.key === "Escape") done(null);
    });
    backdrop.addEventListener("mousedown", (e) => {
      if (e.target === backdrop) done(null);
    });

    actions.append(cancel, ok);
    dlg.append(h, p, input, actions);
    backdrop.append(dlg);
    document.body.append(backdrop);
    input.focus();
    input.select();
  });
}

export function showConfirm(title: string, message: string, danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    const backdrop = el("div", "dlg-backdrop");
    const dlg = el("div", "dlg");
    const h = el("h3", undefined, title);
    const p = el("p", undefined, message);
    const actions = el("div", "dlg-actions");
    const cancel = el("button", "btn", "Cancel");
    const ok = el("button", `btn ${danger ? "danger" : ""}`.trim(), danger ? "Delete" : "OK");

    const done = (v: boolean) => {
      backdrop.remove();
      resolve(v);
    };
    cancel.addEventListener("click", () => done(false));
    ok.addEventListener("click", () => done(true));
    backdrop.addEventListener("mousedown", (e) => {
      if (e.target === backdrop) done(false);
    });

    actions.append(cancel, ok);
    dlg.append(h, p, actions);
    backdrop.append(dlg);
    document.body.append(backdrop);
    ok.focus();
  });
}

export interface CtxItem {
  label: string;
  iconHtml?: string;
  danger?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  separator?: boolean;
  /** Optional submenu, opened on hover ("Open with ›"). */
  children?: CtxItem[];
  /** Small grey note on the right, e.g. "(default)". */
  hint?: string;
}

/** Every menu currently on screen, outermost first. */
let openMenus: HTMLElement[] = [];

/**
 * A context menu, with one level of submenu.
 *
 * Submenus are opened by hovering (or clicking, for touch) and close again
 * when the pointer leaves both the parent row and the submenu — with a short
 * grace period, so crossing the 6px gap between them does not dismiss the
 * thing you were aiming at.
 */
export function showContextMenu(x: number, y: number, items: CtxItem[]): void {
  closeContextMenu();
  const menu = buildMenu(items, null);
  menu.id = "d86-ctx";
  document.body.append(menu);
  openMenus = [menu];
  place(menu, x, y);

  setTimeout(() => {
    window.addEventListener("mousedown", onAway, { capture: true });
    window.addEventListener("keydown", onEsc, true);
    window.addEventListener("blur", closeContextMenu);
  }, 0);
}

function buildMenu(items: CtxItem[], parent: HTMLElement | null): HTMLElement {
  const menu = el("div", "ctx-menu");
  if (parent) menu.classList.add("ctx-sub");

  for (const item of items) {
    if (item.separator) {
      menu.append(el("div", "ctx-sep"));
      continue;
    }
    const b = el("button", `ctx-item ${item.danger ? "danger" : ""}`.trim());
    if (item.iconHtml) {
      const ic = el("span", "ctx-icon");
      ic.innerHTML = item.iconHtml;
      b.append(ic.firstChild ?? ic);
    } else {
      b.append(el("span", "ctx-icon"));
    }
    b.append(el("span", "ctx-label", item.label));
    if (item.hint) b.append(el("span", "ctx-hint", item.hint));
    menu.append(b);
    if (item.children?.length) {
      b.classList.add("has-sub");
      b.append(el("span", "ctx-arrow", "›"));
      const sub = buildMenu(item.children, menu);
      let closeTimer: number | null = null;
      const openSub = (): void => {
        if (closeTimer !== null) {
          window.clearTimeout(closeTimer);
          closeTimer = null;
        }
        closeSubmenusAfter(menu);
        if (!sub.isConnected) document.body.append(sub);
        const r = b.getBoundingClientRect();
        place(sub, r.right - 4, r.top - 6);
        openMenus.push(sub);
      };
      const scheduleClose = (): void => {
        if (closeTimer !== null) window.clearTimeout(closeTimer);
        closeTimer = window.setTimeout(() => {
          closeTimer = null;
          sub.remove();
          openMenus = openMenus.filter((m) => m !== sub);
        }, 260);
      };
      b.addEventListener("mouseenter", openSub);
      b.addEventListener("mouseleave", scheduleClose);
      sub.addEventListener("mouseenter", openSub);
      sub.addEventListener("mouseleave", scheduleClose);
      b.addEventListener("click", (e) => {
        /* Touch has no hover: a tap on the row opens the list. */
        e.stopPropagation();
        openSub();
      });
      continue;
    }
    if (item.disabled) {
      b.disabled = true;
    } else {
      b.addEventListener("click", () => {
        closeContextMenu();
        item.onClick?.();
      });
    }
  }
  return menu;
}

/** Close any submenu deeper than `menu` (siblings of the one opening). */
function closeSubmenusAfter(menu: HTMLElement): void {
  const at = openMenus.indexOf(menu);
  if (at === -1) return;
  for (const extra of openMenus.slice(at + 1)) extra.remove();
  openMenus = openMenus.slice(0, at + 1);
}

/** Keep a menu on screen, preferring right/down but flipping when needed. */
function place(menu: HTMLElement, x: number, y: number): void {
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let left = x;
  let top = y;
  if (left + mw > window.innerWidth - 6) left = Math.max(6, x - mw);
  if (top + mh > window.innerHeight - 6) top = Math.max(6, window.innerHeight - mh - 6);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function onAway(e: Event): void {
  const target = e.target as Node;
  if (openMenus.some((m) => m.contains(target))) return;
  closeContextMenu();
}

function onEsc(e: KeyboardEvent): void {
  if (e.key === "Escape") closeContextMenu();
}

export function closeContextMenu(): void {
  for (const menu of openMenus) menu.remove();
  openMenus = [];
  document.getElementById("d86-ctx")?.remove();
  window.removeEventListener("mousedown", onAway, { capture: true });
  window.removeEventListener("keydown", onEsc, true);
  window.removeEventListener("blur", closeContextMenu);
}
