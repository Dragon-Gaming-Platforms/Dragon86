/*! coi-serviceworker v0.1.7 - Guido Zuidhof and contributors, licensed under MIT
    LOCAL MODIFICATIONS (Dragon86):
    1. COOP/COEP/CORP headers are stamped ONLY on navigation (document)
       responses — the only responses cross-origin isolation is decided
       from. Other subresources are no longer header-rewritten.
    2. A cache-first layer serves static assets (scripts, styles, images,
       fonts, wasm…) from Cache Storage, stale-while-revalidate, to make
       repeat loads as cache-driven as possible. EXCLUDED, always live:
       the CheerpX hoster (any URL mentioning CheerpX-Bridge) and the
       Scramjet proxy subtree (dynamic proxied content must never be
       frozen into a cache). Navigations are never cached either.
       NOTE: browsers allow only ONE service worker per scope, so this
       cache layer lives in this worker rather than a second registration.
    3. Navigations into /scramjet/ are exempt from header-stamping:
       Scramjet needs no isolation, and COEP on its document would block
       the proxied subframes it serves.
    4. Navigation fetches revalidate (cache: "no-cache"): GitHub Pages
       serves HTML with max-age=600, so without this a phone can keep
       running the previous build's page (old app list, old editor) for
       minutes after a deploy. The asset cache is versioned
       (dragon86-assets-v2; older versions are deleted on activate).
    Page-half registration/reload logic is unmodified upstream. */

