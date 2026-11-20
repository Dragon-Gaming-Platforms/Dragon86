import assert from 'node:assert/strict';
import { injectZenFSFileAdapter, isZenFSFileApp, ZENFS_FILE_APP_IDS } from '../src/apps/zenfs-file-apps.ts';

assert.equal(isZenFSFileApp('cad'), true);
assert.equal(isZenFSFileApp('whiteboard'), true);
assert.equal(isZenFSFileApp('tasks'), true);
assert.equal(isZenFSFileApp('contacts'), true);
assert.equal(isZenFSFileApp('arculator'), true);
assert.equal(isZenFSFileApp('emulatorjs'), true);
assert.equal(isZenFSFileApp('ps1'), true);
assert.equal(ZENFS_FILE_APP_IDS.size, 26);

const html = '<!doctype html><html><head><title>Test</title></head><body></body></html>';
const injected = injectZenFSFileAdapter(html);
assert.match(injected, /<head><script>try\{parent\.__d86ZenFSFiles/);
assert.equal(injectZenFSFileAdapter(injected), injected, 'adapter injection is idempotent');
assert.match(injectZenFSFileAdapter('<p>no head</p>'), /^<script>/);
console.log('ZenFS file adapter injection tests passed');
