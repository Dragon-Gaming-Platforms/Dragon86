/* Snake — a filesystem app. Everything it uses is next to it in
   ~/system/apps/snake/: this file, index.html, index.json. */

const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d");
const scoreEl = document.getElementById("score");
const msgEl = document.getElementById("msg");
const speedBtn = document.getElementById("speed");

const GRID = 20;
const CELL = canvas.width / GRID;
const SPEEDS = [
  { name: "slow", ms: 160 },
  { name: "normal", ms: 110 },
  { name: "fast", ms: 70 },
];

let speedIndex = 1;
let snake, dir, nextDir, food, score, best, dead, timer;
best = Number(localStorage.getItem("d86.snake.best") || 0);

function reset() {
  snake = [{ x: 8, y: 10 }, { x: 7, y: 10 }, { x: 6, y: 10 }];
  dir = { x: 1, y: 0 };
  nextDir = dir;
  score = 0;
  dead = false;
  placeFood();
  paint();
  updateScore();
  msgEl.hidden = true;
  if (timer) clearInterval(timer);
  timer = setInterval(step, SPEEDS[speedIndex].ms);
}

function placeFood() {
  do {
    food = { x: (Math.random() * GRID) | 0, y: (Math.random() * GRID) | 0 };
  } while (snake.some((s) => s.x === food.x && s.y === food.y));
}

function step() {
  if (dead) return;
  dir = nextDir;
  const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
  if (head.x < 0 || head.y < 0 || head.x >= GRID || head.y >= GRID) return die();
  if (snake.some((s) => s.x === head.x && s.y === head.y)) return die();
  snake.unshift(head);
  if (head.x === food.x && head.y === food.y) {
    score++;
    placeFood();
    updateScore();
    if (score % 5 === 0 && speedIndex < SPEEDS.length - 1) {
      speedIndex++;
      speedBtn.textContent = `Speed: ${SPEEDS[speedIndex].name}`;
      reset();
      return;
    }
  } else {
    snake.pop();
  }
  paint();
}

function die() {
  dead = true;
  clearInterval(timer);
  timer = null;
  best = Math.max(best, score);
  localStorage.setItem("d86.snake.best", String(best));
  updateScore();
  msgEl.hidden = false;
  msgEl.firstElementChild.textContent = `Game over — ${score} point${score === 1 ? "" : "s"}. Press an arrow key or Restart.`;
}

function paint() {
  ctx.fillStyle = "#111318";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#2a2f38";
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

function turn(x, y) {
  /* No 180° turns — that is a guaranteed self-collision. */
  if (x === -dir.x && y === -dir.y) return;
  nextDir = { x, y };
  if (dead) reset();
}

document.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (k === "arrowup" || k === "w") turn(0, -1);
  else if (k === "arrowdown" || k === "s") turn(0, 1);
  else if (k === "arrowleft" || k === "a") turn(-1, 0);
  else if (k === "arrowright" || k === "d") turn(1, 0);
  else return;
  e.preventDefault();
});

/* Swipe */
let sx = 0, sy = 0;
canvas.addEventListener("pointerdown", (e) => { sx = e.clientX; sy = e.clientY; });
canvas.addEventListener("pointerup", (e) => {
  const dx = e.clientX - sx;
  const dy = e.clientY - sy;
  if (Math.hypot(dx, dy) < 20) return;
  if (Math.abs(dx) > Math.abs(dy)) turn(dx > 0 ? 1 : -1, 0);
  else turn(0, dy > 0 ? 1 : -1);
});

document.getElementById("restart").addEventListener("click", reset);
speedBtn.addEventListener("click", () => {
  speedIndex = (speedIndex + 1) % SPEEDS.length;
  speedBtn.textContent = `Speed: ${SPEEDS[speedIndex].name}`;
  reset();
});

reset();
