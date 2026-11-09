const e=`// @name Rename Layers by Pattern
// @description Renames the selected layers (or all layers) from a pattern with numbers, or by finding and replacing text.
const doc = await studio.documents.active();
if (!doc) return studio.ui.alert('Open a document first.');

const v = await studio.ui.form('Rename Layers by Pattern', [
  { name: 'scope', label: 'Layers', type: 'select', value: 'selected', options: [['selected', 'Selected layers'], ['all', 'All layers']] },
  { name: 'mode', label: 'Rename by', type: 'select', value: 'pattern', options: [['pattern', 'Pattern'], ['replace', 'Find and replace']] },
  { name: 'pattern', label: 'Pattern (# is the number, * the old name)', value: 'Layer ##' },
  { name: 'start', label: 'First number', type: 'number', min: 0, max: 100000, step: 1, value: 1 },
  { name: 'find', label: 'Find (find and replace)', value: '' },
  { name: 'replace', label: 'Replace with', value: '' },
  { name: 'regex', label: 'Find is a regular expression', type: 'checkbox', value: false },
], { submit: 'Rename' });
if (!v) return;

let layers = v.scope === 'selected' ? await doc.selectedLayers() : await doc.layers();
// Bottom-most first, so numbers grow upward as the stack is built.
layers = layers.filter((l) => !l.background).reverse();
if (!layers.length) return studio.ui.alert('There are no layers to rename.');

let find = null;
if (v.mode === 'replace') {
  if (!v.find) return studio.ui.alert('Enter the text to find.');
  try {
    find = v.regex ? new RegExp(v.find, 'g') : new RegExp(v.find.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&'), 'g');
  } catch (error) {
    return studio.ui.alert(\`That regular expression is not valid: \${error.message}\`);
  }
}
let renamed = 0;
for (const [i, layer] of layers.entries()) {
  const name = find
    ? layer.name.replace(find, v.replace)
    // A run of # becomes the number padded to that many digits.
    : v.pattern.replace(/#+/g, (h) => String(v.start + i).padStart(h.length, '0')).replace(/\\*/g, layer.name);
  if (name && name !== layer.name) {
    await layer.rename(name);
    renamed++;
  }
}
await studio.app.message(\`Renamed \${renamed} layer\${renamed === 1 ? '' : 's'}.\`);
`;export{e as default};
