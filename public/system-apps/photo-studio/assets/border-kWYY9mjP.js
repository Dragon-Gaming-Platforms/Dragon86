const e=`// @name Add Border
// @description Draws a solid border around the canvas, or around the selection, on a new layer.
const doc = await studio.documents.active();
if (!doc) return studio.ui.alert('Open a document first.');
const selection = await doc.selection();

const v = await studio.ui.form('Add Border', [
  { name: 'width', label: 'Width (px)', type: 'number', min: 1, max: 1000, step: 1, value: Math.max(2, Math.round(Math.min(doc.width, doc.height) / 50)) },
  { name: 'color', label: 'Color', type: 'color', value: '#ffffff' },
  { name: 'where', label: 'Around', type: 'select', value: selection ? 'selection' : 'canvas', options: selection ? [['selection', 'The selection bounds'], ['canvas', 'The canvas']] : [['canvas', 'The canvas']] },
  { name: 'inside', label: 'Draw inside the edge', type: 'checkbox', value: true },
], { submit: 'Add' });
if (!v) return;

const box = v.where === 'selection' && selection ? selection : { x: 0, y: 0, width: doc.width, height: doc.height };
const w = Math.round(v.width);
// The outer rectangle of the frame; outside the edge it grows by the width.
const outer = v.inside ? box : { x: box.x - w, y: box.y - w, width: box.width + 2 * w, height: box.height + 2 * w };
const frame = studio.image.create(outer.width, outer.height);
const [r, g, b] = [1, 3, 5].map((i) => parseInt(v.color.slice(i, i + 2), 16));
for (let y = 0; y < outer.height; y++)
  for (let x = 0; x < outer.width; x++) {
    if (x >= w && y >= w && x < outer.width - w && y < outer.height - w) continue;
    const o = (y * outer.width + x) * 4;
    frame.data[o] = r;
    frame.data[o + 1] = g;
    frame.data[o + 2] = b;
    frame.data[o + 3] = 255;
  }
const layer = await doc.addLayer({ name: 'Border' });
await layer.setPixels(frame, outer.x, outer.y);
`;export{e as default};
