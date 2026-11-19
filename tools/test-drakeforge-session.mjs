import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promises as nodeFs } from 'node:fs';
import { createFsResponder } from '../src/bridge/fs-bridge.ts';
import { drakeforgeSessionUrl, startDrakeforgeSession } from '../src/bridge/drakeforge-session.ts';

const id = '12345678-1234-1234-1234-123456789abc';
const url = drakeforgeSessionUrl(id);
assert.equal(url.origin, 'https://dragon-gaming-platforms.github.io');
assert.equal(url.pathname, '/DrakeForge/dragon86');
assert.equal(url.searchParams.get('channel'), `dragon86-drakeforge-${id}`);
assert.throws(() => drakeforgeSessionUrl('dragon86-hoster-v1'));

class FakeChannel {
  sent = [];
  handler = null;
  closed = false;
  postMessage(m) { this.sent.push(m); }
  addEventListener(_, handler) { this.handler = handler; }
  removeEventListener() { this.handler = null; }
  close() { this.closed = true; }
  receive(data) { this.handler?.({ data }); }
}

const root = await mkdtemp(path.join(os.tmpdir(), 'dragon86-drakeforge-fs1-'));
try {
  await mkdir(path.join(root, 'Documents'));
  await writeFile(path.join(root, 'Documents', 'hello.txt'), 'hello from Dragon86');
  const respond = createFsResponder(root, nodeFs);
  const channel = new FakeChannel();
  const states = [];
  const stop = startDrakeforgeSession(channel, respond, (state) => states.push(state));
  assert.deepEqual(channel.sent[0], { v: 1, t: 'hello', caps: ['fs1'] });
  assert.deepEqual(states, ['connecting']);

  /* Old/shared traffic and bad markers must not negotiate or access the FS. */
  channel.receive({ v: 1, t: 'ready', via: 'some-other-host', caps: ['fs1'] });
  channel.receive({ v: 2, t: 'fs-req', via: 'bc-hoster', id: 1, op: 'list', path: '/' });
  assert.deepEqual(states, ['connecting']);
  assert.equal(channel.sent.at(-1).id, 1);
  assert.equal(channel.sent.at(-1).ok, false, 'fs requests are gated on ready/fs1');

  /* The deployed route's ready event is allowed without `via`; fs-reqs carry
     via=bc-hoster and are answered with the caller's request ID. */
  channel.receive({ v: 1, t: 'ready', caps: [] });
  assert.deepEqual(states, ['connecting', 'ready']);
  channel.receive({ v: 1, t: 'ready', caps: ['fs1'] });
  assert.deepEqual(states, ['connecting', 'ready', 'fs1']);

  channel.receive({ v: 2, t: 'fs-req', via: 'not-bc-hoster', id: 2, op: 'list', path: '/' });
  assert.equal(channel.sent.at(-1).id, 1, 'messages outside the selected hoster protocol are ignored');

  const request = async (msg) => {
    const before = channel.sent.length;
    channel.receive({ v: 2, t: 'fs-req', via: 'bc-hoster', ...msg });
    for (let i = 0; i < 30 && channel.sent.length === before; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.ok(channel.sent.length > before, `request ${msg.id} received no response`);
    return channel.sent.at(-1);
  };

  const listed = await request({ id: 7, op: 'list', path: '/Documents' });
  assert.equal(listed.id, 7);
  assert.equal(listed.ok, true);
  assert.ok(listed.entries.some((entry) => entry.name === 'hello.txt'));

  const read = await request({ id: 8, op: 'read', path: '/Documents/hello.txt' });
  assert.equal(read.id, 8);
  assert.equal(new TextDecoder().decode(read.data), 'hello from Dragon86');

  const bytes = new TextEncoder().encode('created through fs1');
  const written = await request({ id: 9, op: 'write', path: '/Documents/from-drakeforge.txt', data: bytes });
  assert.equal(written.id, 9);
  assert.equal(written.ok, true);
  assert.equal(await readFile(path.join(root, 'Documents', 'from-drakeforge.txt'), 'utf8'), 'created through fs1');

  const escaped = await request({ id: 10, op: 'read', path: '../../outside.txt' });
  assert.equal(escaped.id, 10);
  assert.equal(escaped.ok, false, 'paths cannot escape the shared home root');

  stop();
  assert.equal(channel.closed, true);
  assert.equal(channel.handler, null);
  stop();
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log('DrakeForge connected-session and fs1 checks passed');
