#!/usr/bin/env node
import assert from "node:assert/strict";
import { createZipArchive } from "../src/core/archive-write.ts";
import { openArchive, readEntry } from "../src/core/archive.ts";

const encoder = new TextEncoder();
const blob = createZipArchive([
  { path: "My folder/hello.txt", bytes: encoder.encode("hello from ZenFS"), modified: Date.UTC(2025, 0, 2) },
  { path: "My folder/資料.csv", bytes: encoder.encode("a,b\n1,2") },
  { path: "My folder/empty/", bytes: new Uint8Array(), isDirectory: true },
]);
const archive = await openArchive(new Uint8Array(await blob.arrayBuffer()), "zip");
assert.deepEqual(archive.entries.map((entry) => entry.path), [
  "My folder/hello.txt",
  "My folder/資料.csv",
  "My folder/empty/",
]);
assert.equal(new TextDecoder().decode(await readEntry(archive, archive.entries[0])), "hello from ZenFS");
assert.equal(new TextDecoder().decode(await readEntry(archive, archive.entries[1])), "a,b\n1,2");
assert.equal(archive.entries[2].isDirectory, true);
assert.throws(() => createZipArchive([{ path: "../../outside.txt", bytes: encoder.encode("safe") }]), /Invalid ZIP path/);
assert.throws(() => createZipArchive([{ path: "/absolute.txt", bytes: encoder.encode("safe") }]), /Invalid ZIP path/);
assert.throws(() => createZipArchive([{ path: "C:\\outside.txt", bytes: encoder.encode("safe") }]), /Invalid ZIP path/);
assert.throws(() => createZipArchive([]), /nothing to download/);
console.log("ZIP export tests passed");
