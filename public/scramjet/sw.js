/* Dragon86 Browser (Scramjet) service worker.
   Scoped to this directory (/Dragon86/scramjet/) by its location.
   Path corrected from the upstream demo: it used "/controller/..." (site
   root); ours is relative so it works under the GitHub Pages project path. */
importScripts("./controller/controller.sw.js");

addEventListener("fetch", (e) => {
	if ($scramjetController.shouldRoute(e)) {
		e.respondWith($scramjetController.route(e));
	}
});
