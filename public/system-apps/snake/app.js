/*
 * Snake — a filesystem app. Everything it uses sits next to it in
 * ~/system/apps/snake/: this file, index.html, index.json.
 *
 * The game waits for you. It used to start on load, which meant the snake
 * crawled into the right-hand wall in about a second and a half while you
 * were still reading the window — the game looked broken. Now it starts on
 * the first input (tap, key, swipe), pauses when this frame loses focus, and
 * never moves on its own while you are doing something else.
 *
 * Keyboard focus: a keydown only reaches this document once the frame has
 * focus, so the overlay takes the first click and calls window.focus().
 */

const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d");
const scoreEl = document.getElementById("score");
const overlay = document.getElementById("overlay");
const ovTitle = document.getElementById("ov-title");
const ovText = document.getElementById("ov-text");
const ovAction = document.getElementById("ov-action");
const pauseBtn = document.getElementById("pause");
const speedBtn = document.getElementById("speed");

const GRID = 20;
const CELL = canvas.width / GRID;
const SPEEDS = [
  { name: "slow", ms: 160 },
  { name: "normal", ms: 110 },
  { name: "fast", ms: 75 },
];

/** "ready" → "running" ⇄ "paused", or "over". */
let state = "ready";
let speedIndex = 1;
let snake = [];
let dir = { x: 1, y: 0 };
let nextDir = { x: 1, y: 0 };
/** One queued turn: two taps inside one tick must not eat each other. */
let queued = null;
let food = { x: 14, y: 10 };
let score = 0;
/* localStorage throws outright in an opaque-origin frame (and in some private
   modes), so the best score is read and written defensively: a game that
   cannot remember your record should still be playable. */
function readBest() {
  try {
    return Number(localStorage.getItem("d86.snake.best") || 0) || 0;
  } catch {
    return 0;
  }
}

let best = readBest();
let timer = null;

/* ---------- the board ---------- */

function reset(keepRunning) {
  stopTimer();
  snake = [
    { x: 8, y: 10 },
    { x: 7, y: 10 },
    { x: 6, y: 10 },
  ];
  /* If the player pressed a key to restart, start off going that way. */
  dir = nextDir && !(nextDir.x === 1 && nextDir.y === 0) && !(nextDir.x === -1 && nextDir.y === 0)
    ? { x: nextDir.x, y: nextDir.y }
    : { x: 1, y: 0 };
  nextDir = dir;
  queued = null;
  score = 0;
  state = keepRunning ? "running" : "ready";
  placeFood();
  paint();
  updateScore();
  syncChrome();
  if (keepRunning) startTimer();
}

function startTimer() {
  stopTimer();
  timer = setInterval(step, SPEEDS[speedIndex].ms);
}

function stopTimer() {
  if (timer) clearInterval(timer);
  timer = null;
}

function placeFood() {
  let tries = 0;
  do {
    food = { x: (Math.random() * GRID) | 0, y: (Math.random() * GRID) | 0 };
    tries++;
  } while (tries < 500 && snake.some((s) => s.x === food.x && s.y === food.y));
}

function step() {
  if (state !== "running") return;
  if (queued) {
    dir = queued;
    queued = null;
  }
  const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };

  const wall = head.x < 0 || head.y < 0 || head.x >= GRID || head.y >= GRID;
  /* The tail moves out of the way on the same tick, so running into where
     the tail *was* is legal — but not into where it still is. */
  const body = snake.slice(0, head.x === food.x && head.y === food.y ? snake.length : -1);
  if (wall || body.some((s) => s.x === head.x && s.y === head.y)) return die();

  snake.unshift(head);
  if (head.x === food.x && head.y === food.y) {
    score++;
    placeFood();
    updateScore();
    if (score % 5 === 0 && speedIndex < SPEEDS.length - 1) {
      speedIndex++;
      speedBtn.textContent = `Speed: ${SPEEDS[speedIndex].name}`;
      startTimer();
    }
  } else {
    snake.pop();
  }
  paint();
}

function die() {
  state = "over";
  stopTimer();
  best = Math.max(best, score);
  try {
    localStorage.setItem("d86.snake.best", String(best));
  } catch {
    /* private mode — the best score just will not persist */
  }
  updateScore();
  syncChrome();
  paint();
}

