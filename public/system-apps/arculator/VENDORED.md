# Vendored Arculator WASM build

- source: https://github.com/pdjstone/arculator-wasm @ 579ac437b9a4ebe83b9b5f9b8e50b0c9c530509e (GPL-2.0)
- built: 2026-11-09T16:46:39Z by .github/workflows/build-arculator.yml
- contents: emulator (arculator.js/.wasm/.data/.data.js),
  the GPL support ROM (arcrom_ext) and default CMOS images.
- NO operating system is included. RISC OS / Arthur ROM images
  are copyrighted and must never be committed here; the app asks
  the user for one and keeps it in their browser storage.
