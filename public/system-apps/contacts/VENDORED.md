# Puter Contacts

- Source: https://github.com/heyputer/everything/tree/main/src/contacts
- Revision: `ff675ad1f6448312bf67af9c8501ee8a4307e87e` (MIT; see `LICENSE`)
- Built with upstream Vite configuration using a relative asset base on 2026-10-18;
  bundled static output only. Non-runtime screenshots and MCP metadata were omitted.
- Uses Puter.js (`https://js.puter.com/v2/`) for cloud address-book storage and
  sync. Internet access and a Puter account are needed. Dragon86's Puter Files
  adapter routes file picker operations into ZenFS; the address book remains in
  the Puter account.
- Dragon86 integration patches: the upstream root-scope service worker
  registration is skipped for paths containing `/9pf/`, so this app cannot
  take over Dragon86's origin-wide service worker scope; root-based icon URLs
  were made relative for the app's nested path. No app-owned service worker is
  shipped.
