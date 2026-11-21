/* Dragon86 Browser — minimal Scramjet front end.
 *
 * Vendored pieces (see VENDORED.md):
 *   ./scramjet/scramjet.js + scramjet.wasm   @mercuryworkshop/scramjet@2.1.0
 *   ./controller/controller.{api,inject,sw}.js @mercuryworkshop/scramjet-controller@0.1.0
 *   ./transport/{epoxy,libcurl}.mjs          epoxy-transport@3.0.2 / libcurl-transport@2.0.6
 *   ./utils/scramjet-utils.mjs              @mercuryworkshop/scramjet-utils@0.0.3 (v2 compat patch)
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
	let transport;
	if (settings.transport === "libcurl") {
		const { default: LibcurlTransport } = await import("./transport/libcurl.mjs");
		transport = new LibcurlTransport({ wisp: settings.wisp });
	} else {
		const { default: EpoxyTransport } = await import("./transport/epoxy.mjs");
		transport = new EpoxyTransport({ wisp: settings.wisp });
	}
	/* v2 transports initialize their WASM/client explicitly; do this before
	   Controller hands them requests from the service worker. */
	await transport.init();
	return transport;
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
	attachFileBridge(tab);
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


/* File bridge: proxies still use the stock Scramjet runtime. The Dragon86-owned
   browser shell maps explicit file-input and download-link actions to ZenFS. */
const zenFs = () => {
	try { return window.parent !== window ? window.parent.d86?.fs ?? null : null; }
	catch { return null; }
};
let pendingUpload = null;
let pickerFolder = "/home/user";
const selectedPaths = new Set();

function openPicker(input, frameWindow) {
	if (!zenFs()) {
		setStatus("ZenFS file access is available when Scramjet runs inside Dragon86.", true);
		return;
	}
	pendingUpload = { input, frameWindow };
	pickerFolder = "/home/user";
	selectedPaths.clear();
	$("picker-path").value = pickerFolder;
	$("picker-attach").disabled = true;
	$("picker-attach").textContent = "Choose files";
	$("fs-picker").hidden = false;
	$("fs-picker").setAttribute("aria-hidden", "false");
	void renderPicker();
}

function closePicker() {
	$("fs-picker").hidden = true;
	$("fs-picker").setAttribute("aria-hidden", "true");
	pendingUpload = null;
	selectedPaths.clear();
}

async function renderPicker(path = pickerFolder) {
	const fs = zenFs();
	const list = $("picker-list");
	pickerFolder = path;
	$("picker-path").value = path;
	list.replaceChildren();
	try {
		const entries = await fs.list(path);
		if (path !== "/") {
			const parent = document.createElement("button");
			parent.type = "button";
			parent.className = "picker-entry";
			parent.textContent = "↰  Parent folder";
			parent.addEventListener("click", () => void renderPicker(path.slice(0, path.lastIndexOf("/")) || "/"));
			list.append(parent);
		}
		entries.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
		for (const entry of entries) {
			if (entry.isDirectory) {
				const button = document.createElement("button");
				button.type = "button";
				button.className = "picker-entry";
				button.textContent = `📁  ${entry.name}`;
				button.addEventListener("click", () => void renderPicker(entry.path));
				list.append(button);
				continue;
			}
			const button = document.createElement("button");
			button.type = "button";
			button.className = `picker-entry${selectedPaths.has(entry.path) ? " selected" : ""}`;
			button.setAttribute("role", "option");
			button.setAttribute("aria-selected", String(selectedPaths.has(entry.path)));
			button.textContent = `▧  ${entry.name}`;
			const size = document.createElement("small");
			size.textContent = entry.size < 1024 * 1024 ? `${Math.ceil(entry.size / 1024)} KB` : `${(entry.size / 1048576).toFixed(1)} MB`;
			button.append(size);
			button.addEventListener("click", () => {
				if (!pendingUpload?.input.multiple) selectedPaths.clear();
				if (selectedPaths.has(entry.path)) selectedPaths.delete(entry.path);
				else selectedPaths.add(entry.path);
				void renderPicker(path);
			});
			list.append(button);
		}
		if (!entries.length) {
			const empty = document.createElement("p");
			empty.className = "picker-message";
			empty.textContent = "This folder is empty.";
			list.append(empty);
		}
	} catch (error) {
		const message = document.createElement("p");
		message.className = "picker-message";
		message.textContent = `Could not read this folder: ${error?.message || error}`;
		list.append(message);
	}
	$("picker-attach").disabled = selectedPaths.size === 0;
	$("picker-attach").textContent = selectedPaths.size ? `Choose ${selectedPaths.size} file${selectedPaths.size === 1 ? "" : "s"}` : "Choose files";
}

