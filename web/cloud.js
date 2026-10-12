(() => {
  'use strict';

  // The recovery code is the vault's capability. Never put it in a URL or log it.
  const ACTIVE_KEY = 'curse-note.cloud.active.v1';
  const VAULT_PREFIX = 'curse-note.cloud.vault.v1:';
  const CODE = /^cn1_[A-Za-z0-9_-]{43}$/;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const MAX_RECORDS = 500, MAX_BYTES = 1024 * 1024, MAX_ATTEMPTS = 4;
  let hooks = {}, config = null, code = null, state = null, visible = [];
  let generation = 0, running = null, timer = null, controller = null;
  let started = false, restoring = false, restoreTicket = 0;

  class CloudError extends Error {
    constructor(message, kind = 'error') { super(message); this.kind = kind; }
  }
  const clone = value => JSON.parse(JSON.stringify(value));
  function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
    return JSON.stringify(value);
  }
  const equal = (a, b) => canonical(a) === canonical(b);
  const active = records => records.filter(record => !record.deleted).map(clone);
  const recordMap = records => new Map(records.map(record => [record.id, record]));
  const timestamp = record => Date.parse(record?.updatedAt || record?.createdAt || '') || 0;
  function sameContent(a, b) {
    if (!a || !b) return a === b;
    const x = { ...a }, y = { ...b };
    delete x.updatedAt; delete y.updatedAt;
    return equal(x, y);
  }
  function sortRecords(records) { return records.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0); }
  function validISO(value) {
    if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
    try { return new Date(value).toISOString() === value; } catch { return false; }
  }
  const validDate = value => typeof value === 'string' && /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value) && validISO(value + 'T00:00:00.000Z');
  const validMillis = value => Number.isSafeInteger(value) && value >= 0 && value <= 253402300799999;
  function normalize(records) {
    if (!Array.isArray(records)) throw new CloudError('클라우드 기록 형식이 올바르지 않습니다.');
    const ids = new Set();
    return sortRecords(records.map(raw => {
      if (!raw || typeof raw.id !== 'string' || !UUID.test(raw.id) || ids.has(raw.id)) throw new CloudError('클라우드 기록을 안전하게 읽을 수 없습니다.');
      ids.add(raw.id);
      if ((raw.updatedAt != null && !validISO(raw.updatedAt)) || (raw.createdAt != null && !validISO(raw.createdAt))) throw new CloudError('기록의 저장 시각 형식을 확인해주세요.');
      const updatedAt = raw.updatedAt || raw.createdAt || '1970-01-01T00:00:00.000Z';
      if (raw.deleted === true) return { id: raw.id, deleted: true, updatedAt };
      if (typeof raw.name !== 'string' || !raw.name.length || raw.name.length > 60 || typeof raw.body !== 'string' || raw.body.length > 20000 || !validDate(raw.date) || /\u0000/.test(raw.name + raw.body)) throw new CloudError('기록 형식이나 길이를 확인해주세요.');
      let curse = null;
      if (raw.curse != null) {
        if (!['pending', 'fulfilled', 'revoked'].includes(raw.curse.status) || !validMillis(raw.curse.startedAt) || !validMillis(raw.curse.deadline) || raw.curse.deadline < raw.curse.startedAt || (raw.curse.revokedAt != null && !validMillis(raw.curse.revokedAt))) throw new CloudError('저주 상태를 안전하게 읽을 수 없습니다.');
        curse = { status: raw.curse.status, startedAt: raw.curse.startedAt, deadline: raw.curse.deadline };
        if (Number.isFinite(raw.curse.revokedAt)) curse.revokedAt = raw.curse.revokedAt;
      }
      return { id: raw.id, name: raw.name, body: raw.body, date: raw.date, createdAt: raw.createdAt || updatedAt, updatedAt, curse };
    }));
  }
  function checkSize(records) {
    // Match PostgreSQL jsonb::text spacing, which is included in its byte limit.
    const pgJSON = value => Array.isArray(value) ? '[' + value.map(pgJSON).join(', ') + ']' : value && typeof value === 'object' ? '{' + Object.keys(value).map(key => JSON.stringify(key) + ': ' + pgJSON(value[key])).join(', ') + '}' : JSON.stringify(value);
    if (records.length > MAX_RECORDS || new TextEncoder().encode(pgJSON(records)).length > MAX_BYTES) throw new CloudError('클라우드 보관 한도(삭제 기록 포함 500개, 1MB)를 넘었습니다. 이 기기의 기록은 유지됩니다.');
  }
  function conflictId(record) {
    // Stable IDs make retries idempotent and avoid creating a fresh copy each pull.
    const input = canonical(record);
    const words = [2166136261, 3335557771, 1013904223, 2773480762];
    for (let i = 0; i < input.length; i++) for (let j = 0; j < words.length; j++) words[j] = Math.imul(words[j] ^ input.charCodeAt(i), [16777619, 2246822519, 3266489917, 668265263][j]);
    const hex = words.map(word => (word >>> 0).toString(16).padStart(8, '0')).join('');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-4' + hex.slice(13, 16) + '-' + ((parseInt(hex[16], 16) & 3) | 8).toString(16) + hex.slice(17, 20) + '-' + hex.slice(20);
  }
  function preferred(a, b) { return timestamp(a) !== timestamp(b) ? timestamp(a) > timestamp(b) ? a : b : canonical(a) >= canonical(b) ? a : b; }
  function merge(baseRecords, localRecords, remoteRecords) {
    const base = recordMap(baseRecords), local = recordMap(localRecords), remote = recordMap(remoteRecords);
    const output = new Map(), copies = [];
    for (const id of new Set([...local.keys(), ...remote.keys()])) {
      const old = base.get(id), left = local.get(id), right = remote.get(id);
      let chosen;
      if (!left) chosen = right;
      else if (!right) chosen = left;
      else if (sameContent(left, right)) chosen = preferred(left, right);
      else if (left.deleted || right.deleted) {
        chosen = left.deleted && right.deleted ? preferred(left, right) : left.deleted ? left : right;
        // A stale copy never revives a deletion. Preserve only a provable concurrent edit.
        const edited = left.deleted ? right : left;
        if (old && !old.deleted && !edited.deleted && !sameContent(edited, old)) copies.push(edited);
      } else if (sameContent(left, old)) chosen = right;
      else if (sameContent(right, old)) chosen = left;
      else {
        chosen = preferred(left, right);
        copies.push(chosen === left ? right : left);
      }
      output.set(id, clone(chosen));
    }
    for (const record of copies) {
      const id = conflictId(record);
      if (!output.has(id)) output.set(id, { ...clone(record), id, name: record.name.slice(0, 49) + ' (충돌 보관)' });
    }
    return sortRecords([...output.values()]);
  }
  function emit(status, message) {
    try { hooks.onStatus?.({ state: status, message }); } catch { /* UI observers cannot corrupt the queue. */ }
  }
  function stored(key) {
    try { const value = localStorage.getItem(key); return value == null ? null : JSON.parse(value); }
    catch { throw new CloudError('이 브라우저의 저장 공간을 읽을 수 없습니다. 기록을 내려받아 보관해주세요.'); }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch { throw new CloudError('동기화 대기 기록을 저장하지 못했습니다. 기록을 내려받아 보관해주세요.'); }
  }
  function loadVault(vaultCode) {
    const saved = stored(VAULT_PREFIX + vaultCode);
    if (!saved) return { version: 1, revision: 0, base: [], records: [] };
    if (saved.version !== 1 || !Number.isSafeInteger(saved.revision) || saved.revision < 0) throw new CloudError('기기에 보관된 동기화 정보를 읽을 수 없습니다.');
    return { version: 1, revision: saved.revision, base: normalize(saved.base), records: normalize(saved.records) };
  }
  function persist(next = state, vaultCode = code) {
    save(VAULT_PREFIX + vaultCode, next);
    if (vaultCode === code) state = next;
  }
  function apply(records, force = false) {
    if (stored(ACTIVE_KEY)?.code !== code) throw new CloudError('다른 창에서 보관함을 바꿨습니다. 새로고침 후 기록해주세요.');
    const next = active(records);
    if (!force && equal(next, visible)) return;
    if (hooks.onRemote?.(clone(next)) === false) throw new CloudError('복구한 기록을 이 기기에 저장하지 못했습니다.');
    visible = next;
  }
  function makeCode() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
    return 'cn1_' + btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function getConfig() {
    const settings = window.CURSE_CONFIG || {};
    if (!settings.supabaseUrl || !settings.publishableKey) return null;
    let url;
    try { url = new URL(settings.supabaseUrl); } catch { throw new CloudError('클라우드 주소 설정을 확인해주세요.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new CloudError('클라우드 주소는 HTTPS 주소여야 합니다.');
    if (typeof settings.publishableKey !== 'string' || settings.publishableKey.startsWith('sb_secret_')) throw new CloudError('브라우저에는 공개용 클라우드 키만 사용할 수 있습니다.');
    if (settings.publishableKey.startsWith('eyJ')) {
      try {
        const payload = JSON.parse(atob(settings.publishableKey.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        if (payload.role !== 'anon') throw new Error('not anon');
      } catch { throw new CloudError('브라우저에는 공개용 클라우드 키만 사용할 수 있습니다.'); }
    }
    return { url: url.origin + url.pathname.replace(/\/$/, ''), key: settings.publishableKey };
  }
  async function rpc(method, body, signal) {
    let response, timedOut = false;
    const requestController = new AbortController();
    const abort = () => requestController.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timeout = setTimeout(() => { timedOut = true; requestController.abort(); }, 15000);
    try {
      response = await fetch(config.url + '/rest/v1/rpc/' + method, {
        method: 'POST', headers: { apikey: config.key, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: requestController.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer'
      });
    } catch (error) {
      if (error.name === 'AbortError' && !timedOut) throw error;
      throw new CloudError('연결이 돌아오면 이 기기의 기록을 다시 동기화합니다.', 'offline');
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
    if (!response.ok) throw new CloudError(response.status === 429 || response.status >= 500 ? '클라우드 연결이 지연되고 있습니다. 기록은 이 기기에 보관됩니다.' : '클라우드 연결 설정이나 보관 한도를 확인해주세요.', response.status === 429 || response.status >= 500 ? 'offline' : 'error');
    let data;
    try { data = await response.json(); } catch { throw new CloudError('클라우드 응답을 읽을 수 없습니다.'); }
    if (!data || !['ok', 'missing', 'conflict'].includes(data.status) || !Number.isSafeInteger(data.revision) || data.revision < 0) throw new CloudError('클라우드 응답 형식이 올바르지 않습니다.');
    data.records = normalize(data.records);
    checkSize(data.records);
    return data;
  }
  function isCurrent(token, vaultCode) {
    if (token !== generation || vaultCode !== code) return false;
    try { return stored(ACTIVE_KEY)?.code === vaultCode; } catch { return false; }
  }
  function reconcileStored() {
    const other = loadVault(code);
    if (equal(state, other)) return;
    const records = merge(state.base, state.records, other.records);
    const recent = other.revision > state.revision ? other : state;
    persist({ version: 1, revision: recent.revision, base: recent.base, records });
  }
  function ingest(entries, allowDelete) {
    const nextEntries = normalize(entries), previous = recordMap(visible), records = recordMap(state.records);
    for (const item of nextEntries) {
      const old = previous.get(item.id);
      if (!sameContent(item, old)) {
        item.updatedAt = new Date(Math.max(Date.now(), timestamp(item), timestamp(records.get(item.id)) + 1)).toISOString();
        records.set(item.id, item);
      }
    }
    if (allowDelete) for (const old of visible) if (!nextEntries.some(entry => entry.id === old.id)) records.set(old.id, { id: old.id, deleted: true, updatedAt: new Date(Math.max(Date.now(), timestamp(old) + 1)).toISOString() });
    const local = sortRecords([...records.values()]);
    const other = loadVault(code);
    persist({ version: 1, revision: Math.max(state.revision, other.revision), base: other.revision > state.revision ? other.base : state.base, records: merge(state.records, local, other.records) });
    visible = active(nextEntries);
  }
  function schedule() {
    clearTimeout(timer);
    if (config && !restoring) timer = setTimeout(() => { void syncNow(); }, 350);
  }
  async function syncLoop(token, vaultCode) {
    emit('syncing', '클라우드에 기록을 동기화하는 중입니다.');
    controller = new AbortController();
    const signal = controller.signal;
    try {
      // A main-app save can succeed while its subsequent queue save runs out of space.
      // Re-ingest that durable app snapshot before any later pull can replace it.
      ingest(hooks.getEntries?.() || visible, true);
      reconcileStored();
      const remote = await rpc('curse_note_read', { p_code: vaultCode }, signal);
      if (!isCurrent(token, vaultCode)) return false;
      if (remote.status === 'conflict') throw new CloudError('클라우드 읽기 응답을 확인해주세요.');
      let next = { version: 1, revision: remote.revision, base: remote.records, records: merge(state.base, state.records, remote.records) };
      persist(next); apply(next.records);
      let exists = remote.status === 'ok';
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        if (!isCurrent(token, vaultCode)) return false;
        reconcileStored();
        if (exists && equal(state.records, state.base)) {
          apply(state.records);
          emit('synced', '클라우드에 보관되었습니다.'); return true;
        }
        checkSize(state.records);
        const sent = clone(state.records), revision = state.revision;
        const result = await rpc('curse_note_write', { p_code: vaultCode, p_revision: revision, p_records: sent }, signal);
        if (!isCurrent(token, vaultCode)) return false;
        if (result.status === 'missing') throw new CloudError('클라우드 저장 응답을 확인해주세요.');
        exists = true;
        const base = result.status === 'ok' ? sent : state.base;
        next = { version: 1, revision: result.revision, base: result.records, records: merge(base, state.records, result.records) };
        persist(next); apply(next.records);
      }
      if (equal(state.records, state.base)) { emit('synced', '클라우드에 보관되었습니다.'); return true; }
      throw new CloudError('다른 기기의 변경이 계속되고 있습니다. 기록을 보관하고 잠시 뒤 다시 시도합니다.', 'offline');
    } catch (error) {
      if (isCurrent(token, vaultCode) && error.name !== 'AbortError') emit(error.kind || 'error', error.message || '동기화를 완료하지 못했습니다. 기록은 이 기기에 남아 있습니다.');
      return false;
    } finally { if (isCurrent(token, vaultCode)) controller = null; }
  }
  function syncNow() {
    clearTimeout(timer);
    if (!config || !code || !state) { if (!config) emit('local', '기록은 이 브라우저에 보관됩니다.'); return Promise.resolve(false); }
    try {
      if (stored(ACTIVE_KEY)?.code !== code) throw new CloudError('다른 창에서 보관함을 바꿨습니다. 새로고침 후 기록해주세요.');
    } catch (error) { emit('error', error.message); return Promise.resolve(false); }
    if (restoring) return Promise.resolve(false);
    if (running) return running;
    const token = generation, vaultCode = code;
    const task = syncLoop(token, vaultCode);
    running = task;
    void task.finally(() => { if (running === task) running = null; });
    return task;
  }
  function notify(entries) {
    if (!config || !state) return false;
    try {
      const pointer = stored(ACTIVE_KEY);
      if (pointer?.code !== code) throw new CloudError('다른 창에서 보관함을 바꿨습니다. 새로고침 후 기록해주세요.');
      ingest(entries, true);
      emit('syncing', '이 기기에 저장했습니다. 클라우드 동기화를 기다립니다.');
      schedule(); return true;
    } catch (error) { emit('error', error.message); return false; }
  }
  async function restore(rawCode) {
    if (!config || !state) throw new CloudError('클라우드가 연결되지 않았습니다.');
    const targetCode = String(rawCode || '').trim();
    if (!CODE.test(targetCode)) throw new CloudError('복구 코드 전체를 정확히 입력해주세요.');
    const ticket = ++restoreTicket;
    restoring = true;
    clearTimeout(timer);
    emit('syncing', '복구 코드의 기록을 확인하는 중입니다.');
    try {
      const remote = await rpc('curse_note_read', { p_code: targetCode });
      if (ticket !== restoreTicket) return false;
      // An earlier offline-only vault may never have reached the server. Its exact
      // capability can still recover the validated local queue on this browser.
      const cachedTarget = stored(VAULT_PREFIX + targetCode);
      if (remote.status !== 'ok' && !(remote.status === 'missing' && cachedTarget)) throw new CloudError('이 복구 코드로 보관된 노트를 찾을 수 없습니다.');
      // Back up the current vault before changing the pointer or the visible notebook.
      ingest(hooks.getEntries?.() || visible, true);
      const target = targetCode === code ? state : loadVault(targetCode);
      const next = { version: 1, revision: remote.revision, base: remote.records, records: merge(target.base, target.records, remote.records) };
      persist(next, targetCode);
      save(ACTIVE_KEY, { code: targetCode, pendingApply: true });
      generation++; controller?.abort(); controller = null; running = null;
      code = targetCode; state = next;
      apply(next.records, true);
      save(ACTIVE_KEY, { code, pendingApply: false });
      const synced = remote.status === 'ok' && equal(next.records, next.base);
      emit(synced ? 'synced' : 'syncing', synced ? '복구한 노트가 클라우드에 보관되어 있습니다.' : '이전에 보관한 변경 사항을 동기화합니다.');
      return true;
    } catch (error) {
      if (ticket === restoreTicket) emit(error.kind || 'error', error.message);
      throw error;
    } finally {
      if (ticket === restoreTicket) { restoring = false; schedule(); }
    }
  }
  async function start(options) {
    hooks = options || {};
    if (started) return syncNow();
    started = true;
    try {
      config = getConfig();
      if (!config) { emit('local', '기록은 이 브라우저에 보관됩니다.'); return false; }
      const pointer = stored(ACTIVE_KEY);
      if (pointer && !CODE.test(pointer.code || '')) throw new CloudError('기기에 보관된 복구 코드를 읽을 수 없습니다.');
      code = pointer?.code || makeCode();
      state = loadVault(code);
      const entries = normalize(hooks.getEntries?.() || []);
      visible = active(entries);
      if (!pointer?.pendingApply) {
        // Initial migration is additive: a fresh or empty cloud must not erase old local notes.
        persist({ ...state, records: merge(state.base, state.records, entries) });
      }
      save(ACTIVE_KEY, { code, pendingApply: true });
      apply(state.records, true);
      save(ACTIVE_KEY, { code, pendingApply: false });
      const wake = () => { if (!document.hidden) void syncNow(); };
      window.addEventListener('online', wake);
      window.addEventListener('focus', wake);
      window.addEventListener('pageshow', wake);
      document.addEventListener('visibilitychange', wake);
      setInterval(wake, 30000);
      return await syncNow();
    } catch (error) { emit('error', error.message || '클라우드를 시작하지 못했습니다.'); return false; }
  }
  window.CurseCloud = Object.freeze({ start, notify, getRecoveryCode: () => config && state ? code : null, restore, syncNow });
})();