function paint() {
  ctx.fillStyle = "#111318";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = "#1c2027";
  for (let i = 1; i < GRID; i++) {
    ctx.fillRect(i * CELL, 0, 1, canvas.height);
    ctx.fillRect(0, i * CELL, canvas.width, 1);
  }

  ctx.fillStyle = "#e6003c";
  ctx.beginPath();
  ctx.arc(food.x * CELL + CELL / 2, food.y * CELL + CELL / 2, CELL * 0.32, 0, Math.PI * 2);
  ctx.fill();

  snake.forEach((part, i) => {
    ctx.fillStyle = i === 0 ? "#ff6b74" : `rgba(255,77,90,${Math.max(0.35, 1 - i * 0.03)})`;
    ctx.fillRect(part.x * CELL + 1, part.y * CELL + 1, CELL - 2, CELL - 2);
  });
}

function updateScore() {
  scoreEl.textContent = `Score ${score} · Best ${best}`;
}

/* ---------- the overlay, which is also the focus target ---------- */

function syncChrome() {
  pauseBtn.textContent = state === "running" ? "Pause" : state === "paused" ? "Resume" : "Start";
  const show = state !== "running";
  overlay.hidden = !show;
  if (!show) return;
  if (state === "over") {
    ovTitle.textContent = `Game over — ${score} point${score === 1 ? "" : "s"}`;
    ovText.textContent = best > score ? `Best so far: ${best}.` : "That is a new best score.";
    ovAction.textContent = "Tap to play again";
  } else if (state === "paused") {
    ovTitle.textContent = "Paused";
    ovText.textContent = "Nothing moves while this window is out of focus.";
    ovAction.textContent = "Tap to resume";
  } else {
    ovTitle.textContent = "Snake";
    ovText.textContent = "Arrows, WASD or a swipe to steer. Eat the red dots.";
    ovAction.textContent = "Tap to start";
  }
}

function begin() {
  window.focus();
  if (state === "ready" || state === "over") {
    reset(true);
    return;
  }
  if (state === "paused") {
    state = "running";
    syncChrome();
    startTimer();
  }
}

function pause() {
  if (state !== "running") return;
  state = "paused";
  stopTimer();
  syncChrome();
}

/* ---------- input ---------- */

function turn(x, y) {
  /* Reversing into yourself is instant death; swing round instead. */
  const from = queued ?? dir;
  if (x === -from.x && y === -from.y) return;
  if (x === from.x && y === from.y) {
    /* Pressing the direction you are already going is a start, not a turn. */
    if (state !== "running") begin();
    return;
  }
  if (state === "running") queued = { x, y };
  else nextDir = { x, y };
  begin();
}

document.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  let moved = true;
  if (k === "arrowup" || k === "w") turn(0, -1);
  else if (k === "arrowdown" || k === "s") turn(0, 1);
  else if (k === "arrowleft" || k === "a") turn(-1, 0);
  else if (k === "arrowright" || k === "d") turn(1, 0);
  else if (k === " " || k === "p") {
    state === "running" ? pause() : begin();
  } else if (k === "r") {
    reset(true);
  } else moved = false;
  if (moved) e.preventDefault();
});

/* Swipe / tap on the board. A tap starts or resumes; a swipe also steers. */
let sx = 0;
let sy = 0;
let swiped = false;
canvas.addEventListener("pointerdown", (e) => {
  sx = e.clientX;
  sy = e.clientY;
  swiped = false;
});
canvas.addEventListener("pointerup", (e) => {
  const dx = e.clientX - sx;
  const dy = e.clientY - sy;
  if (Math.hypot(dx, dy) >= 18) {
    swiped = true;
    if (Math.abs(dx) > Math.abs(dy)) turn(dx > 0 ? 1 : -1, 0);
    else turn(0, dy > 0 ? 1 : -1);
  }
  if (!swiped) begin();
});

overlay.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  begin();
});

/* Losing focus must not cost you the game: the snake stops, the overlay
   explains why, and clicking back in resumes exactly where it was. */
window.addEventListener("blur", pause);
document.addEventListener("pointerdown", () => window.focus(), { passive: true });

pauseBtn.addEventListener("click", () => {
  if (state === "running") pause();
  else begin();
});
document.getElementById("restart").addEventListener("click", () => reset(true));
speedBtn.addEventListener("click", () => {
  speedIndex = (speedIndex + 1) % SPEEDS.length;
  speedBtn.textContent = `Speed: ${SPEEDS[speedIndex].name}`;
  reset(state === "running");
});

/* ---------- go ---------- */

reset(false);
window.focus();
try {
  document.body.focus();
} catch {
  /* older frames */
}
