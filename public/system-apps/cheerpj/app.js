/**
 * CheerpJ — run .jar files in the browser.
 *
 * What is real here and what is not:
 *
 *   - The runtime is CheerpJ 4.3 from Leaning Technologies' public CDN
 *     (https://cjrtnc.leaningtech.com/4.3/loader.js). It is not vendored:
 *     it is tens of megabytes of their WebAssembly and they keep it hosted
 *     for exactly this use. The first Run therefore needs the network.
 *   - The jar is chosen from Dragon86 Files through the public `d86.files`
 *     API. The API grants that exact ZenFS path to CheerpJ and returns its
 *     `/9pf/@open/` URL, which is mounted by CheerpJ as `/app/` without
 *     copying the jar into a separate browser-only store.
 *   - Programs that draw a GUI get a real display (cheerpjCreateDisplay).
 *     Console-only programs print into the page's log below the display.
 *
 * The OS may open this window with `?file=<path>` from Files → Open with,
 * or the app can use `d86.files.open()` to choose a jar directly from ZenFS.
 */

(function () {
  "use strict";

  var RUNTIME = "https://cjrtnc.leaningtech.com/4.3/loader.js";

  var api = window.d86 || window.Dragon86 || null;
  if (!api) {
    try { api = window.parent && window.parent !== window ? window.parent.d86 : null; }
    catch (err) { api = null; }
  }

  var params = new URLSearchParams(location.search);
  var currentJar = params.get("file") || null;

  var screen = document.getElementById("screen");
  var screenTitle = document.getElementById("screen-title");
  var screenText = document.getElementById("screen-text");
  var screenHint = document.getElementById("screen-hint");
  var jarLabel = document.getElementById("jar");
  var status = document.getElementById("status");
  var statusJar = document.getElementById("status-jar");
  var runBtn = document.getElementById("run");
  var display = document.getElementById("display");
  var log = null;

  var inited = false;
  var busy = false;

  function setStatus(text) {
    status.textContent = text;
  }

  function showScreen(title, text, hint, isError) {
    screen.classList.remove("hidden");
    screen.classList.toggle("error", Boolean(isError));
    screenTitle.textContent = title;
    screenText.textContent = text;
    screenHint.innerHTML = hint || "";
  }

  function hideScreen() {
    screen.classList.add("hidden");
  }

  function ensureLog() {
    if (log) return log;
    log = document.createElement("pre");
    log.id = "console";
    log.style.cssText =
      "position:absolute;left:0;right:0;bottom:0;max-height:38%;overflow:auto;margin:0;" +
      "padding:8px 10px;background:rgba(0,0,0,.86);border-top:1px solid #1f1f1f;" +
      "color:#cfcfcf;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;" +
      "z-index:3;display:none";
    document.querySelector("main").appendChild(log);
    return log;
  }

  /**
   * System.out/System.err do not reach the page on their own, so a console
   * program would look like it did nothing. CheerpJ offers a listener hook;
   * use it when it is there, and fall back to the display otherwise.
   */
  function appendLog(text) {
    var box = ensureLog();
    box.style.display = "block";
    box.textContent += text;
    box.scrollTop = box.scrollHeight;
  }

  function jarUrl(path) {
    if (!api || !api.files || typeof api.files.url !== "function") {
      throw new Error("Dragon86's file API is unavailable in this app window");
    }
    return api.files.url(path);
  }

  function loadRuntime() {
    if (window.cheerpjInit) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var script = document.createElement("script");
      script.src = RUNTIME;
      script.onload = function () {
        if (window.cheerpjInit) resolve();
        else reject(new Error("the loader ran but cheerpjInit is missing"));
      };
      script.onerror = function () {
        reject(new Error("could not download " + RUNTIME));
      };
      document.head.appendChild(script);
    });
  }

  async function runJar(path) {
    if (busy) return;
    busy = true;
    runBtn.disabled = true;
    currentJar = path;
    jarLabel.textContent = path;
    statusJar.textContent = path;
    hideScreen();
    setStatus("starting CheerpJ…");

    try {
      await loadRuntime();
      if (!inited) {
        setStatus("initialising the Java runtime (first start is the slow one)…");
        await window.cheerpjInit({
          status: "default",
          clipboardMode: "java",
          /* A console program has nowhere to print unless we listen. */
          listener: function (line) {
            appendLog(line + "\n");
          }
        });
        inited = true;
        /* Draw Java GUI windows inside this window, not over the whole OS. */
        window.cheerpjCreateDisplay(-1, -1, display);
      }
      setStatus("running " + path.split("/").pop() + " …");
      var url = jarUrl(path);
      var code = await window.cheerpjRunJar(url);
      setStatus("finished with exit code " + code);
      if (code !== 0) appendLog("\n[process exited with code " + code + "]\n");
    } catch (err) {
      setStatus("failed");
      showScreen(
        "CheerpJ could not run that jar",
        String(err && err.message ? err.message : err),
        "If this is the first run, check your connection: the Java runtime itself " +
          "comes from Leaning Technologies' CDN (<code>cjrtnc.leaningtech.com</code>). " +
          "A jar that needs native libraries cannot run in a browser at all.",
        true
      );
    } finally {
      busy = false;
      runBtn.disabled = false;
    }
  }

  async function pickJar() {
    if (!api || !api.files || typeof api.files.open !== "function") {
      showScreen(
        "No Dragon86 file API",
        "This app could not reach Dragon86's ZenFS picker, so it cannot choose a jar.",
        "Open this app from Dragon86 Files or update the installed app.",
        true
      );
      return;
    }
    try {
      var chosen = await api.files.open({ accept: ".jar", multiple: false });
      if (!chosen.length) return;
      await runJar(chosen[0].path);
    } catch (err) {
      showScreen("Could not open a jar", String(err && err.message ? err.message : err), "Try again from Dragon86 Files.", true);
    }
  }

  runBtn.addEventListener("click", pickJar);
  document.getElementById("fullscreen").addEventListener("click", function () {
    if (api && api.window && typeof api.window.requestFullscreen === "function") {
      void api.window.requestFullscreen();
    }
  });

  /* Opened with a jar already chosen (Files → Open with → CheerpJ). */
  if (currentJar) {
    runBtn.textContent = "Run again";
    void runJar(currentJar);
  } else {
    showScreen(
      "CheerpJ — Java in the browser",
      "Pick a .jar from your files and it runs here, unmodified. GUI programs get a display; " +
        "console programs print below it.",
      "Java 8/11/17 · the runtime is downloaded from Leaning Technologies on first use.",
      false
    );
  }
})();
