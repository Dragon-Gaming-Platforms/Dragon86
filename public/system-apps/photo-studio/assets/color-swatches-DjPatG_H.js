const e=`// @name Random Color Swatches
// @description Builds a strip of harmonious color swatches with their hex codes as a group of layers.
const v = await studio.ui.form('Random Color Swatches', [
  { name: 'count', label: 'Swatches', type: 'number', min: 2, max: 12, step: 1, value: 5 },
  { name: 'scheme', label: 'Scheme', type: 'select', value: 'analogous', options: [['analogous', 'Neighboring hues'], ['complementary', 'Opposite hues'], ['triad', 'Three-way'], ['shades', 'Shades of one hue'], ['random', 'Anything goes']] },
  { name: 'labels', label: 'Hex codes under the swatches', type: 'checkbox', value: true },
  { name: 'seed', label: 'Seed (0 picks a new one)', type: 'number', min: 0, max: 999999, step: 1, value: 0 },
], { submit: 'Create' });
if (!v) return;

// A small seeded generator, so a seed reproduces its palette.
let state = v.seed || Math.floor(Math.random() * 999999) + 1;
const random = () => ((state = (state * 48271) % 2147483647) / 2147483647);
const hsl = (h, s, l) => {
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return [f(0), f(8), f(4)];
};
const base = random() * 360;
const colors = [];
for (let i = 0; i < v.count; i++) {
  const t = i / Math.max(1, v.count - 1);
  let h = base, s = 0.45 + random() * 0.4, l = 0.35 + random() * 0.35;
  if (v.scheme === 'analogous') h = base + (t - 0.5) * 70;
  else if (v.scheme === 'complementary') h = base + (i % 2) * 180 + (random() - 0.5) * 16;
  else if (v.scheme === 'triad') h = base + (i % 3) * 120 + (random() - 0.5) * 12;
  else if (v.scheme === 'shades') l = 0.18 + t * 0.66;
  else h = random() * 360;
  colors.push(hsl(((h % 360) + 360) % 360, s, l));
}
const hex = (c) => '#' + c.map((x) => x.toString(16).padStart(2, '0')).join('');

const swatch = 160, gap = 16, label = v.labels ? 40 : 0;
let doc = await studio.documents.active();
if (!doc) doc = await studio.documents.create({ name: 'Swatches', width: v.count * (swatch + gap) + gap, height: swatch + label + 2 * gap, background: 'white' });
const group = await doc.addLayer({ kind: 'group', name: \`Swatches \${state}\` });
const x0 = Math.max(0, Math.round((doc.width - (v.count * (swatch + gap) - gap)) / 2));
const y0 = Math.max(0, Math.round((doc.height - swatch - label) / 2));
for (const [i, c] of colors.entries()) {
  const x = x0 + i * (swatch + gap);
  await doc.addLayer({ name: hex(c), fill: hex(c), rect: { x, y: y0, width: swatch, height: swatch }, inside: group });
  if (v.labels) {
    const t = await doc.addLayer({ kind: 'text', name: \`\${hex(c)} label\`, text: hex(c).toUpperCase(), size: 22, color: '#333333', x, y: y0 + swatch + 10, inside: group });
    await t.move(Math.round((swatch - t.bounds.width) / 2), 0);
  }
}
console.log(colors.map(hex).join(' '));
`;export{e as default};
