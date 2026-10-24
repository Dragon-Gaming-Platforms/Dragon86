/**
 * Trash — a deleting bin you have to prove you want to look in.
 *
 *   ~/trash/                 where trashed things go (a normal folder)
 *   ~/trash/.trash-index.json  what each item was, so Restore works
 *
 * Two deliberate rules:
 *
 *   - it is password-locked. "Delete" in this OS means "put it in the bin",
 *     and the bin is the one place where somebody having a look over your
 *     shoulder matters, so opening it asks for a passphrase you set once;
 *   - it is emptied every time the OS is opened. The tab is the session —
 *     nothing in the bin survives closing it, so a file you deleted a week
 *     ago is not sitting there forever, and a file you deleted by accident
 *     is still there until you reload.
 *
 * The passphrase is stored as a SHA-256 hash in localStorage; it never
 * touches the filesystem, so it is not something the guest Linux can read.
 */

import { fs } from "@zenfs/core";
import * as vfs from "./vfs";
import { logInfo, logWarn } from "./log";
import { showConfirm, showInput } from "./dialog";

export const TRASH = `${vfs.HOME}/trash`;

const PW_KEY = "dragon86.trash.pass";
const INDEX = `${TRASH}/.trash-index.json`;

/** Unlocked for this page only — a reload locks it again. */
let unlocked = false;
let listeners = new Set<() => void>();

export function onTrashChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(): void {
  for (const fn of listeners) fn();
}

/* ---------- the passphrase ---------- */

async function hash(text: string): Promise<string> {
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`d86-trash:${text}`));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    /* No SubtleCrypto (some very old WebViews): a plain digest is still
       better than storing the passphrase itself. */
    let h = 0;
    for (const ch of `d86-trash:${text}`) h = (h * 31 + ch.charCodeAt(0)) | 0;
    return `plain:${(h >>> 0).toString(16)}`;
  }
}

export function hasPassword(): boolean {
  return Boolean(localStorage.getItem(PW_KEY));
}

export async function setPassword(text: string): Promise<void> {
  localStorage.setItem(PW_KEY, await hash(text));
  unlocked = true;
  emit();
}

export async function checkPassword(text: string): Promise<boolean> {
  const stored = localStorage.getItem(PW_KEY);
  if (!stored) return false;
  return stored === (await hash(text));
}

export function isUnlocked(): boolean {
  return unlocked;
}

export function lock(): void {
  unlocked = false;
  emit();
}

/**
 * Ask for the passphrase (creating it on the first visit). Resolves true
 * when the trash is open for this session.
 */
export async function unlockTrash(): Promise<boolean> {
  if (unlocked) return true;
  if (!hasPassword()) {
    const set = await showInput(
      "Lock the Trash",
      "Choose a passphrase for your trash. You will need it to open it — pick something you will remember, it is not stored anywhere you can read it back.",
      "",
    );
    if (!set) return false;
    if (set.length < 3) return false;
    await setPassword(set);
    return true;
  }
  for (let tries = 0; tries < 3; tries++) {
    const entry = await showInput("Trash is locked", "Enter your trash passphrase:", "");
    if (entry === null) return false;
    if (await checkPassword(entry)) {
      unlocked = true;
      emit();
      return true;
    }
  }
  return false;
}

/* ---------- the bin ---------- */

interface TrashRecord {
  name: string;
  from: string;
  at: number;
}

type TrashIndex = Record<string, TrashRecord>;

async function readIndex(): Promise<TrashIndex> {
  try {
    const parsed = JSON.parse(await vfs.readText(INDEX)) as TrashIndex;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeIndex(index: TrashIndex): Promise<void> {
  await vfs.writeText(INDEX, JSON.stringify(index, null, 2));
}

export interface TrashItem {
  name: string;
  path: string;
  from: string;
  at: number;
}

export async function listTrash(): Promise<TrashItem[]> {
  const index = await readIndex();
  let names: string[] = [];
  try {
    names = (await fs.promises.readdir(TRASH)) as unknown as string[];
  } catch {
    return [];
  }
  const items: TrashItem[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    items.push({
      name,
      path: `${TRASH}/${name}`,
      from: index[name]?.from ?? "unknown",
      at: index[name]?.at ?? 0,
    });
  }
  return items.sort((a, b) => b.at - a.at);
}

export async function trashCount(): Promise<number> {
  return (await listTrash()).length;
}

/** A name that is free in the bin: `notes.txt`, `notes (2).txt`, … */
async function freeName(name: string): Promise<string> {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let candidate = name;
  for (let n = 2; n < 999; n++) {
    if (!(await vfs.exists(`${TRASH}/${candidate}`))) return candidate;
    candidate = `${stem} (${n})${ext}`;
  }
  return `${stem}-${Date.now()}${ext}`;
}

/** Move a file or folder into the bin. Never throws at the caller. */
export async function moveToTrash(path: string): Promise<boolean> {
  if (path === TRASH || path.startsWith(`${TRASH}/`)) return false;
  try {
    await vfs.ensureDir(TRASH);
    const name = await freeName(vfs.baseName(path));
    await fs.promises.rename(path, `${TRASH}/${name}`);
    const index = await readIndex();
    index[name] = { name, from: path, at: Date.now() };
    await writeIndex(index);
    logInfo("os", `trashed ${path} → ${TRASH}/${name}`);
    emit();
    return true;
  } catch (err) {
    logWarn("os", `could not trash ${path}`, err);
    return false;
  }
}

/** Put one item back where it came from (or in Home if that is gone). */
export async function restore(name: string): Promise<string | null> {
  const index = await readIndex();
  const record = index[name];
  const from = record?.from ?? `${vfs.HOME}/${name}`;
  const target = (await vfs.exists(vfs.parentOf(from))) ? from : `${vfs.HOME}/${name}`;
  try {
    await fs.promises.rename(`${TRASH}/${name}`, target);
    delete index[name];
    await writeIndex(index);
    emit();
    return target;
  } catch (err) {
    logWarn("os", `could not restore ${name}`, err);
    return null;
  }
}

/** Empty the bin. Used by the Trash window, Settings, and every boot. */
export async function emptyTrash(): Promise<number> {
  let names: string[] = [];
  try {
    names = (await fs.promises.readdir(TRASH)) as unknown as string[];
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    try {
      await vfs.removePath(`${TRASH}/${name}`);
      removed++;
    } catch (err) {
      logWarn("os", `could not empty ${name} from the trash`, err);
    }
  }
  unlocked = false;
  emit();
  return removed;
}

/**
 * Boot step: create the bin and wipe it. The tab is the session, so this is
 * the "wiped whenever the OS is opened" half of the rule; closing the tab
 * takes the last contents with it.
 */
export async function initTrash(): Promise<void> {
  await vfs.ensureDir(TRASH);
  const removed = await emptyTrash();
  if (removed) logInfo("os", `trash emptied at boot (${removed} item${removed === 1 ? "" : "s"})`);
}

/** Confirmation used by every "Move to Trash" menu item. */
export async function confirmTrash(name: string): Promise<boolean> {
  return showConfirm(
    "Move to Trash",
    `Move "${name}" to the trash? It is emptied when you next open Dragon86.`,
    false,
  );
}
