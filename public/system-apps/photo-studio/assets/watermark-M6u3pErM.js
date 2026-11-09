const t=`// @name Add Watermark
// @description Adds a text layer with a line such as a copyright notice in a corner of the image.
const doc = await studio.documents.active();
if (!doc) return studio.ui.alert('Open a document first.');

const year = new Date().getFullYear();
const v = await studio.ui.form('Add Watermark', [
  { name: 'text', label: 'Text', value: \`© \${year}\` },
  { name: 'corner', label: 'Corner', type: 'select', value: 'bottom-right', options: [['bottom-right', 'Bottom right'], ['bottom-left', 'Bottom left'], ['top-right', 'Top right'], ['top-left', 'Top left'], ['center', 'Center']] },
  { name: 'size', label: 'Size (% of the shorter side)', type: 'range', min: 1, max: 20, step: 1, value: 4 },
  { name: 'color', label: 'Color', type: 'color', value: '#ffffff' },
  { name: 'opacity', label: 'Opacity (%)', type: 'number', min: 1, max: 100, value: 70 },
  { name: 'shadow', label: 'Soft shadow', type: 'checkbox', value: true },
], { submit: 'Add' });
if (!v || !v.text.trim()) return;

const size = Math.max(6, Math.round((Math.min(doc.width, doc.height) * v.size) / 100));
const margin = Math.round(size * 0.8);
let layer = await doc.addLayer({ kind: 'text', name: 'Watermark', text: v.text, size, color: v.color, x: 0, y: 0 });
const b = layer.bounds;
const x = v.corner.endsWith('left') ? margin : v.corner === 'center' ? Math.round((doc.width - b.width) / 2) : doc.width - margin - b.width;
const y = v.corner.startsWith('top') ? margin : v.corner === 'center' ? Math.round((doc.height - b.height) / 2) : doc.height - margin - b.height;
layer = await layer.moveTo(x, y);
await layer.set({ opacity: v.opacity });
if (v.shadow) await layer.setStyle({ dropShadow: { opacity: 45, distance: Math.max(1, Math.round(size / 12)), size: Math.max(2, Math.round(size / 6)) } });
`;export{t as default};
