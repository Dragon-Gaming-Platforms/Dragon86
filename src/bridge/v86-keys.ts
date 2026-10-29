/**
 * Browser key events → the scancodes a v86 machine's keyboard controller wants.
 *
 * The Engine Viewer is writable: keys pressed over the machine's screen go to
 * the guest's VGA console (tty1), which has its own login shell. v86's
 * keyboard adapter would normally capture keys from the whole page, which in
 * an OS window is wrong — every keystroke in every app would land in the
 * guest. So the machine is built with its keyboard capture *off* and the
 * viewer sends the codes itself, only while its screen has focus.
 *
 * What goes on the wire is PS/2 set-1 (the "XT" codes): one byte per key, with
 * the high bit set on release, and a `0xE0` prefix for the keys that were
 * added later (arrows, Home/End/Delete/Insert, Page Up/Down, right Ctrl/Alt,
 * Numpad Enter and Divide). v86's own adapter does exactly this
 * (`254 < t ? (l(t >> 8), l(t & 255)) : l(t)`), which is why an extended
 * release is `0xE0` followed by `code | 0x80`.
 *
 * The mapping is keyed on `KeyboardEvent.code` — the *physical* key — not on
 * the character: the guest's own keyboard driver applies Shift, Caps Lock and
 * the layout, so `Shift+2` must arrive as "shift is held, 2 is pressed" and
 * let Linux decide that means `"`.
 *
 * No DOM types and no imports: tools/test-engine-viewer.mjs runs the real file
 * in Node, and tools/vm/boot.mjs uses it to type into a real machine.
 */

export interface KeyCodes {
  code: number;
  /** Sent behind a `0xE0` prefix (PS/2 "extended" keys). */
  extended: boolean;
}

/** Physical key → scancode, for a console keyboard. */
const KEYS: Record<string, [number, boolean]> = {
  Escape: [0x01, false],
  Digit1: [0x02, false],
  Digit2: [0x03, false],
  Digit3: [0x04, false],
  Digit4: [0x05, false],
  Digit5: [0x06, false],
  Digit6: [0x07, false],
  Digit7: [0x08, false],
  Digit8: [0x09, false],
  Digit9: [0x0a, false],
  Digit0: [0x0b, false],
  Minus: [0x0c, false],
  Equal: [0x0d, false],
  Backspace: [0x0e, false],
  Tab: [0x0f, false],
  KeyQ: [0x10, false],
  KeyW: [0x11, false],
  KeyE: [0x12, false],
  KeyR: [0x13, false],
  KeyT: [0x14, false],
  KeyY: [0x15, false],
  KeyU: [0x16, false],
  KeyI: [0x17, false],
  KeyO: [0x18, false],
  KeyP: [0x19, false],
  BracketLeft: [0x1a, false],
  BracketRight: [0x1b, false],
  Enter: [0x1c, false],
  ControlLeft: [0x1d, false],
  KeyA: [0x1e, false],
  KeyS: [0x1f, false],
  KeyD: [0x20, false],
  KeyF: [0x21, false],
  KeyG: [0x22, false],
  KeyH: [0x23, false],
  KeyJ: [0x24, false],
  KeyK: [0x25, false],
  KeyL: [0x26, false],
  Semicolon: [0x27, false],
  Quote: [0x28, false],
  Backquote: [0x29, false],
  ShiftLeft: [0x2a, false],
  Backslash: [0x2b, false],
  KeyZ: [0x2c, false],
  KeyX: [0x2d, false],
  KeyC: [0x2e, false],
  KeyV: [0x2f, false],
  KeyB: [0x30, false],
  KeyN: [0x31, false],
  KeyM: [0x32, false],
  Comma: [0x33, false],
  Period: [0x34, false],
  Slash: [0x35, false],
  ShiftRight: [0x36, false],
  NumpadMultiply: [0x37, false],
  AltLeft: [0x38, false],
  Space: [0x39, false],
  CapsLock: [0x3a, false],
  F1: [0x3b, false],
  F2: [0x3c, false],
  F3: [0x3d, false],
  F4: [0x3e, false],
  F5: [0x3f, false],
  F6: [0x40, false],
  F7: [0x41, false],
  F8: [0x42, false],
  F9: [0x43, false],
  F10: [0x44, false],
  NumLock: [0x45, false],
  ScrollLock: [0x46, false],
  Numpad7: [0x47, false],
  Numpad8: [0x48, false],
  Numpad9: [0x49, false],
  NumpadSubtract: [0x4a, false],
  Numpad4: [0x4b, false],
  Numpad5: [0x4c, false],
  Numpad6: [0x4d, false],
  NumpadAdd: [0x4e, false],
  Numpad1: [0x4f, false],
  Numpad2: [0x50, false],
  Numpad3: [0x51, false],
  Numpad0: [0x52, false],
  NumpadDecimal: [0x53, false],
  F11: [0x57, false],
  F12: [0x58, false],
  /* Extended: 0xE0 first. */
  NumpadEnter: [0x1c, true],
  ControlRight: [0x1d, true],
  NumpadDivide: [0x35, true],
  PrintScreen: [0x37, true],
  AltRight: [0x38, true],
  Home: [0x47, true],
  ArrowUp: [0x48, true],
  PageUp: [0x49, true],
  ArrowLeft: [0x4b, true],
  ArrowRight: [0x4d, true],
  End: [0x4f, true],
  ArrowDown: [0x50, true],
  PageDown: [0x51, true],
  Insert: [0x52, true],
  Delete: [0x53, true],
  MetaLeft: [0x5b, true],
  MetaRight: [0x5c, true],
  ContextMenu: [0x5d, true],
};

