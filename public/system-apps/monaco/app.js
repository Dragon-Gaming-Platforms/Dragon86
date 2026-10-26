/**
 * Monaco Editor — the App Store app.
 *
 * This page is served from ~/system/apps/monaco/ (9pf route), so it is a real
 * same-origin page; the editor assets themselves are the OS's vendored copy
 * at <base>monaco/vs — nothing is fetched from a CDN.
 *
 * Files are the OS's files: the page talks to `parent.d86` (the scripting API
 * in core/dev-api.ts), which is the same ZenFS the Files app shows. There is
 * no copy step and no shared folder — Save writes the file you opened.
 *
 * The OS hands the window a file with `?file=<absolute path>` (see
 * apps/iframe-app.ts).
 */

(function () {
  "use strict";

  var api = null;
  try {
    api = window.parent && window.parent !== window ? window.parent.d86 : window.d86;
  } catch (err) {
    api = null;
  }

  var params = new URLSearchParams(location.search);
  var startFile = params.get("file");
  var currentPath = startFile || null;
  var dirty = false;
  var editor = null;
  var monaco = null;

  var splash = document.getElementById("splash");
  var splashText = document.getElementById("splash-text");
  var pathLabel = document.getElementById("path");
  var statusPath = document.getElementById("status-path");
  var statusStats = document.getElementById("status-stats");
  var statusState = document.getElementById("status-state");
  var saveBtn = document.getElementById("save");
  var openBtn = document.getElementById("open");

  function say(text) {
    splashText.textContent = text;
  }

  function fail(title, detail) {
    splash.classList.add("error");
    splash.querySelector("strong").textContent = title;
    splashText.textContent = detail;
    splash.style.display = "grid";
  }

  function baseName(path) {
    var at = path.lastIndexOf("/");
    return at >= 0 ? path.slice(at + 1) : path;
  }

  var EXT_LANG = {
    ts: "typescript", mts: "typescript", js: "javascript", mjs: "javascript",
    cjs: "javascript", jsx: "javascript", tsx: "typescript",
    json: "json", jsonc: "json", html: "html", htm: "html", css: "css",
    scss: "scss", less: "less", md: "markdown", markdown: "markdown",
    py: "python", sh: "shell", bash: "shell", zsh: "shell",
    xml: "xml", svg: "xml", yml: "yaml", yaml: "yaml", toml: "ini",
    ini: "ini", c: "c", h: "c", cpp: "cpp", cs: "csharp", go: "go",
    rs: "rust", java: "java", php: "php", rb: "ruby", sql: "sql",
    lua: "lua", txt: "plaintext", log: "plaintext"
  };

  function languageFor(path) {
    if (!path) return "plaintext";
    var name = baseName(path);
    var dot = name.lastIndexOf(".");
    if (dot <= 0) return "plaintext";
    return EXT_LANG[name.slice(dot + 1).toLowerCase()] || "plaintext";
  }

  function refresh() {
    var text = editor ? editor.getValue() : "";
    var lines = text ? text.split("\n").length : 0;
    pathLabel.textContent = currentPath || "(unsaved)";
    statusPath.textContent = currentPath || "not saved";
    statusStats.textContent = lines + " line" + (lines === 1 ? "" : "s") + " · " + text.length + " chars";
    statusState.textContent = dirty ? "unsaved changes" : "";
    saveBtn.disabled = !api;
  }

  async function load(path) {
    if (!api) return;
    try {
      var text = await api.fs.readText(path);
      currentPath = path;
      dirty = false;
      setValue(text);
      refresh();
    } catch (err) {
      statusState.textContent = "could not open " + path + ": " + err.message;
    }
  }

  function setValue(text) {
    if (editor && monaco) {
      editor.setValue(text);
      var model = editor.getModel();
      if (model) monaco.editor.setModelLanguage(model, languageFor(currentPath));
    }
  }

  async function save() {
    if (!api || !editor) return;
    var target = currentPath;
    if (!target) {
      var suggested = api.home + "/Documents/untitled.txt";
      var chosen = window.prompt("Save as (full path):", suggested);
      if (!chosen) return;
      target = chosen.trim();
    }
    try {
      await api.fs.writeText(target, editor.getValue());
      currentPath = target;
      dirty = false;
      refresh();
      if (api.notify) {
        api.notify({ title: "Saved", body: target, icon: "editor", timeout: 2500 });
      }
    } catch (err) {
      statusState.textContent = "save failed: " + err.message;
    }
  }

  async function openFile() {
    if (!api) return;
    var suggested = currentPath || api.home + "/Documents/";
    var chosen = window.prompt("Open file (full path):", suggested);
    if (!chosen) return;
    await load(chosen.trim());
  }

  /* ---- Monaco, from the OS's vendored copy ---- */

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = function () {
        reject(new Error("failed to load " + src));
      };
      document.head.appendChild(s);
    });
  }

  async function loadMonaco() {
    /* /9pf/monaco/app.js → the OS base is four levels up. Compute it from the
       page itself rather than guessing the deployment sub-path. */
    var base = new URL("../../", location.href).href; // …/<base>/9pf/ → …/<base>/
    var vs = new URL("monaco/vs", base).href;
    if (!window.require) {
      window.require = { paths: { vs: vs } };
      await loadScript(vs + "/loader.js");
    }
    await new Promise(function (resolve) {
      window.require(["vs/editor/editor.main"], resolve);
    });
    return window.monaco;
  }

  (async function boot() {
    if (!api) {
      fail(
        "No filesystem",
        "This window could not reach Dragon86's filesystem API (window.d86). Save, Open and Load are disabled."
      );
      return;
    }
    say("Loading Monaco from the OS…");
    try {
      monaco = await loadMonaco();
    } catch (err) {
      fail("Monaco could not load", err.message + " — the editor needs the OS's public/monaco folder.");
      return;
    }

    say("Opening…");
    editor = monaco.editor.create(document.getElementById("editor"), {
      value: "",
      language: languageFor(currentPath),
      theme: "vs-dark",
      automaticLayout: true,
      fontSize: 13,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      wordWrap: "on"
    });
    editor.onDidChangeModelContent(function () {
      dirty = true;
      refresh();
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, save);

    splash.style.display = "none";
    if (startFile) await load(startFile);
    else refresh();
    editor.focus();
  })();

  saveBtn.addEventListener("click", save);
  openBtn.addEventListener("click", openFile);
})();
