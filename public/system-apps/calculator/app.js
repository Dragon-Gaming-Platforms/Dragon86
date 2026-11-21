/* Calculator — a filesystem app (see ~/system/apps/calculator/). */

const valueEl = document.getElementById("value");
const exprEl = document.getElementById("expr");
let current = "0";
let stored = null;
let pendingOp = null;
let justEvaluated = false;
let angleMode = "DEG";
const history = JSON.parse(localStorage.getItem("d86.calc.history") || "[]");

function show() {
  const n = Number(current);
  valueEl.textContent = current.length > 12 && Number.isFinite(n) ? n.toPrecision(10) : current;
  exprEl.textContent = stored !== null && pendingOp ? `${stored} ${sym(pendingOp)}` : "";
}
const sym = (op) => ({ "+": "+", "-": "−", "*": "×", "/": "÷" })[op] || op;
function digit(k) {
  if (justEvaluated || current === "Error") { current = "0"; justEvaluated = false; }
  if (k === "." && current.includes(".")) return;
  if (current === "0" && k !== ".") current = k;
  else if (current.replace("-", "").replace(".", "").length < 12) current += k;
}
function compute(a, op, b) {
  const x = Number(a), y = Number(b);
  switch (op) {
    case "+": return x + y;
    case "-": return x - y;
    case "*": return x * y;
    case "/": return y === 0 ? NaN : x / y;
  }
  return y;
}
function record(line) {
  history.unshift(line);
  history.length = Math.min(history.length, 20);
  localStorage.setItem("d86.calc.history", JSON.stringify(history));
}
function applyFunction(label, transform) {
  const input = Number(current);
  const result = transform(input);
  const shown = Number.isFinite(result) ? String(Number(result.toPrecision(12))) : "Error";
  record(`${label}(${current}) = ${shown}`);
  current = shown;
  stored = null;
  pendingOp = null;
  justEvaluated = true;
  show();
  exprEl.textContent = `${label}(${input})`;
}
function press(k) {
  if (/^[0-9]$/.test(k) || k === ".") { digit(k); return show(); }
  if (k === "C") { current = "0"; stored = null; pendingOp = null; justEvaluated = false; return show(); }
  if (k === "+/-") { if (current !== "Error") current = current.startsWith("-") ? current.slice(1) : `-${current}`; return show(); }
  if (k === "%") { current = String(Number(current) / 100); return show(); }
  if (["+", "-", "*", "/"].includes(k)) {
    if (pendingOp && !justEvaluated) current = String(compute(stored, pendingOp, current));
    stored = current; pendingOp = k; justEvaluated = false; current = "0"; return show();
  }
  if (k === "=") {
    if (stored === null || !pendingOp) return;
    const left = stored, operator = pendingOp, right = current;
    const result = compute(left, operator, right);
    const shown = Number.isFinite(result) ? String(result) : "Error";
    const line = `${left} ${sym(operator)} ${right} = ${shown}`;
    current = shown; stored = null; pendingOp = null; justEvaluated = true;
    record(line); show(); exprEl.textContent = line;
  }
}
function scientific(name) {
  const x = Number(current);
  const rad = angleMode === "DEG" ? x * Math.PI / 180 : x;
  const functions = {
    sin: () => Math.sin(rad), cos: () => Math.cos(rad), tan: () => Math.tan(rad),
    asin: () => { const y = Math.asin(x); return angleMode === "DEG" ? y * 180 / Math.PI : y; },
    acos: () => { const y = Math.acos(x); return angleMode === "DEG" ? y * 180 / Math.PI : y; },
    atan: () => { const y = Math.atan(x); return angleMode === "DEG" ? y * 180 / Math.PI : y; },
    sqrt: () => Math.sqrt(x), square: () => x * x, reciprocal: () => 1 / x,
    ln: () => Math.log(x), log: () => Math.log10(x), exp: () => Math.exp(x),
    abs: () => Math.abs(x), factorial: () => {
      if (!Number.isInteger(x) || x < 0 || x > 170) return NaN;
      let r = 1; for (let i = 2; i <= x; i++) r *= i; return r;
    },
    pi: () => Math.PI, e: () => Math.E,
  };
  const labels = { square: "x²", reciprocal: "1/x", sqrt: "√", factorial: "!" };
  applyFunction(labels[name] || name, functions[name]);
}
document.querySelectorAll("button[data-k]").forEach((b) => b.addEventListener("click", () => press(b.dataset.k)));
document.querySelectorAll("button[data-sci]").forEach((b) => b.addEventListener("click", () => scientific(b.dataset.sci)));
document.getElementById("scientific-toggle").addEventListener("click", (event) => {
  const panel = document.getElementById("scientific-pad");
  panel.hidden = !panel.hidden;
  event.currentTarget.setAttribute("aria-expanded", String(!panel.hidden));
});
document.getElementById("angle-mode").addEventListener("click", (event) => {
  angleMode = angleMode === "DEG" ? "RAD" : "DEG";
  event.currentTarget.textContent = angleMode;
  event.currentTarget.setAttribute("aria-label", `Angle mode ${angleMode}`);
});
document.addEventListener("keydown", (e) => {
  const map = { Enter: "=", Escape: "C", Backspace: "C", x: "*", X: "*" };
  const k = map[e.key] ?? e.key;
  if (/^[0-9.]$/.test(k) || "+-*/=C".includes(k)) { press(k); e.preventDefault(); }
  if (e.key === "^" && !e.ctrlKey) { scientific("square"); e.preventDefault(); }
});
show();
