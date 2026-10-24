/**
 * Toasts — small, non-blocking notices with optional actions.
 *
 * The reason this exists: an app has to be able to *ask* to become the
 * default handler for a file type without seizing the screen at boot. A
 * modal for every installed app would be hostile; a card in the corner that
 * waits for an answer is not.
 */

import { el, icon } from "./dom";

export interface ToastAction {
  label: string;
  primary?: boolean;
  onClick: () => void;
}

export interface ToastOpts {
  title: string;
  body?: string;
  icon?: string;
  /** Milliseconds before it fades by itself; 0 = stay until dismissed. */
  timeout?: number;
  actions?: ToastAction[];
}

let host: HTMLElement | null = null;
/** Never more than this many on screen; the oldest makes way. */
const MAX_VISIBLE = 3;

function container(): HTMLElement {
  if (host && host.isConnected) return host;
  host = el("div", "toast-host");
  document.body.append(host);
  return host;
}

/**
 * Show a notice. Notices do not queue behind each other — a question that
 * waits for an answer must not hide the "installed" confirmation behind it.
 */
export function notify(opts: ToastOpts): void {
  const root = container();
  const cards = root.querySelectorAll(".toast");
  if (cards.length >= MAX_VISIBLE) cards[0]?.remove();

  const card = el("div", "toast");
  const head = el("div", "toast-head");
  if (opts.icon) head.append(icon(opts.icon, "toast-icon"));
  head.append(el("div", "toast-title", opts.title));
  const closeBtn = el("button", "toast-close");
  closeBtn.innerHTML = icon("close").innerHTML;
  closeBtn.title = "Dismiss";
  head.append(closeBtn);
  card.append(head);
  if (opts.body) card.append(el("div", "toast-body", opts.body));

  let timer: number | null = null;
  let done = false;
  const dismiss = (): void => {
    if (done) return;
    done = true;
    if (timer !== null) window.clearTimeout(timer);
    card.classList.add("out");
    setTimeout(() => card.remove(), 180);
  };

  if (opts.actions?.length) {
    const row = el("div", "toast-actions");
    for (const action of opts.actions) {
      const b = el("button", `btn ${action.primary ? "primary" : ""}`.trim(), action.label);
      b.addEventListener("click", () => {
        try {
          action.onClick();
        } finally {
          dismiss();
        }
      });
      row.append(b);
    }
    card.append(row);
  }

  closeBtn.addEventListener("click", dismiss);
  root.append(card);
  if (opts.timeout !== 0) {
    timer = window.setTimeout(dismiss, opts.timeout ?? 9000);
  }
}
