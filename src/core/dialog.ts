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
}

export function showContextMenu(x: number, y: number, items: CtxItem[]): void {
  closeContextMenu();
  const menu = el("div", "ctx-menu");
  menu.id = "d86-ctx";
  for (const item of items) {
    if (item.separator) {
      menu.append(el("div", "ctx-sep"));
      continue;
    }
    const b = el("button", `ctx-item ${item.danger ? "danger" : ""}`.trim());
    if (item.iconHtml) {
      const ic = el("span");
      ic.innerHTML = item.iconHtml;
      b.append(ic.firstChild ?? ic);
    }
    b.append(item.label);
    if (item.disabled) {
      b.disabled = true;
      b.style.opacity = "0.4";
    } else {
      b.addEventListener("click", () => {
        closeContextMenu();
        item.onClick?.();
      });
    }
    menu.append(b);
  }
  document.body.append(menu);

  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  menu.style.left = `${Math.min(x, window.innerWidth - mw - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - mh - 8)}px`;

  setTimeout(() => {
    window.addEventListener("mousedown", onAway, { capture: true, once: true });
    window.addEventListener("keydown", onEsc, { once: true });
  }, 0);

  function onAway(e: Event): void {
    const menuEl = document.getElementById("d86-ctx");
    if (menuEl && !menuEl.contains(e.target as Node)) closeContextMenu();
  }
  function onEsc(): void {
    closeContextMenu();
  }
}

export function closeContextMenu(): void {
  document.getElementById("d86-ctx")?.remove();
}
