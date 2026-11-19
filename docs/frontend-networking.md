# Dragon86 frontend polish and shared relay

The Dragon86-owned Scramjet page (`public/scramjet/index.html` and
`public/scramjet/app.js`) has a responsive toolbar, accessible navigation and
connection settings, a clear status indicator, reduced-motion support, and a
small-screen layout. Its default transport is **libcurl**. Existing settings
from the former Epoxy default are upgraded once; after that, an explicit
transport choice is preserved. Epoxy remains available as an alternate.

Scramjet and the v86 guest NIC use the same secure Wisp service by default:

- Scramjet connects to `wss://anura.pro/`.
- v86 stores `wisps://anura.pro/` to select v86's Wisp protocol; its websocket
  implementation translates that to the same `wss://anura.pro/` socket.
- Settings → Machine shows the canonical WSS address, lets users restore the
  shared default, test the endpoint, choose a custom relay, or turn networking
  off. The old default `wss://relay.widgetry.org/` is migrated; custom saved
  relay choices are retained.

The public relay is shared with other users, so it is suitable as a default,
not a privacy guarantee. Users should select a relay they trust or self-host
one. Scramjet's transport preference and v86's guest NIC setting remain
independently configurable after the defaults are applied.

Only Dragon86-authored UI and integration code is changed. Vendored frontends
and their runtime files remain untouched.
