/**
 * CheerpJ — run .jar files in the browser.
 *
 * What is real here and what is not:
 *
 *   - The runtime is CheerpJ 4.3 from Leaning Technologies' public CDN
 *     (https://cjrtnc.leaningtech.com/4.3/loader.js). It is not vendored:
 *     it is tens of megabytes of their WebAssembly and they keep it hosted
 *     for exactly this use. The first Run therefore needs the network.
 *   - The jar comes from *your* filesystem. CheerpJ's /app/ mount is an
 *     HTTP mount, so the jar is handed over through the OS's own file route
 *     (`<base>9pf/@open/<path>`) — the same route the viewer uses. Nothing is
 *     copied, and the jar you pick is the jar that runs.
 *   - Programs that draw a GUI get a real display (cheerpjCreateDisplay).
 *     Console-only programs print into the page's log below the display.
 *
 * The OS opens this window with `?file=<path>` when you choose "Open with →
 * CheerpJ" on a .jar (see src/apps/iframe-app.ts).
 */

(function () {
  "use strict";

  var RUNTIME = "https://cjrtnc.leaningtech.com/4.3/loader.js";

  var api = null;
  try {
    api = window.parent && window.parent !== window ? window.parent.d86 : window.d86;
  } catch (err) {
    api = null;
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
    /* /9pf/cheerpj/index.html → the OS base is three levels up from here;
       the file route lives at <base>9pf/@open/<encoded path>. */
    var base = new URL("../../", location.href).href;
    return new URL("9pf/@open/" + encodeURIComponent(path), base).href;
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

  var save = api && api.fs ? api.fs : null;

  async function pickJar() {
    if (!save) {
      showScreen(
        "No filesystem",
        "This window could not reach Dragon86's filesystem API, so it cannot read a jar.",
        "",
        true
      );
      return;
    }
    var suggested = currentJar || (api.home + "/Downloads/");
    var chosen = window.prompt("Path to a .jar in your files:", suggested);
    if (!chosen) return;
    await runJar(chosen.trim());
  }

  runBtn.addEventListener("click", pickJar);

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