/** The scancode for a physical key, or null for one the guest has no use for. */
export function keyFor(code: string): KeyCodes | null {
  const entry = KEYS[code];
  return entry ? { code: entry[0], extended: entry[1] } : null;
}

/**
 * The bytes for one key going down or coming up. An extended release is the
 * prefix *and* the released code — `0xE0 0xC8` for a released Up arrow.
 */
export function scancodesFor(code: string, down: boolean): number[] {
  const key = keyFor(code);
  if (!key) return [];
  const bytes = key.extended ? [0xe0, key.code] : [key.code];
  if (!down) bytes[bytes.length - 1] |= 0x80;
  return bytes;
}

/**
 * Everything one key event should send. Modifiers are not synthesized here:
 * the browser sends their own keydown/keyup, so holding Shift arrives as a
 * press before the letter and a release after it, which is what the guest's
 * keyboard driver expects.
 *
 * `repeat` (auto-repeat) is ignored by the guest's own repeat rate, so only
 * the first press is sent — a held key must not flood the keyboard controller.
 */
export function scancodesForEvent(
  event: { code?: string; key?: string; repeat?: boolean },
  down: boolean,
): number[] {
  if (down && event.repeat) return [];
  const code = event.code || legacyCodeFor(event.key);
  return code ? scancodesFor(code, down) : [];
}

/**
 * A key name for browsers that do not send `code` (and for synthetic events in
 * tests). Only the names that differ from the physical key matter.
 */
function legacyCodeFor(key: string | undefined): string | null {
  if (!key) return null;
  if (key.length === 1) {
    const ch = key.toLowerCase();
    if (ch >= "a" && ch <= "z") return `Key${ch.toUpperCase()}`;
    if (ch >= "0" && ch <= "9") return `Digit${ch}`;
    const punctuation: Record<string, string> = {
      "-": "Minus",
      "=": "Equal",
      "[": "BracketLeft",
      "]": "BracketRight",
      ";": "Semicolon",
      "'": "Quote",
      "`": "Backquote",
      "\\": "Backslash",
      ",": "Comma",
      ".": "Period",
      "/": "Slash",
      " ": "Space",
    };
    return punctuation[ch] ?? null;
  }
  const named = new Set([
    "Escape",
    "Backspace",
    "Tab",
    "Enter",
    "CapsLock",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "Insert",
    "Delete",
    "Shift",
    "Control",
    "Alt",
    "Meta",
  ]);
  if (!named.has(key)) return null;
  if (key === "Shift" || key === "Control" || key === "Alt" || key === "Meta") {
    return `${key}Left`;
  }
  return key;
}

/**
 * Keys typed into the viewer that the *OS* would otherwise claim: the guest
 * gets them, the page does not. Ctrl/Alt/Meta combinations are the reason this
 * exists — the machine's console needs Ctrl-C, Ctrl-D, Alt-F1… and the window
 * manager must not act on them while the screen has focus.
 */
export function isMachineKey(event: { code?: string; key?: string }): boolean {
  return Boolean(event.code) || Boolean(event.key && legacyCodeFor(event.key));
}
