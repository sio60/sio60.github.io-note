const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const source = fs.readFileSync(require('node:path').join(__dirname, '../web/cloud.js'), 'utf8');
const ACTIVE = 'curse-note.cloud.active.v1', PREFIX = 'curse-note.cloud.vault.v1:';
const codeFor = letter => 'cn1_' + letter.repeat(43);
const copy = value => JSON.parse(JSON.stringify(value));
const entry = (id = '11111111-1111-4111-8111-111111111111', body = 'original') => ({ id, name: '이름', body, date: '2026-10-12', createdAt: '2026-10-12T00:00:00.000Z', updatedAt: '2026-10-12T00:00:00.000Z', curse: null });
class MemoryStorage {
  constructor() { this.values = new Map(); this.fail = false; }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { if (this.fail) throw new Error('quota exceeded'); this.values.set(key, value); }
}
function server() {
  const s = { vaults: new Map(), calls: [], offline: false, beforeWrite: null, beforeRead: null };
  s.seed = (code, records, revision = 1) => s.vaults.set(code, { revision, records: copy(records) });
  s.fetch = async (url, request) => {
    const body = JSON.parse(request.body), method = url.split('/').at(-1);
    s.calls.push({ url, request, body, method });
    if (s.offline) throw new TypeError('offline');
    if (method === 'curse_note_read') await s.beforeRead?.(body, request);
    else await s.beforeWrite?.(body, request);
    const old = s.vaults.get(body.p_code);
    let result;
    if (method === 'curse_note_read') result = old ? { status: 'ok', ...copy(old) } : { status: 'missing', revision: 0, records: [] };
    else if ((old?.revision || 0) !== body.p_revision) result = { status: 'conflict', ...copy(old) };
    else {
      const next = { revision: body.p_revision + 1, records: copy(body.p_records) };
      s.vaults.set(body.p_code, next);
      result = { status: 'ok', ...copy(next) };
    }
    return { ok: true, status: 200, json: async () => result };
  };
  return s;
}
function client(s, { storage = new MemoryStorage(), entries = [], config = { supabaseUrl: 'https://example.supabase.co', publishableKey: 'sb_publishable_test' } } = {}) {
  let app = copy(entries);
  const statuses = [], applied = [], listeners = {}, timers = new Map();
  let timerId = 0;
  const window = { CURSE_CONFIG: config, addEventListener: (name, fn) => { listeners[name] = fn; } };
  const context = vm.createContext({
    window, localStorage: storage, crypto: webcrypto, fetch: s.fetch, URL, TextEncoder,
    AbortController, Uint8Array, Date, console,
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id),
    setInterval: () => 1, document: { hidden: false, addEventListener: (name, fn) => { listeners[name] = fn; } }
  });
  vm.runInContext(source, context);
  const cloud = window.CurseCloud;
  return {
    cloud, storage, statuses, applied, listeners, timers,
    get entries() { return app; },
    start: () => cloud.start({ getEntries: () => app, onRemote: records => { app = copy(records); applied.push(copy(records)); return true; }, onStatus: status => statuses.push(copy(status)) }),
    edit: records => { app = copy(records); return cloud.notify(app); },
    get status() { return statuses.at(-1); }
  };
}
function gate() {
  let release, entered;
  const reached = new Promise(resolve => { entered = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  return { reached, release, hold: async () => { entered(); await wait; } };
}

test('blank configuration remains honestly local and makes no network requests', async () => {
  const s = server(), c = client(s, { entries: [entry()], config: {} });
  assert.equal(await c.start(), false);
  assert.equal(c.status.state, 'local');
  assert.equal(c.cloud.getRecoveryCode(), null);
  assert.equal(s.calls.length, 0);
  assert.equal(c.entries.length, 1);
});

test('migrates all old local notes and only sends the capability in POST bodies', async () => {
  const s = server(), c = client(s, { entries: [entry()] });
  assert.equal(await c.start(), true);
  const code = c.cloud.getRecoveryCode();
  assert.match(code, /^cn1_[\w-]{43}$/);
  assert.equal(s.vaults.get(code).records[0].body, 'original');
  assert.equal(c.status.state, 'synced');
  for (const call of s.calls) {
    assert.ok(!call.url.includes(code));
    assert.equal(call.request.method, 'POST');
    assert.equal(call.request.headers.apikey, 'sb_publishable_test');
    assert.equal(call.request.headers.Authorization, undefined);
    assert.equal(call.request.credentials, 'omit');
  }
});

test('persists offline edits and deletions before requests and survives a reload', async () => {
  const s = server(), c = client(s, { entries: [entry(), entry('22222222-2222-4222-8222-222222222222', 'remove me')] });
  await c.start();
  const code = c.cloud.getRecoveryCode();
  s.offline = true;
  c.edit([{ ...c.entries[0], body: 'offline edit' }]);
  const queued = JSON.parse(c.storage.getItem(PREFIX + code));
  assert.equal(queued.records.filter(x => x.deleted).length, 1);
  assert.ok(queued.records.some(x => x.body === 'offline edit'));
  await c.cloud.syncNow();
  assert.equal(c.status.state, 'offline');
  const reloaded = client(s, { storage: c.storage, entries: c.entries });
  await reloaded.start();
  s.offline = false;
  assert.equal(await reloaded.cloud.syncNow(), true);
  assert.equal(reloaded.entries.length, 1);
  assert.equal(reloaded.entries[0].body, 'offline edit');
  assert.equal(s.vaults.get(code).records.filter(x => x.deleted).length, 1);
});

test('sequential offline saves are edits, not false conflict copies', async () => {
  const s = server(), c = client(s, { entries: [entry()] });
  await c.start(); s.offline = true;
  c.edit([{ ...c.entries[0], body: 'first' }]);
  c.edit([{ ...c.entries[0], body: 'second' }]);
  s.offline = false;
  await c.cloud.syncNow();
  assert.equal(c.entries.length, 1);
  assert.equal(c.entries[0].body, 'second');
});

test('wrong recovery code leaves the current vault, queue, and visible notebook intact', async () => {
  const s = server(), c = client(s, { entries: [entry()] });
  await c.start();
  const code = c.cloud.getRecoveryCode(), before = copy(c.entries);
  await assert.rejects(c.cloud.restore(codeFor('z')), /찾을 수 없습니다/);
  assert.equal(c.cloud.getRecoveryCode(), code);
  assert.deepEqual(c.entries, before);
  assert.equal(JSON.parse(c.storage.getItem(ACTIVE)).code, code);
  const count = s.calls.length;
  await assert.rejects(c.cloud.restore('bad'), /정확히/);
  assert.equal(s.calls.length, count);
});

test('restoring replaces the active notebook without uploading records from the prior vault', async () => {
  const s = server(), target = codeFor('B');
  s.seed(target, [entry('22222222-2222-4222-8222-222222222222', 'target vault')]);
  const c = client(s, { entries: [entry()] });
  await c.start(); const oldCode = c.cloud.getRecoveryCode();
  s.offline = true; c.edit([{ ...c.entries[0], body: 'old vault pending' }]);
  s.offline = false;
  await c.cloud.restore(target);
  await c.cloud.syncNow();
  assert.equal(c.cloud.getRecoveryCode(), target);
  assert.deepEqual(c.entries.map(x => x.body), ['target vault']);
  assert.deepEqual(s.vaults.get(target).records.map(x => x.body), ['target vault']);
  assert.ok(JSON.parse(c.storage.getItem(PREFIX + oldCode)).records.some(x => x.body === 'old vault pending'));
  await c.cloud.restore(oldCode);
  await c.cloud.syncNow();
  assert.deepEqual(c.entries.map(x => x.body), ['old vault pending']);
});

test('an offline-only vault can be recovered from its known local queue after switching', async () => {
  const s = server(), target = codeFor('F');
  s.seed(target, [entry('22222222-2222-4222-8222-222222222222', 'online target')]);
  s.offline = true;
  const c = client(s, { entries: [entry()] });
  await c.start(); const offlineCode = c.cloud.getRecoveryCode();
  c.edit([{ ...c.entries[0], body: 'never uploaded' }]);
  assert.equal(s.vaults.has(offlineCode), false);
  s.offline = false;
  await c.cloud.restore(target);
  await c.cloud.restore(offlineCode);
  assert.deepEqual(c.entries.map(x => x.body), ['never uploaded']);
  assert.equal(c.status.state, 'syncing');
  await c.cloud.syncNow();
  assert.deepEqual(s.vaults.get(offlineCode).records.map(x => x.body), ['never uploaded']);
});

test('CAS conflict preserves both edits with stable UUID conflict IDs', async () => {
  const s = server(), c = client(s, { entries: [entry()] });
  await c.start(); const code = c.cloud.getRecoveryCode();
  c.edit([{ ...c.entries[0], body: 'local change' }]);
  let injected = false;
  s.beforeWrite = async () => {
    if (injected) return;
    injected = true;
    const old = s.vaults.get(code);
    s.seed(code, [{ ...entry(), body: 'remote change', updatedAt: '2026-10-12T23:59:00.000Z' }], old.revision + 1);
  };
  assert.equal(await c.cloud.syncNow(), true);
  assert.deepEqual(c.entries.map(x => x.body).sort(), ['local change', 'remote change']);
  assert.match(c.entries.find(x => x.id !== entry().id).id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const ids = c.entries.map(x => x.id).sort();
  await c.cloud.syncNow();
  assert.deepEqual(c.entries.map(x => x.id).sort(), ids);
});

test('a remote tombstone removes an unedited stale local copy without resurrection', async () => {
  const s = server(), c = client(s, { entries: [entry()] });
  await c.start(); const code = c.cloud.getRecoveryCode();
  const old = s.vaults.get(code);
  s.seed(code, [{ id: entry().id, deleted: true, updatedAt: '2026-10-12T23:59:00.000Z' }], old.revision + 1);
  await c.cloud.syncNow();
  assert.equal(c.entries.length, 0);
  assert.equal(s.vaults.get(code).records.length, 1);
  assert.equal(s.vaults.get(code).records[0].deleted, true);
});

test('concurrent edit versus deletion keeps the tombstone and a separate edited copy', async () => {
  const s = server(), c = client(s, { entries: [entry()] });
  await c.start(); const code = c.cloud.getRecoveryCode();
  c.edit([{ ...c.entries[0], body: 'concurrent edit' }]);
  s.seed(code, [{ id: entry().id, deleted: true, updatedAt: '2026-10-12T23:59:00.000Z' }], 2);
  await c.cloud.syncNow();
  assert.equal(c.entries.length, 1);
  assert.equal(c.entries[0].body, 'concurrent edit');
  assert.notEqual(c.entries[0].id, entry().id);
  assert.ok(s.vaults.get(code).records.some(x => x.id === entry().id && x.deleted));
});

test('edits made while a write is in flight stay queued and reach the server', async () => {
  const s = server(), c = client(s, { entries: [entry()] });
  await c.start();
  const g = gate(); let held = false;
  s.beforeWrite = async () => { if (!held) { held = true; await g.hold(); } };
  c.edit([{ ...c.entries[0], body: 'first edit' }]);
  const syncing = c.cloud.syncNow();
  await g.reached;
  c.edit([{ ...c.entries[0], body: 'second edit' }]);
  g.release();
  await syncing;
  assert.deepEqual(c.entries.map(x => x.body), ['second edit']);
  assert.deepEqual(s.vaults.get(c.cloud.getRecoveryCode()).records.map(x => x.body), ['second edit']);
});

test('an old in-flight request cannot apply records after a vault switch', async () => {
  const s = server(), c = client(s, { entries: [entry()] }), target = codeFor('C');
  s.seed(target, [entry('33333333-3333-4333-8333-333333333333', 'recovered')]);
  await c.start(); const oldCode = c.cloud.getRecoveryCode();
  const g = gate();
  s.beforeWrite = async body => { if (body.p_code === oldCode) await g.hold(); };
  c.edit([{ ...c.entries[0], body: 'old in flight' }]);
  const syncing = c.cloud.syncNow();
  await g.reached;
  await c.cloud.restore(target);
  g.release(); await syncing;
  assert.equal(c.cloud.getRecoveryCode(), target);
  assert.deepEqual(c.entries.map(x => x.body), ['recovered']);
  assert.deepEqual(s.vaults.get(target).records.map(x => x.body), ['recovered']);
});

test('failed durable queue storage never starts an upload or reports success', async () => {
  const s = server(), c = client(s, { entries: [entry()] });
  await c.start();
  const callCount = s.calls.length;
  c.storage.fail = true;
  assert.equal(c.edit([{ ...c.entries[0], body: 'cannot queue' }]), false);
  assert.equal(c.status.state, 'error');
  assert.equal(s.calls.length, callCount);
  c.storage.fail = false;
  await c.cloud.syncNow();
  assert.deepEqual(c.entries.map(x => x.body), ['cannot queue']);
  assert.deepEqual(s.vaults.get(c.cloud.getRecoveryCode()).records.map(x => x.body), ['cannot queue']);
});

test('a browser tab cannot upload or apply its previous vault after another tab switches', async () => {
  const s = server(), c = client(s, { entries: [entry()] });
  await c.start();
  const before = s.calls.length;
  c.storage.setItem(ACTIVE, JSON.stringify({ code: codeFor('E'), pendingApply: false }));
  assert.equal(await c.cloud.syncNow(), false);
  assert.equal(c.status.state, 'error');
  assert.equal(s.calls.length, before);
});

test('an in-flight old-tab pull cannot overwrite the shared app after another tab restores', async () => {
  const s = server(), c = client(s, { entries: [entry()] }), target = codeFor('G');
  s.seed(target, [entry('77777777-7777-4777-8777-777777777777', 'new vault')]);
  await c.start(); const oldCode = c.cloud.getRecoveryCode();
  const g = gate();
  s.beforeRead = async body => { if (body.p_code === oldCode) await g.hold(); };
  const inFlight = c.cloud.syncNow();
  await g.reached;
  const other = client(s, { storage: c.storage, entries: c.entries });
  // A normal second tab already loaded before restore, so release only its initial read.
  s.beforeRead = null;
  await other.start();
  await other.cloud.restore(target);
  const appliedCount = c.applied.length;
  s.seed(oldCode, [{ ...entry(), body: 'old vault remote update' }], 2);
  g.release();
  await inFlight;
  assert.equal(c.applied.length, appliedCount);
  assert.deepEqual(other.entries.map(x => x.body), ['new vault']);
  assert.equal(JSON.parse(c.storage.getItem(ACTIVE)).code, target);
});

test('a deleted original never comes back even when the acknowledged base is a tombstone', async () => {
  const s = server(), c = client(s, { entries: [entry()] });
  await c.start(); const code = c.cloud.getRecoveryCode();
  c.edit([]); await c.cloud.syncNow();
  const revision = s.vaults.get(code).revision;
  s.seed(code, [entry()], revision + 1);
  await c.cloud.syncNow();
  assert.equal(c.entries.length, 0);
  assert.equal(s.vaults.get(code).records[0].deleted, true);
});

test('oversized queues stay durable and are never claimed to be synced', async () => {
  const s = server(), c = client(s);
  await c.start();
  const records = Array.from({ length: 501 }, (_, i) => entry(i.toString(16).padStart(8, '0') + '-1111-4111-8111-111111111111', 'note'));
  c.edit(records);
  const before = s.calls.filter(call => call.method === 'curse_note_write').length;
  await c.cloud.syncNow();
  assert.equal(c.status.state, 'error');
  assert.equal(c.entries.length, 501);
  assert.equal(JSON.parse(c.storage.getItem(PREFIX + c.cloud.getRecoveryCode())).records.length, 501);
  assert.equal(s.calls.filter(call => call.method === 'curse_note_write').length, before);
});

test('repeated compare-and-swap conflicts stop after a bounded number of attempts', async () => {
  const s = server(), c = client(s, { entries: [entry()] });
  await c.start(); const code = c.cloud.getRecoveryCode();
  c.edit([{ ...c.entries[0], body: 'queued edit' }]);
  let attempts = 0;
  s.beforeWrite = async () => { attempts++; const old = s.vaults.get(code); s.seed(code, old.records, old.revision + 1); };
  assert.equal(await c.cloud.syncNow(), false);
  assert.equal(attempts, 4);
  assert.equal(c.status.state, 'offline');
  assert.equal(c.entries[0].body, 'queued edit');
});

test('a pending vault switch recovers the target without importing the previous app snapshot', async () => {
  const s = server(), storage = new MemoryStorage(), target = codeFor('D'), recovered = entry('44444444-4444-4444-8444-444444444444', 'target only');
  s.seed(target, [recovered]);
  storage.setItem(ACTIVE, JSON.stringify({ code: target, pendingApply: true }));
  storage.setItem(PREFIX + target, JSON.stringify({ version: 1, revision: 1, base: [recovered], records: [recovered] }));
  const c = client(s, { storage, entries: [entry()] });
  await c.start();
  assert.deepEqual(c.entries.map(x => x.body), ['target only']);
  assert.deepEqual(s.vaults.get(target).records.map(x => x.body), ['target only']);
});

test('rejects secret and service-role credentials before making requests', async () => {
  for (const key of ['sb_secret_forbidden', 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url') + '.signature']) {
    const s = server(), c = client(s, { config: { supabaseUrl: 'https://example.supabase.co', publishableKey: key } });
    await c.start();
    assert.equal(c.status.state, 'error');
    assert.equal(s.calls.length, 0);
  }
});

test('invalid records fail safely before upload under the same contract as the database', async () => {
  const cases = [
    { id: 'not-a-uuid' }, { name: '' }, { date: '2026-02-31' },
    { updatedAt: '2026-10-12T00:00:00Z' }, { createdAt: '2026-02-31T00:00:00.000Z' },
    { curse: { status: 'pending', startedAt: -1, deadline: 40000 } },
    { curse: { status: 'pending', startedAt: 1.5, deadline: 40000 } },
    { curse: { status: 'pending', startedAt: 40000, deadline: 1 } },
    { curse: { status: 'revoked', startedAt: 0, deadline: 40000, revokedAt: 253402300800000 } }
  ];
  for (const invalid of cases) {
    const s = server(), input = { ...entry(), ...invalid }, c = client(s, { entries: [input] });
    assert.equal(await c.start(), false);
    assert.equal(c.status.state, 'error');
    assert.equal(s.calls.length, 0);
    assert.deepEqual(c.entries, [input]);
  }
});

test('an unanswered request times out and keeps its durable local queue', async () => {
  const s = server();
  s.fetch = async (url, request) => new Promise((resolve, reject) => {
    request.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const c = client(s, { entries: [entry()] });
  const starting = c.start();
  for (const callback of [...c.timers.values()]) callback();
  assert.equal(await starting, false);
  assert.equal(c.status.state, 'offline');
  assert.equal(JSON.parse(c.storage.getItem(PREFIX + c.cloud.getRecoveryCode())).records.length, 1);
});
