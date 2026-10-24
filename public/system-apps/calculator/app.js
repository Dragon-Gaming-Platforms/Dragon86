/* Calculator — a filesystem app (see ~/system/apps/calculator/). */

const valueEl = document.getElementById("value");
const exprEl = document.getElementById("expr");

let current = "0";
let stored = null;
let pendingOp = null;
let justEvaluated = false;
const history = JSON.parse(localStorage.getItem("d86.calc.history") || "[]");

function show() {
  valueEl.textContent = current.length > 12 ? Number(current).toPrecision(10) : current;
  exprEl.textContent = stored !== null && pendingOp ? `${stored} ${sym(pendingOp)}` : "";
}

const sym = (op) => ({ "+": "+", "-": "−", "*": "×", "/": "÷" })[op] || op;

function digit(k) {
  if (justEvaluated) {
    current = "0";
    justEvaluated = false;
  }
  if (k === "." && current.includes(".")) return;
  if (current === "0" && k !== ".") current = k;
  else if (current.replace("-", "").replace(".", "").length < 12) current += k;
}

function compute(a, op, b) {
  const x = Number(a);
  const y = Number(b);
  switch (op) {
    case "+": return x + y;
    case "-": return x - y;
    case "*": return x * y;
    case "/": return y === 0 ? NaN : x / y;
  }
  return y;
}

function press(k) {
  if (/^[0-9]$/.test(k) || k === ".") {
    digit(k);
    return show();
  }
  if (k === "C") {
    current = "0";
    stored = null;
    pendingOp = null;
    justEvaluated = false;
    return show();
  }
  if (k === "+/-") {
    current = current.startsWith("-") ? current.slice(1) : `-${current}`;
    return show();
  }
  if (k === "%") {
    current = String(Number(current) / 100);
    return show();
  }
  if (k === "+" || k === "-" || k === "*" || k === "/") {
    if (pendingOp && !justEvaluated) {
      current = String(compute(stored, pendingOp, current));
      show();
    }
    stored = current;
    pendingOp = k;
    justEvaluated = false;
    current = "0";
    return show();
  }
  if (k === "=") {
    if (stored === null || !pendingOp) return;
    const result = compute(stored, pendingOp, current);
    const line = `${stored} ${sym(pendingOp)} ${current} = ${Number.isFinite(result) ? result : "undefined"}`;
    current = Number.isFinite(result) ? String(result) : "Error";
    stored = null;
    pendingOp = null;
    justEvaluated = true;
    history.unshift(line);
    history.length = Math.min(history.length, 20);
    localStorage.setItem("d86.calc.history", JSON.stringify(history));
    show();
    exprEl.textContent = line;
  }
}

document.querySelectorAll("button[data-k]").forEach((b) => {
  b.addEventListener("click", () => press(b.dataset.k));
});

document.addEventListener("keydown", (e) => {
  const map = { Enter: "=", Escape: "C", Backspace: "C", x: "*", X: "*" };
  const k = map[e.key] ?? e.key;
  if (/^[0-9.]$/.test(k) || "+-*/=C".includes(k)) {
    press(k);
    e.preventDefault();
  }
});

show();
