import assert from 'node:assert/strict';
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
const channel = new FakeChannel();
const states = [];
let calls = 0;
let finish;
const stop = startDrakeforgeSession(channel, (req) => {
  calls++;
  return new Promise((resolve) => { finish = () => resolve({ v: 2, t: 'fs-res', id: req.id, ok: true }); });
}, (state) => states.push(state));
assert.deepEqual(channel.sent[0], { v: 1, t: 'hello', caps: ['fs1'] });
channel.receive({ v: 1, t: 'ready', caps: ['fs1'] }); // not a hoster message
assert.deepEqual(states, ['connecting']);
channel.receive({ v: 1, t: 'ready', via: 'bc-hoster', caps: [] });
channel.receive({ v: 1, t: 'ready', via: 'bc-hoster', caps: ['fs1'] });
assert.deepEqual(states, ['connecting', 'ready', 'fs1']);
channel.receive({ v: 2, t: 'fs-req', via: 'bc-hoster', id: 7, op: 'tree', path: '/' });
assert.equal(calls, 1);
finish();
await Promise.resolve();
assert.deepEqual(channel.sent.at(-1), { v: 2, t: 'fs-res', id: 7, ok: true });
channel.receive({ v: 2, t: 'fs-req', via: 'bc-hoster', id: 8, op: 'read' });
stop();
finish();
await Promise.resolve();
assert.equal(channel.sent.at(-1).id, 7);
assert.equal(channel.closed, true);
stop();
console.log('DrakeForge scoped-session checks passed');
