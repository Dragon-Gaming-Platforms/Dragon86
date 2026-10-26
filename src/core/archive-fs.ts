/**
 * Archive → ZenFS.
 *
 * The parsing lives in core/archive.ts (pure, tested in Node). This is the
 * half that touches the filesystem: read the file, list it, write what is
 * inside — with the rules a filesystem needs and a parser does not:
 *
 *   - every path is checked before it is used: an archive entry called
 *     `../../etc/passwd` must land inside the target folder or not at all;
 *   - sizes are capped, because a 40 KB zip can honestly declare 40 GB of
 *     output and a browser tab should survive being asked to unpack it;
 *   - nothing is overwritten silently: the caller says whether to replace.
 */

import * as vfs from "./vfs";
import { logInfo, logWarn } from "./log";
import {
  ArchiveError,
  archiveBaseName,
  detectArchiveKind,
  openArchive,
  readEntry,
  type ArchiveEntry,
  type ArchiveKind,
  type OpenedArchive,
} from "./archive";

/** Per entry, and in total: neither a browser tab nor IndexedDB is a disk. */
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 20_000;

export interface ArchiveListing {
  kind: ArchiveKind;
  archive: OpenedArchive;
  entries: ArchiveEntry[];
  /** True when a .gz turned out to hold a tar (`.tar.gz`, `.tgz`). */
  tarInside: boolean;
}

export interface ExtractResult {
  dir: string;
  files: number;
  directories: number;
  bytes: number;
  /** Entries that were skipped because they would have escaped `dir`. */
  skipped: string[];
}

export async function readArchive(path: string): Promise<ArchiveListing> {
  const kind = detectArchiveKind(vfs.baseName(path));
  if (!kind) throw new ArchiveError(`${vfs.baseName(path)} is not a .zip, .tar or .gz file`);
  const bytes = await vfs.readBytes(path);
  const archive = await openArchive(bytes, kind);
  const entries = archive.entries;

  /* `.tar.gz` reads as gzip; the tar inside is what makes it a tree. */
  const tarInside = kind === "gzip" && archive.container === "tar";
  if (!entries.length) throw new ArchiveError("the archive is empty");
  if (entries.length > MAX_ENTRIES) {
    throw new ArchiveError(`the archive has ${entries.length} entries; this OS stops at ${MAX_ENTRIES}`);
  }
  let total = 0;
  for (const entry of entries) {
    if (entry.size > MAX_ENTRY_BYTES) {
      throw new ArchiveError(
        `"${entry.path}" is ${(entry.size / 1048576).toFixed(1)} MB; the limit is ${MAX_ENTRY_BYTES / 1048576} MB per file`,
      );
    }
    total += entry.size;
  }
  if (total > MAX_TOTAL_BYTES) {
    throw new ArchiveError(
      `the archive unpacks to ${(total / 1048576).toFixed(0)} MB; the limit is ${MAX_TOTAL_BYTES / 1048576} MB`,
    );
  }
  return { kind, archive, entries, tarInside };
}

/** A path inside the archive, made safe: no absolute paths, no "..", no empties. */
function safeRelative(raw: string): string | null {
  const parts: string[] = [];
  for (const part of raw.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") return null;
    /* A NUL would truncate the path in most filesystems. */
    if (part.includes("\0")) return null;
    parts.push(part);
  }
  return parts.length ? parts.join("/") : null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await vfs.exists(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Unpack `path` into `destDir`.
 *
 * A plain `.gz` (the one-file case) writes its single file there under the
 * name the .gz advertises, or under the .gz's own name without the suffix —
 * `notes.txt.gz` → `notes.txt`.
 */
export async function extractArchive(path: string, destDir: string, options: { overwrite?: boolean } = {}): Promise<ExtractResult> {
  const { archive, entries } = await readArchive(path);
  const result: ExtractResult = { dir: destDir, files: 0, directories: 0, bytes: 0, skipped: [] };

  await vfs.ensureDir(destDir);

  for (const entry of entries) {
    let rel = safeRelative(entry.path);

    /* One-file gzip: the header name may be missing or useless, so fall back
       to the .gz's own name minus its suffix. */
    if (archive.container === "gzip" && entries.length === 1 && !entry.isDirectory) {
      rel = safeRelative(entry.path) ?? archiveBaseName(vfs.baseName(path));
      if (!rel) rel = archiveBaseName(vfs.baseName(path));
    }
    if (!rel) {
      result.skipped.push(entry.path);
      logWarn("os", `archive: refusing an entry outside the target folder: ${entry.path}`);
      continue;
    }

    const target = `${destDir.replace(/\/$/, "")}/${rel}`;
    if (entry.isDirectory) {
      await vfs.ensureDir(target);
      result.directories++;
      continue;
    }

    if (!options.overwrite && (await exists(target))) {
      result.skipped.push(entry.path);
      continue;
    }

    const data = await readEntry(archive, entry);
    await vfs.writeBytes(target, data);
    result.files++;
    result.bytes += data.length;
  }

  logInfo(
    "os",
    `archive: extracted ${result.files} file(s), ${result.directories} folder(s) from ${vfs.baseName(path)} into ${destDir}`,
  );
  return result;
}

/** Where "Extract to folder" puts things: `photos.zip` → `photos/` next to it. */
export function extractDirFor(path: string): string {
  const parent = vfs.parentOf(path);
  const base = archiveBaseName(vfs.baseName(path)) || "extracted";
  return `${parent}/${base}`;
}
