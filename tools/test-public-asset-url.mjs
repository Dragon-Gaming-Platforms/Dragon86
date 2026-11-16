import assert from "node:assert/strict";
import { publicAssetBase } from "../src/bridge/public-url.ts";

const cases = [
  {
    label: "site deployed at the domain root",
    base: "/",
    page: "https://dragon.example/",
    expected: "https://dragon.example/netbsd64/",
  },
  {
    label: "site deployed below a project path",
    base: "/Dragon86/",
    page: "https://dragon.example/Dragon86/index.html",
    expected: "https://dragon.example/Dragon86/alpine32/",
    directory: "alpine32",
  },
  {
    label: "relative Vite base",
    base: "./",
    page: "http://localhost:5173/Dragon86/",
    expected: "http://localhost:5173/Dragon86/netbsd64/",
  },
];

// This is the previous install bug: URL's base parameter must be an absolute URL,
// not Vite's relative BASE_URL pathname.
assert.throws(() => new URL("root.img.gz.00", "/Dragon86/netbsd64/"), TypeError);

for (const test of cases) {
  const base = publicAssetBase(test.base, test.directory ?? "netbsd64", test.page);
  assert.equal(base, test.expected, test.label);
  assert.equal(new URL("manifest.json", base).href, `${test.expected}manifest.json`, `${test.label}: child asset is URL-resolvable`);
  console.log(`[PASS] ${test.label}: ${base}`);
}