async function attachSelectedFiles() {
	const pending = pendingUpload;
	const fs = zenFs();
	if (!pending || !fs || !selectedPaths.size) return;
	const paths = [...selectedPaths];
	const input = pending.input;
	const frameWindow = pending.frameWindow;
	try {
		const transfer = new frameWindow.DataTransfer();
		for (const path of paths) {
			const bytes = await fs.readBytes(path);
			transfer.items.add(new frameWindow.File([bytes], path.slice(path.lastIndexOf("/") + 1)));
		}
		input.files = transfer.files;
		input.dispatchEvent(new frameWindow.Event("input", { bubbles: true }));
		input.dispatchEvent(new frameWindow.Event("change", { bubbles: true }));
		setStatus(`Selected ${paths.length} file${paths.length === 1 ? "" : "s"} from Dragon86 Files.`);
		closePicker();
	} catch (error) {
		setStatus(`Could not attach ZenFS file: ${error?.message || error}`, true);
	}
}

function attachFileBridge(tab) {
	tab.iframe.addEventListener("load", () => {
		let doc;
		let frameWindow;
		try {
			frameWindow = tab.iframe.contentWindow;
			doc = tab.iframe.contentDocument;
			if (!doc || !frameWindow || doc === document || doc.documentElement.dataset.d86FileBridge === "1") return;
			doc.documentElement.dataset.d86FileBridge = "1";
		} catch {
			return; // inaccessible proxied documents retain their native behavior
		}
		let trustedGestureAt = 0;
		doc.addEventListener("click", (event) => {
			if (event.isTrusted) trustedGestureAt = Date.now();
			const userInitiated = event.isTrusted || Date.now() - trustedGestureAt < 1500;
			const target = event.target instanceof frameWindow.Element ? event.target : null;
			let input = target?.closest('input[type="file"]');
			if (!input) input = target?.closest("label")?.control ?? null;
			if (input?.type === "file" && userInitiated && zenFs()) {
				event.preventDefault();
				event.stopImmediatePropagation();
				openPicker(input, frameWindow);
				return;
			}
			const anchor = target?.closest("a[href]");
			const downloadLike = anchor && (anchor.hasAttribute("download") || /\.(?:7z|apk|csv|deb|dmg|docx?|exe|gz|iso|jar|jpg|jpeg|mp3|mp4|pdf|png|pptx?|rar|rpm|tar|tgz|txt|wav|webm|xlsx?|zip)(?:[?#]|$)/i.test(anchor.href));
			if (downloadLike && userInitiated && zenFs()) {
				event.preventDefault();
				event.stopImmediatePropagation();
				void saveDownload(tab, anchor);
			}
		}, true);
		const hasDraggedFiles = (event) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
		doc.addEventListener("dragover", (event) => {
			if (hasDraggedFiles(event) && zenFs()) {
				event.preventDefault();
				event.dataTransfer.dropEffect = "none";
			}
		}, true);
		doc.addEventListener("drop", (event) => {
			if (!event.isTrusted || !event.dataTransfer?.files?.length || !zenFs()) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			const fileInput = doc.querySelector('input[type="file"]');
			if (fileInput) openPicker(fileInput, frameWindow);
			else setStatus("Local file drops are disabled; use a site file picker to select a file from Dragon86 Files.", true);
		}, true);
	});
}

function downloadName(anchor, response) {
	const disposition = response.headers.get("content-disposition") || "";
	const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
	const quoted = disposition.match(/filename\s*=\s*"([^"]+)"/i)?.[1];
	const plain = disposition.match(/filename\s*=\s*([^;]+)/i)?.[1]?.trim();
	let name = anchor.download || quoted || plain || "";
	if (!name && encoded) {
		try { name = decodeURIComponent(encoded); } catch { name = encoded; }
	}
	if (!name) {
		try { name = new URL(anchor.href).pathname.split("/").filter(Boolean).at(-1) || "download"; }
		catch { name = "download"; }
	}
	return name.split(/[\\/]/).at(-1).replace(/[<>:"|?*\u0000-\u001f]/g, "_").trim() || "download";
}

async function saveDownload(tab, anchor) {
	const fs = zenFs();
	if (!fs) return;
	try {
		setStatus("Saving download to Dragon86 Files…");
		const frameWindow = tab.iframe.contentWindow;
		const response = await frameWindow.fetch(anchor.href, { credentials: "include" });
		if (!response.ok) throw new Error(`download request failed (${response.status})`);
		const bytes = new Uint8Array(await response.arrayBuffer());
		const directory = "/home/user/Downloads";
		await fs.mkdir(directory);
		const name = downloadName(anchor, response);
		let path = `${directory}/${name}`;
		const extension = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
		const stem = extension ? name.slice(0, -extension.length) : name;
		let suffix = 2;
		while (await fs.exists(path)) path = `${directory}/${stem} (${suffix++})${extension}`;
		await fs.writeBytes(path, bytes);
		setStatus(`Saved ${path} in Dragon86 Files.`);
		window.parent.d86?.notify?.({ title: "Download saved", body: path });
	} catch (error) {
		setStatus(`Could not save download to ZenFS: ${error?.message || error}`, true);
	}
}

$("picker-cancel").addEventListener("click", closePicker);
$("picker-attach").addEventListener("click", () => void attachSelectedFiles());
$("picker-path").addEventListener("keydown", (event) => {
	if (event.key === "Enter") {
		event.preventDefault();
		void renderPicker($("picker-path").value.trim() || "/home/user");
	}
});

void init();
