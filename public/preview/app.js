/*
 * Preview — the default app for pictures, sound, video, PDFs, 3D models and
 * disc images. It is a fixed page (public/preview/, deployed with the OS and
 * opened in a window as an iframe app), never a folder in your filesystem.
 * It is handed the file the OS wants opened as ?file=<absolute path> and
 * reads it through /9pf/@open, so anything in your home folder works.
 *
 * Why one app instead of six: "what opens this?" is a question the OS should
 * answer the same way for every file you can look at but not edit. Preview
 * decides by extension, and every kind degrades to the same honest panel
 * when the browser itself cannot decode the format (HEIF outside Safari, a
 * QuickTime .mov, a .gltf whose .bin is next door).
 */

const P = window.PreviewParsers;
/* Preview is a fixed page of its own (public/preview/, served from the OS
   base), not a filesystem app, so the OS base is one level up from here:
   /Dragon86/preview/index.html → /Dragon86/ — where 9pf/@open lives. */
const BASE = new URL("../", location.href).href;

const el = {
  title: document.getElementById("title"),
  meta: document.getElementById("meta"),
  tools: document.getElementById("tools"),
  main: document.getElementById("main"),
  status: document.getElementById("status"),
};

/* ---------- what is it? ---------- */

const KINDS = [
  ["image", "png jpg jpeg jfif gif webp avif bmp ico svg apng heic heif tif tiff"],
  ["audio", "mp3 wav ogg oga opus flac m4a aac weba aiff aif"],
  ["video", "mp4 m4v webm ogv mov mkv avi"],
  ["pdf", "pdf"],
  ["model", "glb gltf stl obj ply"],
  ["iso", "iso img"],
];

function kindOf(ext) {
  for (const [kind, list] of KINDS) if (list.split(" ").includes(ext)) return kind;
  return "unknown";
}

function baseName(path) {
  const at = path.lastIndexOf("/");
  return at === -1 ? path : path.slice(at + 1);
}

