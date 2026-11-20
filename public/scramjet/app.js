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
	transport: "epoxy",
	home: "https://www.google.com",
};
let settings = { ...defaults };
try {
	const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
	settings = { ...defaults, ...saved };
	/* Version 3 makes Epoxy the default. Upgrade the previous default once;
	   retain Epoxy choices and any newer explicitly saved preference. */
	if (saved.transportVersion !== 3) {
		if (!saved.transport || saved.transport === "libcurl") settings.transport = defaults.transport;
		settings.transportVersion = 3;
		localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
	}
	if (!["libcurl", "epoxy"].includes(settings.transport)) settings.transport = defaults.transport;
} catch { /* keep defaults */ }

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const urlEl = $("url");
const tabsEl = $("tabs");
const viewportEl = $("viewport");
const fullscreen = new URLSearchParams(location.search).get("fullscreen") === "1";
if (fullscreen) document.documentElement.classList.add("fullscreen");

const tabs = [];
let activeTab = null;
let nextTabId = 1;
let controller = null;

function setStatus(msg, isError = false) {
	statusEl.textContent = msg;
	statusEl.classList.toggle("error", isError);
	$("status-indicator").classList.toggle("error", isError);
	$("status-indicator").classList.toggle("ready", !isError && msg === "Ready.");
	console.log(`[D86:browser] ${msg}`);
}

function updateConnectionMeta() {
	let host = "custom relay";
	try { host = new URL(settings.wisp).host; } catch { /* friendly fallback */ }
	$("status-transport").textContent = `${settings.transport} · ${host}`;
	$("settings-btn").title = `Connection settings · ${settings.transport} · ${host}`;
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

async function makeTransport() {
	if (settings.transport === "libcurl") {
		const { default: LibcurlClient } = await import("./transport/libcurl.mjs");
		return new LibcurlClient({ wisp: settings.wisp });
	}
	const { default: EpoxyClient } = await import("./transport/epoxy.mjs");
	return new EpoxyClient({ wisp: settings.wisp });
}

let utilsModule = null;

function labelForUrl(url) {
	try { return new URL(url).hostname.replace(/^www\./, "") || "New tab"; }
	catch { return "New tab"; }
}

function renderTabs() {
	tabsEl.replaceChildren();
	for (const tab of tabs) {
		const item = document.createElement("div");
		item.className = tab === activeTab ? "tab active" : "tab";
		const select = document.createElement("button");
		select.type = "button";
		select.className = "tab-select";
		select.setAttribute("role", "tab");
		select.setAttribute("aria-selected", String(tab === activeTab));
		select.title = tab.url || tab.label;
		select.textContent = tab.label;
		select.addEventListener("click", () => activateTab(tab));
		const close = document.createElement("button");
		close.type = "button";
		close.className = "tab-close";
		close.setAttribute("aria-label", `Close ${tab.label}`);
		close.title = `Close ${tab.label}`;
		close.textContent = "×";
		close.addEventListener("click", () => closeTab(tab));
		item.append(select, close);
		tabsEl.append(item);
	}
	if (!fullscreen) {
		const add = document.createElement("button");
		add.type = "button";
		add.id = "new-tab";
		add.title = "New tab (Ctrl+T)";
		add.setAttribute("aria-label", "New tab");
		add.textContent = "+";
		add.addEventListener("click", () => createTab(settings.home));
		tabsEl.append(add);
	}
}

function activateTab(tab) {
	if (!tabs.includes(tab)) return;
	activeTab = tab;
	for (const item of tabs) item.iframe.hidden = item !== tab;
	urlEl.value = tab.url || "";
	renderTabs();
}

function closeTab(tab) {
	const index = tabs.indexOf(tab);
	if (index < 0) return;
	tab.iframe.remove();
	tabs.splice(index, 1);
	if (!tabs.length) {
		activeTab = null;
		createTab(settings.home);
		return;
	}
	if (tab === activeTab) activateTab(tabs[Math.min(index, tabs.length - 1)]);
	else renderTabs();
}

function createTab(raw = settings.home) {
	if (!controller) return null;
	const initialUrl = normalizeInput(raw) || settings.home;
	const iframe = document.createElement("iframe");
	iframe.className = "browser-frame";
	iframe.title = "Proxied web page";
	iframe.referrerPolicy = "no-referrer";
	const tab = { id: nextTabId++, url: initialUrl, label: labelForUrl(initialUrl), iframe, frame: null };
	tabs.push(tab);
	viewportEl.append(iframe);
	const plugins = [];
	if (utilsModule) {
		plugins.push(new utilsModule.UrlWatcherPlugin((url) => {
			tab.url = url;
			tab.label = labelForUrl(url);
			if (activeTab === tab && document.activeElement !== urlEl) urlEl.value = url;
			renderTabs();
		}));
		plugins.push(new utilsModule.HttpCachePlugin());
	}
	tab.frame = controller.createFrame(iframe, plugins.length ? { plugins } : undefined);
	activateTab(tab);
	tab.frame.go(initialUrl);
	setStatus(`Loading ${initialUrl} …`);
	return tab;
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
				setTimeout(resolve, 8000);
			});
		}
		const sw = navigator.serviceWorker.controller ?? registration.active;
		if (!sw) throw new Error("No service worker available");

		setStatus(`Connecting to Wisp (${settings.wisp}) via ${settings.transport}…`);
		const { Controller } = $scramjetController;
		controller = new Controller({
			serviceworker: sw,
			transport: await makeTransport(),
			config: {
				prefix: new URL("~/sj/", BASE).pathname,
				scramjetPath: new URL("scramjet/scramjet.js", BASE).pathname,
				injectPath: new URL("controller/controller.inject.js", BASE).pathname,
				wasmPath: new URL("scramjet/scramjet.wasm", BASE).pathname,
			},
		});
		await controller.wait();

		try { utilsModule = await import("./utils/scramjet-utils.mjs"); }
		catch (err) { console.warn("[D86:browser] utils plugins unavailable, continuing without:", err); }

		setStatus("Ready.");
		const start = new URLSearchParams(location.search).get("goto") || settings.home;
		createTab(start);
	} catch (err) {
		console.error("[D86:browser]", err);
		setStatus(`Failed to start: ${err?.message || err}`, true);
	}
}

