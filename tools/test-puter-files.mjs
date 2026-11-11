import assert from 'node:assert/strict';
import { injectPuterFilesAdapter, isPuterApp, PUTER_APP_IDS } from '../src/apps/puter-files-meta.ts';

assert.equal(isPuterApp('cad'), true);
assert.equal(isPuterApp('whiteboard'), true);
assert.equal(isPuterApp('arculator'), false);
assert.equal(PUTER_APP_IDS.size, 21);

const html = '<!doctype html><html><head><title>Test</title></head><body></body></html>';
const injected = injectPuterFilesAdapter(html);
assert.match(injected, /<head><script>try\{parent\.__d86PuterFiles/);
assert.equal(injectPuterFilesAdapter(injected), injected, 'adapter injection is idempotent');
assert.match(injectPuterFilesAdapter('<p>no head</p>'), /^<script>/);
console.log('Puter ZenFS adapter injection tests passed');
