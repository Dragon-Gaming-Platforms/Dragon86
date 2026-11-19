/* Dragon86 Browser — minimal Scramjet front end.
 *
 * Vendored pieces (see VENDORED.md):
 *   ./scramjet/scramjet.js + scramjet.wasm   @mercuryworkshop/scramjet@2.0.67-alpha.2
 *   ./controller/controller.{api,inject,sw}.js @mercuryworkshop/scramjet-controller@0.0.14
 *   ./transport/{epoxy,libcurl}.mjs          epoxy-transport@3.0.1 / libcurl-transport@2.0.5
 *   ./utils/scramjet-utils.mjs              @mercuryworkshop/scramjet-utils@0.0.3
 *
 * ALL paths are computed from this page's own directory. The upstream demo
 * hardcodes site-root paths ("/scramjet/scramjet.js", "/controller/...",
 * prefix "/~/sj/") which break under the GitHub Pages project path
 * (/Dragon86/scramjet/) — that's the "file path mismatch" class of bug
 * this file exists to correct.
 */

const BASE = new URL("./", window.location.href);
const SETTINGS_KEY = "dragon86.browser";

const defaults = {
	wisp: "wss://anura.pro/",
	transport: "libcurl",
	home: "https://www.google.com",
};
let settings = { ...defaults };
try {
	const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
	settings = { ...defaults, ...saved };
	/* The old default was Epoxy. Upgrade that default once, but remember
	   explicit choices from this version and later. */
	if (saved.transportVersion !== 2) {
		if (saved.transport === "epoxy") settings.transport = defaults.transport;
		settings.transportVersion = 2;
		localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
	}
	if (!["libcurl", "epoxy"].includes(settings.transport)) settings.transport = defaults.transport;
} catch { /* keep defaults */ }

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const urlEl = $("url");
const viewEl = $("view");

function setStatus(msg, isError = false) {
	statusEl.textContent = msg;
	statusEl.classList.toggle("error", isError);
	$("status-indicator").classList.toggle("error", isError);
	$("status-indicator").classList.toggle("ready", !isError && msg === "Ready.");
	console.log(`[D86:browser] ${msg}`);
}

function updateConnectionMeta() {
	let host = "custom relay";
	let secure = false;
	try {
		const relay = new URL(settings.wisp);
		host = relay.host;
		secure = relay.protocol === "wss:";
	} catch { /* keep the friendly fallback */ }
	$("status-transport").textContent = `${settings.transport} · ${host}`;
	$("relay-security-text").textContent = secure ? "Secure WSS" : "Custom relay";
	$("relay-security").classList.toggle("insecure", !secure);
	$("relay-security").title = secure ? "Encrypted WebSocket to your selected Wisp relay" : "Your selected relay is not using secure WebSockets";
}
updateConnectionMeta();

function normalizeInput(raw) {
	const v = raw.trim();
	if (!v) return null;
	if (/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(v)) return v;
	// "example.com" or "localhost:8080/x" → assume https site
	if (!/\s/.test(v) && (v.includes(".") || v.startsWith("localhost"))) {
		return `https://${v}`;
	}
	// otherwise treat as a search
	return `https://duckduckgo.com/html/?q=${encodeURIComponent(v)}`;
}

let controller = null;
let frame = null;

async function makeTransport() {
	if (settings.transport === "libcurl") {
		const { default: LibcurlClient } = await import("./transport/libcurl.mjs");
		return new LibcurlClient({ wisp: settings.wisp });
	}
	const { default: EpoxyClient } = await import("./transport/epoxy.mjs");
	return new EpoxyClient({ wisp: settings.wisp });
}