let coepCredentialless = false;
if (typeof window === 'undefined') {
    self.addEventListener("install", () => self.skipWaiting());
    self.addEventListener("activate", (event) => event.waitUntil((async () => {
        // Dragon86: drop asset caches from older worker versions so a
        // deploy never leaves stale static files behind.
        const keys = await caches.keys();
        await Promise.all(keys
            .filter((k) => k.startsWith("dragon86-assets-") && k !== "dragon86-assets-v2")
            .map((k) => caches.delete(k)));
        await self.clients.claim();
    })()));

    self.addEventListener("message", (ev) => {
        if (!ev.data) {
            return;
        } else if (ev.data.type === "deregister") {
            self.registration
                .unregister()
                .then(() => {
                    return self.clients.matchAll();
                })
                .then(clients => {
                    clients.forEach((client) => client.navigate(client.url));
                });
        } else if (ev.data.type === "coepCredentialless") {
            coepCredentialless = ev.data.value;
        }
    });

    self.addEventListener("fetch", function (event) {
        const r = event.request;
        if (r.cache === "only-if-cached" && r.mode !== "same-origin") {
            return;
        }

        // Dragon86 modification: isolation is a property of the DOCUMENT.
        // Only navigation requests (this site's own pages) need COOP/COEP.
        // Everything else — scripts, styles, images, fetch/XHR, workers —
        // is passed through with no respondWith() at all, i.e. byte- and
        // header-identical to having no service worker. (The document's
        // COEP still governs what cross-origin content the page may embed,
        // per normal platform rules; we just stop stamping policy headers
        // onto responses that never needed them. The CheerpX hoster iframe
        // is outside this worker's scope — its own worker isolates its
        // document, and it inherits SharedArrayBuffer from this page being
        // isolated, via allow="cross-origin-isolated".)
        if (r.mode !== "navigate") {
            // Dragon86 cache layer (modification 2): cache-first for
            // static assets, stale-while-revalidate. Never cached: the
            // CheerpX hoster (live engine) and the Scramjet subtree
            // (proxied web content). Cross-origin: only CORS-visible
            // (non-opaque) responses are stored, so we never poison the
            // cache with opaque error bodies.
            if (r.method === "GET" && !r.headers.has("range")) {
                let u;
                try { u = new URL(r.url); } catch { return; }
                const excluded =
                    u.href.includes("CheerpX-Bridge") ||
                    u.pathname.includes("/scramjet/");
                const cacheableDest = ["script", "style", "image", "font", "worker", "manifest", ""].includes(r.destination);
                if (!excluded && cacheableDest) {
                    event.respondWith((async () => {
                        const cache = await caches.open("dragon86-assets-v2");
                        const hit = await cache.match(r, { ignoreSearch: false });
                        const network = fetch(r).then((res) => {
                            if (res && res.status === 200) {
                                cache.put(r, res.clone()).catch(() => {});
                            }
                            return res;
                        }).catch(() => null);
                        if (hit) {
                            // serve instantly, refresh in background
                            network.catch(() => {});
                            return hit;
                        }
                        const res = await network;
                        return res ?? Response.error();
                    })());
                }
            }
            return;
        }

        // Scramjet exemption: its document must NOT carry COEP. Scramjet
        // needs no SharedArrayBuffer, and a COEP document makes the
        // browser block the proxied subframes it serves (they carry no
        // CORP/COEP of their own) — which is why the Browser only worked
        // with isolation fully off (engine tab mode). Same-origin embed
        // under the isolated OS page is still allowed without it.
        try {
            if (new URL(r.url).pathname.includes("/scramjet/")) return;
        } catch { /* fall through and stamp as usual */ }

        event.respondWith(
            // cache:"no-cache" = revalidate the HTML with the server
            // instead of trusting Pages' max-age=600 copy (modification 4).
            fetch(r, { cache: "no-cache" })
                .then((response) => {
                    if (response.status === 0) {
                        return response;
                    }

                    const newHeaders = new Headers(response.headers);
                    newHeaders.set("Cross-Origin-Embedder-Policy",
                        coepCredentialless ? "credentialless" : "require-corp"
                    );
                    if (!coepCredentialless) {
                        newHeaders.set("Cross-Origin-Resource-Policy", "cross-origin");
                    }
                    newHeaders.set("Cross-Origin-Opener-Policy", "same-origin");

                    return new Response(response.body, {
                        status: response.status,
                        statusText: response.statusText,
                        headers: newHeaders,
                    });
                })
                .catch((e) => console.error(e))
        );
    });

} else {
    (() => {
        const reloadedBySelf = window.sessionStorage.getItem("coiReloadedBySelf");
        window.sessionStorage.removeItem("coiReloadedBySelf");
        const coepDegrading = (reloadedBySelf == "coepdegrade");

        // You can customize the behavior of this script through a global `coi` variable.
        const coi = {
            shouldRegister: () => !reloadedBySelf,
            shouldDeregister: () => false,
            coepCredentialless: () => true,
            coepDegrade: () => true,
            doReload: () => window.location.reload(),
            quiet: false,
            ...window.coi
        };

        const n = navigator;
        const controlling = n.serviceWorker && n.serviceWorker.controller;

        // Record the failure if the page is served by serviceWorker.
        if (controlling && !window.crossOriginIsolated) {
            window.sessionStorage.setItem("coiCoepHasFailed", "true");
        }
        const coepHasFailed = window.sessionStorage.getItem("coiCoepHasFailed");

        if (controlling) {
            // Reload only on the first failure.
            const reloadToDegrade = coi.coepDegrade() && !(
                coepDegrading || window.crossOriginIsolated
            );
            n.serviceWorker.controller.postMessage({
                type: "coepCredentialless",
                value: (reloadToDegrade || coepHasFailed && coi.coepDegrade())
                    ? false
                    : coi.coepCredentialless(),
            });
            if (reloadToDegrade) {
                !coi.quiet && console.log("Reloading page to degrade COEP.");
                window.sessionStorage.setItem("coiReloadedBySelf", "coepdegrade");
                coi.doReload("coepdegrade");
            }

            if (coi.shouldDeregister()) {
                n.serviceWorker.controller.postMessage({ type: "deregister" });
            }
        }

        // If we're already coi: do nothing. Perhaps it's due to this script doing its job, or COOP/COEP are
        // already set from the origin server. Also if the browser has no notion of crossOriginIsolated, just give up here.
        if (window.crossOriginIsolated !== false || !coi.shouldRegister()) return;

        if (!window.isSecureContext) {
            !coi.quiet && console.log("COOP/COEP Service Worker not registered, a secure context is required.");
            return;
        }

        // In some environments (e.g. Firefox private mode) this won't be available
        if (!n.serviceWorker) {
            !coi.quiet && console.error("COOP/COEP Service Worker not registered, perhaps due to private mode.");
            return;
        }

        n.serviceWorker.register(window.document.currentScript.src).then(
            (registration) => {
                !coi.quiet && console.log("COOP/COEP Service Worker registered", registration.scope);

                registration.addEventListener("updatefound", () => {
                    !coi.quiet && console.log("Reloading page to make use of updated COOP/COEP Service Worker.");
                    window.sessionStorage.setItem("coiReloadedBySelf", "updatefound");
                    coi.doReload();
                });

                // If the registration is active, but it's not controlling the page
                if (registration.active && !n.serviceWorker.controller) {
                    !coi.quiet && console.log("Reloading page to make use of COOP/COEP Service Worker.");
                    window.sessionStorage.setItem("coiReloadedBySelf", "notcontrolling");
                    coi.doReload();
                }
            },
            (err) => {
                !coi.quiet && console.error("COOP/COEP Service Worker failed to register:", err);
            }
        );
    })();
}