function navigate(raw) {
	const url = normalizeInput(raw);
	if (!url || !activeTab?.frame) return;
	activeTab.url = url;
	activeTab.label = labelForUrl(url);
	urlEl.value = url;
	renderTabs();
	setStatus(`Loading ${url} …`);
	activeTab.frame.go(url);
}

$("go-form").addEventListener("submit", (e) => {
	e.preventDefault();
	navigate(urlEl.value);
});
$("back").addEventListener("click", () => activeTab?.frame?.back());
$("forward").addEventListener("click", () => activeTab?.frame?.forward());
$("reload").addEventListener("click", () => activeTab?.frame?.reload());
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
	settings.transportVersion = 3;
	localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
	const next = new URL(location.href);
	if (activeTab?.url) next.searchParams.set("goto", activeTab.url);
	location.assign(next.href);
});
document.addEventListener("keydown", (event) => {
	if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l" && !fullscreen) {
		e.preventDefault();
		urlEl.focus();
		urlEl.select();
	} else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "t" && !fullscreen) {
		e.preventDefault();
		createTab(settings.home);
	} else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "w" && !fullscreen) {
		e.preventDefault();
		if (activeTab) closeTab(activeTab);
	} else if (event.key === "Escape" && $("settings").classList.contains("open")) {
		$("settings").classList.remove("open");
		$("settings-btn").setAttribute("aria-expanded", "false");
		$("settings-btn").focus();
	}
});

void init();