async function init() {
	try {
		setStatus("Registering service worker…");
		const registration = await navigator.serviceWorker.register("./sw.js");
		if (!navigator.serviceWorker.controller) {
			setStatus("Service worker installing — waiting for control…");
			await new Promise((resolve) => {
				const onChange = () => {
					navigator.serviceWorker.removeEventListener("controllerchange", onChange);
					resolve();
				};
				navigator.serviceWorker.addEventListener("controllerchange", onChange);
				setTimeout(resolve, 8000); // don't hang forever
			});
		}
		const sw = navigator.serviceWorker.controller ?? registration.active;
		if (!sw) throw new Error("No service worker available");

		setStatus(`Connecting to Wisp (${settings.wisp}) via ${settings.transport}…`);
		const { Controller } = $scramjetController;
		controller = new Controller({
			serviceworker: sw,
			transport: await makeTransport(),
			/* Path corrections vs upstream defaults (site-root absolutes). */
			config: {
				prefix: new URL("~/sj/", BASE).pathname,
				scramjetPath: new URL("scramjet/scramjet.js", BASE).pathname,
				injectPath: new URL("controller/controller.inject.js", BASE).pathname,
				wasmPath: new URL("scramjet/scramjet.wasm", BASE).pathname,
			},
		});
		await controller.wait();

		// Optional utils plugins (URL bar sync + HTTP cache). Non-fatal if
		// they ever drift from the controller build: browsing still works.
		let plugins = [];
		try {
			const utils = await import("./utils/scramjet-utils.mjs");
			plugins = [
				new utils.UrlWatcherPlugin((url) => {
					if (document.activeElement !== urlEl) urlEl.value = url;
				}),
				new utils.HttpCachePlugin(),
			];
		} catch (err) {
			console.warn("[D86:browser] utils plugins unavailable, continuing without:", err);
		}

		frame = controller.createFrame(viewEl, plugins.length ? { plugins } : undefined);
		setStatus("Ready.");
		const start = new URLSearchParams(location.search).get("goto") || settings.home;
		navigate(start);
	} catch (err) {
		console.error("[D86:browser]", err);
		setStatus(`Failed to start: ${err?.message || err}`, true);
	}
}

function navigate(raw) {
	const url = normalizeInput(raw);
	if (!url || !frame) return;
	urlEl.value = url;
	setStatus(`Loading ${url} …`);
	frame.go(url);
}

$("go-form").addEventListener("submit", (e) => {
	e.preventDefault();
	navigate(urlEl.value);
});
$("back").addEventListener("click", () => frame?.back());
$("forward").addEventListener("click", () => frame?.forward());
$("reload").addEventListener("click", () => frame?.reload());
$("home").addEventListener("click", () => navigate(settings.home));

/* settings panel */
$("wisp").value = settings.wisp;
$("transport").value = settings.transport;
$("settings-btn").addEventListener("click", () => {
	const open = !$("settings").classList.contains("open");
	$("settings").classList.toggle("open", open);
	$("settings-btn").setAttribute("aria-expanded", String(open));
});
$("transport").addEventListener("change", () => {
	settings.transport = $("transport").value;
	updateConnectionMeta();
});
$("save-settings").addEventListener("click", () => {
	const relayInput = $("wisp").value.trim() || defaults.wisp;
	let relay;
	try { relay = new URL(relayInput); } catch {
		setStatus("Enter a valid Wisp WebSocket URL.", true);
		$("wisp").focus();
		return;
	}
	if (!["wss:", "ws:"].includes(relay.protocol) || !relay.host) {
		setStatus("Relay URL must use wss:// (recommended) or ws://.", true);
		$("wisp").focus();
		return;
	}
	settings.wisp = relay.href;
	settings.transport = $("transport").value;
	settings.transportVersion = 2;
	localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
	location.reload();
});
document.addEventListener("keydown", (event) => {
	if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l") {
		e.preventDefault();
		urlEl.focus();
		urlEl.select();
	} else if (event.key === "Escape" && $("settings").classList.contains("open")) {
		$("settings").classList.remove("open");
		$("settings-btn").setAttribute("aria-expanded", "false");
		$("settings-btn").focus();
	}
});

void init();