function extOf(path) {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

const TYPE_LABEL = {
  image: "Image",
  audio: "Audio",
  video: "Video",
  pdf: "PDF document",
  model: "3D model",
  iso: "Disc image",
  unknown: "File",
};

function human(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fileUrl(path) {
  return `${BASE}9pf/@open${encodeURIComponent(path)}`;
}

function setStatus(text, warn = false) {
  el.status.textContent = text;
  el.status.classList.toggle("warn", warn);
}

function button(label, onClick, title) {
  const b = document.createElement("button");
  b.textContent = label;
  if (title) b.title = title;
  b.addEventListener("click", onClick);
  el.tools.append(b);
  return b;
}

function toolsReset() {
  el.tools.textContent = "";
}

function panel(title, body, extra) {
  const wrap = document.createElement("div");
  wrap.className = "empty";
  const box = document.createElement("div");
  box.className = "box";
  const h = document.createElement("h2");
  h.textContent = title;
  const p = document.createElement("p");
  p.innerHTML = body;
  box.append(h, p);
  if (extra) box.append(extra);
  wrap.append(box);
  el.main.append(wrap);
  return wrap;
}

/* ---------- the page ---------- */

const requested = new URL(location.href).searchParams.get("file");
if (!requested) {
  el.title.textContent = "Preview";
  el.meta.textContent = "nothing open";
  panel(
    "Nothing to preview",
    "Open a file from <b>Files</b>, or set Preview as the default app for a type in Settings → Apps. " +
      "Double-clicking a picture, a song, a video, a PDF, a 3D model or an <code>.iso</code> lands here.",
  );
  setStatus("No file was passed to Preview.");
} else {
  open(requested);
}

async function open(path) {
  const ext = extOf(path);
  const kind = kindOf(ext);
  el.title.textContent = baseName(path);
  el.meta.textContent = `${TYPE_LABEL[kind]}${ext ? ` · .${ext}` : ""}`;
  setStatus(`Loading ${baseName(path)}…`);

  if (kind === "image") return showImage(path, ext);
  if (kind === "audio") return showAudio(path, ext);
  if (kind === "video") return showVideo(path, ext);
  if (kind === "pdf") return showPdf(path);
  if (kind === "model") return showModel(path, ext);
  if (kind === "iso") return showIso(path);
  return showUnknown(path, ext);
}

async function fetchBytes(path) {
  const res = await fetch(fileUrl(path));
  if (!res.ok) throw new Error(`HTTP ${res.status} reading ${baseName(path)}`);
  return new Uint8Array(await res.arrayBuffer());
}

function noteSize(bytes) {
  el.meta.textContent = `${el.meta.textContent} · ${human(bytes.length)}`;
}

/* ---------- images ---------- */

async function showImage(path, ext) {
  toolsReset();
  const stage = document.createElement("div");
  stage.id = "stage";
  const img = document.createElement("img");
  img.alt = baseName(path);
  img.src = fileUrl(path);
  stage.append(img);
  el.main.append(stage);

  let zoom = 1;
  let rotate = 0;
  const apply = () => {
    img.style.transform = `scale(${zoom}) rotate(${rotate}deg)`;
  };
  button("−", () => { zoom = Math.max(0.1, zoom / 1.25); apply(); }, "Zoom out");
  button("+", () => { zoom = Math.min(16, zoom * 1.25); apply(); }, "Zoom in");
  button("Fit", () => { zoom = 1; rotate = 0; apply(); }, "Fit to window");
  button("Rotate", () => { rotate = (rotate + 90) % 360; apply(); }, "Rotate 90°");
  button("Actual size", () => {
    zoom = Math.min(16, img.naturalWidth / Math.max(1, stage.clientWidth - 28));
    apply();
  }, "1 image pixel = 1 screen pixel");

  img.addEventListener("load", () => {
    el.meta.textContent = `${TYPE_LABEL.image} · ${img.naturalWidth}×${img.naturalHeight}`;
    setStatus(`${baseName(path)} — ${img.naturalWidth}×${img.naturalHeight} px. Drag the corner of the window to resize; + and − zoom.`);
  });
  img.addEventListener("error", () => {
    stage.remove();
    const heif = /hei[cf]/.test(ext);
    panel(
      "This browser cannot draw that image",
      heif
        ? "HEIF/HEIC is an Apple container: Safari and iOS decode it, Chrome and Firefox do not. " +
          "The file itself is fine — convert it to JPEG or PNG to preview it here."
        : `The browser refused to decode this <code>.${ext}</code> file. It may be corrupt, or a ` +
          "format this browser does not support (TIFF, for example, only works in Safari).",
    );
    setStatus(`Could not decode ${baseName(path)}.`, true);
  });
}

/* ---------- audio ---------- */

async function showAudio(path, ext) {
  toolsReset();
  const wrap = document.createElement("div");
  wrap.className = "media";
  const art = document.createElement("div");
  art.className = "art";
  art.textContent = "♪";
  const audio = document.createElement("audio");
  audio.controls = true;
  audio.preload = "metadata";
  audio.src = fileUrl(path);
  const wave = document.createElement("canvas");
  wave.className = "wave";
  wrap.append(art, wave, audio);
  el.main.append(wrap);

  audio.addEventListener("loadedmetadata", () => {
    const secs = Number.isFinite(audio.duration) ? `${audio.duration.toFixed(1)}s` : "unknown length";
    el.meta.textContent = `${TYPE_LABEL.audio} · .${ext} · ${secs}`;
    setStatus(`${baseName(path)} — ${secs}. Press play; the waveform is decoded from the file itself.`);
  });
  audio.addEventListener("error", () => {
    panel(
      "This browser cannot play that audio",
      `The <code>.${ext}</code> codec is not available here. WAV, MP3, OGG/Opus and FLAC work in most browsers; ` +
        "AIFF and some AAC files do not.",
    );
    wrap.remove();
    setStatus(`Could not play ${baseName(path)}.`, true);
  });

  /* Waveform: decode the bytes we already have and draw the peak envelope.
     Costs one pass over the file and makes "is this the track I meant?" a
     glance instead of a guess. */
  try {
    const bytes = await fetchBytes(path);
    noteSize(bytes);
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const buffer = await ctx.decodeAudioData(bytes.buffer.slice(0));
    drawWave(wave, buffer);
    ctx.close();
  } catch {
    /* Decoding is a bonus; the <audio> element above is the real player. */
    wave.remove();
  }
}

function drawWave(canvas, buffer) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.max(240, canvas.clientWidth || 480);
  const height = 90;
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  canvas.style.height = `${height}px`;
  const g = canvas.getContext("2d");
  g.scale(dpr, dpr);
  const channel = buffer.getChannelData(0);
  const step = Math.max(1, Math.floor(channel.length / width));
  g.fillStyle = "#161a21";
  g.fillRect(0, 0, width, height);
  g.fillStyle = "#ff4d5a";
  for (let x = 0; x < width; x++) {
    let min = 1;
    let max = -1;
    const at = x * step;
    for (let i = 0; i < step; i++) {
      const v = channel[at + i] || 0;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const top = (1 - max) * (height / 2);
    const bottom = (1 - min) * (height / 2);
    g.fillRect(x, top, 1, Math.max(1, bottom - top));
  }
}

/* ---------- video ---------- */

function showVideo(path, ext) {
  toolsReset();
  const wrap = document.createElement("div");
  wrap.className = "media";
  const video = document.createElement("video");
  video.controls = true;
  video.playsInline = true;
  video.preload = "metadata";
  video.src = fileUrl(path);
  wrap.append(video);
  el.main.append(wrap);

  video.addEventListener("loadedmetadata", () => {
    const w = video.videoWidth;
    const h = video.videoHeight;
    const secs = Number.isFinite(video.duration) ? `${video.duration.toFixed(1)}s` : "unknown length";
    el.meta.textContent = `${TYPE_LABEL.video} · .${ext} · ${w}×${h} · ${secs}`;
    setStatus(`${baseName(path)} — ${w}×${h}, ${secs}.`);
  });
  video.addEventListener("error", () => {
    wrap.remove();
    panel(
      "This browser cannot play that video",
      `A <code>.${ext}</code> file is a container, and the codec inside is what matters. MP4/H.264, ` +
        "WebM/VP9 and OGG/Theora play almost everywhere; QuickTime (.mov) with ProRes, and Matroska " +
        "with exotic codecs, usually do not. The file is fine — the browser is the limit.",
    );
    setStatus(`Could not play ${baseName(path)}.`, true);
  });
}

/* ---------- PDF ---------- */

async function showPdf(path) {
  toolsReset();
  const stage = document.createElement("div");
  stage.id = "stage";
  stage.className = "pdf";
  const frame = document.createElement("iframe");
  frame.title = baseName(path);
  frame.src = fileUrl(path);
  stage.append(frame);
  el.main.append(stage);

  const url = fileUrl(path);
  button("Open in tab", () => window.open(url, "_blank", "noopener"), "Open the PDF outside Preview");
  button("Copy URL", async () => {
    try {
      await navigator.clipboard.writeText(url);
      setStatus("PDF URL copied to the clipboard.");
    } catch {
      setStatus("The browser refused clipboard access.", true);
    }
  });
  setStatus(`${baseName(path)} — rendered by the browser's own PDF viewer. If the pane stays blank, use Open in tab.`);
  try {
    noteSize(await fetchBytes(path));
  } catch (err) {
    setStatus(`Could not read ${baseName(path)}: ${err.message}`, true);
  }
}

/* ---------- unknown ---------- */

function showUnknown(path, ext) {
  toolsReset();
  const box = document.createElement("div");
  box.className = "empty";
  box.innerHTML = `
    <div class="box">
      <h2>Preview does not handle <code>${ext ? `.${ext}` : "this"}</code> yet</h2>
      <p>It shows pictures, sound, video, PDFs, 3D models (<code>.glb</code>, <code>.gltf</code>,
         <code>.stl</code>, <code>.obj</code>, <code>.ply</code>) and ISO disc images.
         Text files open in the Text Editor instead.</p>
    </div>`;
  el.main.append(box);
  setStatus(`${baseName(path)} — no preview for this type.`, true);
}

/* ---------- 3D ---------- */

async function showModel(path, ext) {
  toolsReset();
  const stage = document.createElement("div");
  stage.id = "stage";
  stage.style.padding = "0";
  stage.style.background = "#0a0c10";
  const canvas = document.createElement("canvas");
  canvas.id = "gl";
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  stage.append(canvas, overlay);
  el.main.append(stage);

  setStatus(`Parsing ${baseName(path)}…`);
  let model;
  try {
    const bytes = await fetchBytes(path);
    noteSize(bytes);
    if (ext === "stl") model = P.parseSTL(bytes);
    else if (ext === "obj") model = P.parseOBJ(new TextDecoder("utf-8").decode(bytes));
    else if (ext === "ply") model = P.parsePLY(bytes);
    else if (ext === "glb") model = P.parseGLB(bytes);
    else model = P.parseGLTFText(new TextDecoder("utf-8").decode(bytes));
  } catch (err) {
    stage.remove();
    panel(`Could not read that ${ext.toUpperCase()}`, escapeHtml(err.message), null);
    setStatus(`${baseName(path)}: ${err.message}`, true);
    return;
  }

  if (!model.positions.length) {
    stage.remove();
    panel(
      "That model could not be drawn",
      escapeHtml(model.warning || "The file parsed, but it contains no triangles."),
    );
    setStatus(`${baseName(path)}: ${model.warning || "no triangles"}`, true);
    return;
  }

  const viewer = createViewer(canvas, model.positions);
  button("Reset view", () => viewer.reset(), "Frame the whole model again");
  const spin = button("Spin", () => {
    viewer.spin = !viewer.spin;
    spin.setAttribute("aria-pressed", String(viewer.spin));
  }, "Rotate slowly, for a look at every side");
  spin.setAttribute("aria-pressed", "false");

  const b = model.bounds;
  const size = b ? [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]].map((v) => v.toFixed(2)) : [];
  overlay.textContent =
    `${model.triangles.toLocaleString()} triangles · ${size.join(" × ")} units` +
    (model.meshes > 1 ? ` · ${model.meshes} meshes` : "") +
    (model.warning ? ` · ${model.warning}` : "") +
    " · drag to orbit, wheel or pinch to zoom";
  el.meta.textContent = `${TYPE_LABEL.model} · .${ext} · ${model.triangles.toLocaleString()} triangles`;
  setStatus(`${baseName(path)} — ${model.triangles.toLocaleString()} triangles loaded.`);
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/**
 * A small orbit viewer: flat-shaded triangles, one directional light, no
 * texture or material support. Deliberately blunt — it answers "what shape is
 * this?" for models the browser has no native way to show.
 */
function createViewer(canvas, positions) {
  const gl = canvas.getContext("webgl", { antialias: true, alpha: false }) ||
    canvas.getContext("experimental-webgl", { antialias: true, alpha: false });
  if (!gl) {
    el.main.innerHTML = "";
    panel("This browser has no WebGL", "The model parsed — but drawing it needs WebGL, which is switched off or unavailable here.");
    return { reset() {}, spin: false };
  }

  /* Flat normals: one per triangle, so the model reads clearly without a
     vertex-welding pass. */
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 9) {
    const ax = positions[i], ay = positions[i + 1], az = positions[i + 2];
    const bx = positions[i + 3], by = positions[i + 4], bz = positions[i + 5];
    const cx = positions[i + 6], cy = positions[i + 7], cz = positions[i + 8];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    for (let v = 0; v < 3; v++) {
      normals[i + v * 3] = nx;
      normals[i + v * 3 + 1] = ny;
      normals[i + v * 3 + 2] = nz;
    }
  }

  const bounds = P.bounds(positions);
  const center = [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
  const radius = Math.max(
    1e-6,
    Math.hypot(
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2],
    ) / 2,
  );

  const vs = `
    attribute vec3 aPos;
    attribute vec3 aNormal;
    uniform mat4 uProj, uView;
    uniform vec3 uCenter;
    varying vec3 vNormal;
    void main() {
      vNormal = aNormal;
      gl_Position = uProj * uView * vec4(aPos - uCenter, 1.0);
    }`;
  const fs = `
    precision mediump float;
    varying vec3 vNormal;
    uniform vec3 uLight;
    void main() {
      float d = max(dot(normalize(vNormal), normalize(uLight)), 0.0);
      vec3 base = vec3(0.72, 0.76, 0.82);
      vec3 col = base * (0.28 + 0.78 * d) + vec3(0.10, 0.06, 0.08) * pow(1.0 - d, 3.0);
      gl_FragColor = vec4(col, 1.0);
    }`;

  function compile(type, source) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, source);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || "shader");
    return sh;
  }
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(program);
  gl.useProgram(program);

  const posBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
  gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(program, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);

  const nrmBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, nrmBuf);
  gl.bufferData(gl.ARRAY_BUFFER, normals, gl.STATIC_DRAW);
  const aNormal = gl.getAttribLocation(program, "aNormal");
  gl.enableVertexAttribArray(aNormal);
  gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 0, 0);

  const uProj = gl.getUniformLocation(program, "uProj");
  const uView = gl.getUniformLocation(program, "uView");
  const uCenter = gl.getUniformLocation(program, "uCenter");
  const uLight = gl.getUniformLocation(program, "uLight");
  gl.uniform3f(uCenter, center[0], center[1], center[2]);
  gl.uniform3f(uLight, 0.4, 0.8, 0.6);
  gl.enable(gl.DEPTH_TEST);
  gl.clearColor(0.04, 0.05, 0.07, 1);

  let yaw = 0.7;
  let pitch = 0.45;
  let distance = radius * 3.2;
  let spinning = false;

  function perspective(fov, aspect, near, far) {
    const f = 1 / Math.tan(fov / 2);
    return new Float32Array([
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) / (near - far), -1,
      0, 0, (2 * far * near) / (near - far), 0,
    ]);
  }

  function view() {
    const cy = Math.cos(pitch);
    const eye = [
      distance * cy * Math.sin(yaw),
      distance * Math.sin(pitch),
      distance * cy * Math.cos(yaw),
    ];
    /* lookAt(eye, origin, +Y) */
    const zx = eye[0], zy = eye[1], zz = eye[2];
    const zl = Math.hypot(zx, zy, zz) || 1;
    const z = [zx / zl, zy / zl, zz / zl];
    let up = [0, 1, 0];
    if (Math.abs(z[1]) > 0.999) up = [0, 0, 1];
    const x = [up[1] * z[2] - up[2] * z[1], up[2] * z[0] - up[0] * z[2], up[0] * z[1] - up[1] * z[0]];
    const xl = Math.hypot(x[0], x[1], x[2]) || 1;
    x[0] /= xl; x[1] /= xl; x[2] /= xl;
    const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
    return new Float32Array([
      x[0], y[0], z[0], 0,
      x[1], y[1], z[1], 0,
      x[2], y[2], z[2], 0,
      -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]),
      -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]),
      -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]),
      1,
    ]);
  }

  function reset() {
    yaw = 0.7;
    pitch = 0.45;
    distance = radius * 3.2;
    draw();
  }

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth || 480;
    const h = canvas.clientHeight || 360;
    if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  function draw() {
    resize();
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.uniformMatrix4fv(uProj, false, perspective(0.85, canvas.width / Math.max(1, canvas.height), radius * 0.02, radius * 400));
    gl.uniformMatrix4fv(uView, false, view());
    gl.drawArrays(gl.TRIANGLES, 0, positions.length / 3);
  }

  /* Only runs while Spin is on: no idle animation frame for a still model. */
  function loop() {
    if (!canvas.isConnected || !spinning) return;
    yaw += 0.006;
    draw();
    requestAnimationFrame(loop);
  }

  /* ---- input: drag to orbit, wheel to zoom, pinch on touch ---- */
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  canvas.addEventListener("pointerdown", (e) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.classList.add("dragging");
    canvas.setPointerCapture?.(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    yaw -= dx * 0.01;
    pitch = Math.max(-1.5, Math.min(1.5, pitch + dy * 0.01));
    draw();
  });
  const endDrag = () => {
    dragging = false;
    canvas.classList.remove("dragging");
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      distance *= Math.exp(e.deltaY * 0.0012);
      distance = Math.max(radius * 1.05, Math.min(radius * 60, distance));
      draw();
    },
    { passive: false },
  );

  if (typeof ResizeObserver === "function") new ResizeObserver(() => draw()).observe(canvas);
  requestAnimationFrame(draw);

  return {
    reset,
    get spin() {
      return spinning;
    },
    set spin(value) {
      spinning = !!value;
      if (spinning) requestAnimationFrame(loop);
    },
  };
}

