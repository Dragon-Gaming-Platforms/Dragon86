/**
 * The little filesystem vocabulary the 9p server and the overlay share.
 *
 * `BaseLayer` is a read-only view (what a lower layer has to answer), and
 * `BaseStat` is the slice of `fs.Stats` the guest actually sees. ZenFS stats
 * satisfy it; so does a hand-rolled layer.
 */

export interface BaseStat {
  mode: number; // POSIX st_mode (type bits + permissions)
  size: number;
  mtimeMs: number;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isFile(): boolean;
}

export interface BaseDirEntry {
  name: string;
  isDirectory: boolean;
}

export interface BaseLayer {
  stat(path: string): Promise<BaseStat | null>;
  readdir(path: string): Promise<BaseDirEntry[] | null>;
  readFile(path: string): Promise<Uint8Array | null>;
  readlink(path: string): Promise<string | null>;
}

export function makeStat(mode: number, size: number, mtimeMs: number): BaseStat {
  return {
    mode,
    size,
    mtimeMs,
    isDirectory: () => (mode & 0o170000) === 0o040000,
    isSymbolicLink: () => (mode & 0o170000) === 0o120000,
    isFile: () => (mode & 0o170000) === 0o100000,
  };
}
