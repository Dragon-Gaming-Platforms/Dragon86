/**
 * Engine contract — what the Terminal and the Engine Viewer expect from a
 * machine backend, whatever emulator is behind it.
 *
 * This used to live in bridge/hoster.ts next to the CheerpX transport; the
 * CheerpX connection is gone (DrakeForge is the only thing that will speak
 * to another page, and it has its own files: bridge/fs-bridge.ts for the
 * filesystem service and bridge/drakeforge-session.ts for the dormant
 * session transport). The machine types stayed — they describe the in-page
 * engines (bridge/v86.ts, which runs the vendored v86 or v64 build).
 */

export type BackendStatus = "ready" | "offline";

/**
 * What a machine's own display currently shows, one string per text row.
 * Rows may contain ANSI SGR colour escapes (the emulator is asked for
 * them), so the reader strips them when it only wants the characters — see
 * apps/engine-viewer.ts.
 */
export interface EngineScreen {
  cols: number;
  rows: number;
  lines: string[];
}

export interface TerminalBackend {
  connect(): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
  /** Snapshot the machine to on-device storage, when the engine can. */
  saveState?: () => Promise<void>;
  /**
   * The machine's VGA text screen, as it is right now. This is the
   * display the emulated BIOS and kernel draw on — not the serial console
   * the Terminal shows — which is what the Engine Viewer mirrors.
   */
  getScreen?: () => EngineScreen | null;
  /**
   * The element the machine draws its display into — the emulator's own
   * screen, the same renderer copy.sh/v86 uses: text rows with real
   * colours, a blinking cursor, and a canvas underneath for graphical
   * modes. The Engine Viewer puts this element on screen rather than
   * re-drawing the screen itself.
   *
   * Null before the machine exists, or for a backend with no display of
   * its own.
   */
  screenElement?: () => HTMLElement | null;
  /**
   * Keystrokes from the Engine Viewer, as PS/2 scancodes. Present only on a
   * backend whose screen is a real console somebody can type into.
   */
  sendScancodes?: (codes: number[]) => void;
  /**
   * True while this backend still owns a live machine. The Engine Viewer
   * needs to tell "there is no machine" from "the machine is up but its
   * display is not readable yet" — the two used to be the same message, and
   * it was wrong about the second one.
   */
  isRunning?: () => boolean;
}

export interface BackendHandlers {
  onData: (data: string) => void;
  onStatus: (s: BackendStatus) => void;
  /** Progress text worth showing in the Terminal (image index, boot steps). */
  onNotice?: (text: string) => void;
}
