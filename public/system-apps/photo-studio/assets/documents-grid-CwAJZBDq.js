const t=`// @name Grid from Open Documents
// @description Lays out a thumbnail of every open document in a grid on a new document, with optional names underneath.
const docs = await studio.documents.list();
if (!docs.length) return studio.ui.alert('Open the documents to collect first.');

const v = await studio.ui.form('Grid from Open Documents', [
  { name: 'columns', label: 'Columns', type: 'number', min: 1, max: 12, step: 1, value: Math.min(4, Math.ceil(Math.sqrt(docs.length))) },
  { name: 'cell', label: 'Cell size (px)', type: 'number', min: 32, max: 2048, step: 1, value: 320 },
  { name: 'gap', label: 'Gap (px)', type: 'number', min: 0, max: 400, step: 1, value: 24 },
  { name: 'background', label: 'Background', type: 'color', value: '#f2f2f2' },
  { name: 'captions', label: 'Names under the images', type: 'checkbox', value: true },
], { submit: 'Create' });
if (!v) return;

const cols = Math.min(v.columns, docs.length);
const rows = Math.ceil(docs.length / cols);
const captionHeight = v.captions ? Math.round(v.cell * 0.12) : 0;
const width = cols * v.cell + (cols + 1) * v.gap;
const height = rows * (v.cell + captionHeight) + (rows + 1) * v.gap;
if (width > 8192 || height > 8192) return studio.ui.alert('That grid would be larger than 8192 pixels. Use fewer columns or smaller cells.');

// Area-average downscale (or nearest-neighbor upscale) of RGBA pixels.
function resize(src, w, h) {
  const out = studio.image.create(w, h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * src.height) / h), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * src.height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * src.width) / w), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * src.width) / w));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1; sy++)
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * src.width + sx) * 4, alpha = src.data[i + 3];
          r += src.data[i] * alpha; g += src.data[i + 1] * alpha; b += src.data[i + 2] * alpha; a += alpha; n++;
        }
      const o = (y * w + x) * 4;
      if (a) { out.data[o] = r / a; out.data[o + 1] = g / a; out.data[o + 2] = b / a; }
      out.data[o + 3] = a / n;
    }
  }
  return out;
}

// Read every composite before the new document becomes the active one.
const thumbs = [];
for (const [i, d] of docs.entries()) {
  studio.checkCancelled();
  await studio.ui.progress(i / docs.length, \`Reading \${d.name}\`);
  const s = Math.min(v.cell / d.width, v.cell / d.height);
  const w = Math.max(1, Math.round(d.width * s)), h = Math.max(1, Math.round(d.height * s));
  thumbs.push({ name: d.name, image: resize(await d.composite(), w, h) });
}
const sheet = await studio.documents.create({ name: 'Document Grid', width, height, background: v.background });
for (const [i, t] of thumbs.entries()) {
  studio.checkCancelled();
  await studio.ui.progress(i / thumbs.length, \`Placing \${t.name}\`);
  const col = i % cols, row = Math.floor(i / cols);
  const cx = v.gap + col * (v.cell + v.gap), cy = v.gap + row * (v.cell + captionHeight + v.gap);
  const x = cx + Math.round((v.cell - t.image.width) / 2), y = cy + Math.round((v.cell - t.image.height) / 2);
  const layer = await sheet.addLayer({ name: t.name });
  await layer.setPixels(t.image, x, y);
  if (v.captions) {
    const caption = await sheet.addLayer({ kind: 'text', name: \`\${t.name} caption\`, text: t.name, size: Math.max(8, Math.round(captionHeight * 0.55)), color: '#333333', x: cx, y: cy + v.cell + Math.round(captionHeight * 0.2) });
    // Center the caption under its cell.
    await caption.move(Math.round((v.cell - caption.bounds.width) / 2), 0);
  }
}
`;export{t as default};
