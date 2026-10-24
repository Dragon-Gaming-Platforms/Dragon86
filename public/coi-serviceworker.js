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
    5. Deregistration is deterministic and page-side: when the selected
       engine needs no isolation (v86, separate tab), the page calls
       navigator.serviceWorker.getRegistrations() and unregisters the
       worker itself, then reloads once so the next document carries no
       COOP/COEP. It no longer depends on a postMessage reaching a
       possibly-dead worker (and the worker's deregister handler now uses
       waitUntil so its unregister + reload chain cannot be cut short).
    Page-half registration logic is otherwise unmodified upstream. */


/* ------------------------------------------------------------------------
   Dragon86: MASTER SWITCH for the cross-origin-isolation half of this file.
   ------------------------------------------------------------------------
   Isolation is only needed while the CheerpX engine runs embedded: the
   hoster iframe wants SharedArrayBuffer, which a document only gets when it
   is cross-origin isolated, and GitHub Pages cannot send COOP/COEP, so this
   worker stamps them onto our document responses.

   A browser allows ONE service worker per scope, and the filesystem-app
   server (public/app-sw.js) now needs that scope — so this half is switched
   OFF here rather than fought over. While it is off this file does nothing:
   no registration, no header stamping, no deregistration, and no asset cache
   (the cache lives in this same worker and is deliberately NOT merged into
   app-sw.js yet). Flip the flag back to true to restore the old behaviour,
   cache included, at the cost of filesystem apps.

   Read from window/self so a test — or a future Settings toggle — can turn
   it on without editing this file. */
const D86_COI = (typeof window !== 'undefined')
    ? window.D86_COI === true
    : (typeof self !== 'undefined' && self.D86_COI === true);

let coepCredentialless = false;
if (typeof window === 'undefined') {
  if (!D86_COI) {
    /* Filesystem apps own this scope: the worker must exist but do nothing. */
    self.addEventListener("install", () => self.skipWaiting());
  } else {
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
            // Dragon86: waitUntil() is mandatory here. Without it the worker
            // may be terminated the moment this handler returns, and the
            // unregister -> reload chain (the reload is what actually
            // removes COOP/COEP from the document) silently never finishes.
            ev.waitUntil((async () => {
                try {
                    await self.registration.unregister();
                } catch (err) {
                    console.error("coi: unregister failed", err);
                }
                try {
                    const clients = await self.clients.matchAll({ type: "window" });
                    clients.forEach((client) => {
                        client.navigate(client.url).catch(() => {});
                    });
                } catch (err) {
                    console.error("coi: client reload failed", err);
                }
            })());
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
  }
} else {
    if (!D86_COI) {
        /* COI page half off (D86_COI=false): no registration, no reload, no
           deregistration — public/app-sw.js owns the service worker scope. */
        if (window.console) {
            console.log("Dragon86: COI half disabled (D86_COI=false) — app-sw.js owns the service worker scope.");
        }
    } else (() => {
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

        /* Dragon86 modification 5: turning isolation OFF must be
           deterministic. v86 and separate-tab mode do not need COOP/COEP,
           and they used to rely on messaging the controller — a worker that
           might already be gone, and whose handler was not kept alive. If
           that message was lost, the registration survived and every reload
           came back isolated. Now the page unregisters the worker itself,
           through the registration API, and reloads exactly once so the
           next document is served without the headers. */
        if (coi.shouldDeregister && coi.shouldDeregister()) {
            const KEY = "coiDeregistered";
            const store = (() => {
                try { return window.sessionStorage; } catch { return null; }
            })();
            const already = store ? store.getItem(KEY) === "1" : false;
            const controlled = !!n.serviceWorker.controller;
            const isolated = window.crossOriginIsolated === true;

            const done = (reason) => {
                if (store) store.removeItem(KEY);
                /* Reload only when this document was actually served through
                   the worker (or is isolated because of it). After the reload
                   there is no controller, so this cannot loop; `already`
                   covers the case where unregistering itself failed. */
                if ((controlled || isolated) && !already) {
                    if (store) store.setItem(KEY, "1");
                    !coi.quiet && console.log(`Dragon86: engine does not need isolation (${reason}) — service worker removed, reloading once.`);
                    coi.doReload();
                } else {
                    !coi.quiet && console.log(`Dragon86: isolation off, no service worker controlling this page (${reason}).`);
                }
            };

            if (!n.serviceWorker) {
                done("no service worker support");
            } else if (typeof n.serviceWorker.getRegistrations !== "function") {
                /* Very old browsers: fall back to the upstream message path. */
                if (n.serviceWorker.controller) {
                    n.serviceWorker.controller.postMessage({ type: "deregister" });
                }
                done("legacy deregister");
            } else {
                if (store) store.setItem(KEY, already ? "1" : "0");
                Promise.resolve(n.serviceWorker.getRegistrations())
                    .then((regs) => Promise.all(regs
                        /* Only our own worker: coi-serviceworker's script URL. */
                        .filter((r) => !r.active || /coi-serviceworker\.js/.test(r.active.scriptURL || ""))
                        .map((r) => {
                            try { return r.unregister(); } catch { return undefined; }
                        })))
                    .then(
                        () => done("unregistered"),
                        (err) => {
                            !coi.quiet && console.warn("Dragon86: unregister failed, falling back to message", err);
                            if (n.serviceWorker.controller) {
                                n.serviceWorker.controller.postMessage({ type: "deregister" });
                            }
                            done("unregister failed");
                        },
                    );
            }
            return;
        }
        if (window.sessionStorage.getItem("coiDeregistered")) {
            window.sessionStorage.removeItem("coiDeregistered");
        }

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
