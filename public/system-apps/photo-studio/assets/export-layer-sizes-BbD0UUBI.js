const e=`// @name Export Layers at Several Sizes
// @description Saves every layer as its own image at each of the scales you list, collected in one ZIP file.
const doc = await studio.documents.active();
if (!doc) return studio.ui.alert('Open a document first.');

const v = await studio.ui.form('Export Layers at Several Sizes', [
  { name: 'scales', label: 'Scales (percent, separated by commas)', value: '100, 50, 25' },
  { name: 'format', label: 'Format', type: 'select', value: 'png', options: [['png', 'PNG'], ['jpeg', 'JPEG'], ['webp', 'WebP']] },
  { name: 'quality', label: 'Quality (JPEG and WebP)', type: 'range', min: 10, max: 100, step: 5, value: 85 },
  { name: 'visibleOnly', label: 'Visible layers only', type: 'checkbox', value: true },
  { name: 'trim', label: 'Trim to each layer’s content', type: 'checkbox', value: true },
], { submit: 'Export' });
if (!v) return;

const scales = v.scales.split(/[,;\\s]+/).map(Number).filter((n) => n > 0 && n <= 1000);
if (!scales.length) return studio.ui.alert('List at least one scale, such as 100, 50.');
// Groups export their children; adjustment layers have no pixels of their own.
const layers = (await doc.layers()).filter((l) => !['group', 'artboard', 'adjustment'].includes(l.kind) && (!v.visibleOnly || l.visible));
if (!layers.length) return studio.ui.alert('There are no layers to export.');

const safe = (s) => s.replace(/[^\\w\\- ]+/g, '_').trim() || 'layer';
const files = [];
let done = 0;
for (const layer of layers) {
  for (const scale of scales) {
    studio.checkCancelled();
    await studio.ui.progress(done / (layers.length * scales.length), \`\${layer.name} at \${scale}%\`);
    const out = await layer.export({ format: v.format, quality: v.quality, scale: scale / 100, trim: v.trim });
    files.push({ name: \`\${safe(layer.name)}@\${scale}.\${out.extension}\`, data: out.data });
    done++;
  }
}
await studio.ui.progress(1, 'Saving…');
await studio.files.saveAll(files, \`\${safe(doc.name)}-layers.zip\`);
console.log(\`Exported \${layers.length} layers at \${scales.length} sizes.\`);
`;export{e as default};
