# Puter Tasks

- Source: https://github.com/heyputer/everything/tree/main/src/tasks
- Revision: `ff675ad1f6448312bf67af9c8501ee8a4307e87e` (MIT; see `LICENSE`)
- Built with upstream Vite configuration on 2026-10-18; bundled static output only.
- The app uses the Puter.js SDK (`https://js.puter.com/v2/`) for account sign-in,
  cloud KV/files, and cross-device task sync. Internet access and a Puter account
  are needed for cloud features. Dragon86's Puter Files adapter routes file
  picker operations into ZenFS; the app's normal cloud task data remains in Puter.
- This is a vendored upstream app, not a Dragon86-authored replacement.
