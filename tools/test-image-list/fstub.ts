const files = new Map<string, string>();
export const fs = {
  __files: files,
  promises: {
    async readFile(p: string) { const v = files.get(p); if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return v; },
    async writeFile(p: string, d: string) { files.set(p, d); },
    async mkdir() {},
    async unlink(p: string) { if (!files.delete(p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
  },
};