/* ---------- ISO ---------- */

async function showIso(path) {
  toolsReset();
  setStatus(`Reading the volume descriptor of ${baseName(path)}…`);
  let iso;
  try {
    const bytes = await fetchBytes(path);
    noteSize(bytes);
    iso = P.parseISO(bytes);
  } catch (err) {
    panel("Could not read that disc image", escapeHtml(err.message));
    setStatus(`${baseName(path)}: ${err.message}`, true);
    return;
  }

  const listing = document.createElement("div");
  listing.className = "listing";
  const head = document.createElement("div");
  head.className = "head";
  const files = iso.entries.filter((e) => !e.isDir);
  const folders = iso.entries.filter((e) => e.isDir);
  head.textContent =
    `${iso.label || "disc image"} · ${folders.length} folder${folders.length === 1 ? "" : "s"} · ` +
    `${files.length} file${files.length === 1 ? "" : "s"}${iso.truncated ? " (listing truncated)" : ""}`;
  listing.append(head);
  if (!iso.entries.length) {
    const row = document.createElement("div");
    row.className = "row";
    row.textContent = "The volume is empty.";
    listing.append(row);
  }
  for (const entry of iso.entries) {
    const row = document.createElement("div");
    row.className = `row${entry.isDir ? " dir" : ""}`;
    const depth = document.createElement("span");
    depth.className = "depth";
    depth.textContent = "· ".repeat(entry.depth);
    const name = document.createElement("span");
    name.textContent = `${entry.name}${entry.isDir ? "/" : ""}`;
    row.append(depth, name);
    if (!entry.isDir) {
      const size = document.createElement("span");
      size.className = "size";
      size.textContent = human(entry.size);
      row.append(size);
    }
    listing.append(row);
  }
  el.main.append(listing);
  el.meta.textContent = `${TYPE_LABEL.iso} · ${iso.label || "no label"}`;
  setStatus(
    `${baseName(path)} — ISO9660 listing, first three levels. A preview shows what is inside; copy files out of the image with the ISO tools in the Terminal to use them.`,
  );
}
