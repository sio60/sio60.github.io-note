import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = await readFile(new URL('../migrations/20261012000000_curse_note_vault.sql', import.meta.url), 'utf8');
const codeA = `cn1_${'A'.repeat(43)}`;
const codeB = `cn1_${'B'.repeat(43)}`;
const codeMissing = `cn1_${'C'.repeat(43)}`;
const now = '2026-10-12T03:00:00.000Z';
const record = {
  id: 'b1517a02-7a48-4051-98db-581f225d879c', name: '테스트 이름', body: 'Test only', date: '2026-10-12',
  createdAt: now, updatedAt: now, curse: {status: 'pending', startedAt: 1791774000000, deadline: 1791774040000},
};
const copy = (changes = {}) => ({...structuredClone(record), ...changes});

test('CURSE NOTE migration and capability security on PostgreSQL (PGlite)', async (t) => {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role; create role outsider;
    grant usage on schema public to public;
    create table public.unrelated_app (value text);
    insert into public.unrelated_app values ('keep me');
    grant select on public.unrelated_app to anon;
    create function public.unrelated_rpc() returns text language sql as $$ select 'keep me'::text $$;
    grant execute on function public.unrelated_rpc() to anon;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  `);
  await db.exec(migration);

  async function asRole(role, fn) {
    assert.ok(['anon', 'authenticated', 'service_role', 'outsider'].includes(role));
    await db.exec(`set role ${role}`);
    try { return await fn(); } finally { await db.exec('reset role; reset search_path'); }
  }
  async function read(code = codeA) {
    const {rows} = await db.query('select public.curse_note_read($1) as result', [code]);
    return rows[0].result;
  }
  async function write(code, revision, records) {
    const {rows} = await db.query('select public.curse_note_write($1, $2, $3::jsonb) as result', [code, revision, JSON.stringify(records)]);
    return rows[0].result;
  }
  async function denied(sql, params = []) {
    await assert.rejects(() => db.query(sql, params), e => e.code === '42501');
  }
  async function invalid(records, revision = 1, code = codeA) {
    await assert.rejects(() => write(code, revision, records), e => e.code === '22023');
  }

  try {
    await t.test('RPC grants are explicit, helpers private, RLS enabled, and paths fixed', async () => {
      const {rows} = await db.query(`
        select n.nspname as schema, p.proname as name, p.prosecdef as definer, p.proconfig as config,
               pg_catalog.has_function_privilege('anon',p.oid,'execute') as anon,
               pg_catalog.has_function_privilege('authenticated',p.oid,'execute') as authenticated,
               pg_catalog.has_function_privilege('outsider',p.oid,'execute') as outsider,
               pg_catalog.has_function_privilege('service_role',p.oid,'execute') as service_role
        from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on p.pronamespace = n.oid
        where n.nspname = 'curse_note_private' or p.proname in ('curse_note_read','curse_note_write')
      `);
      assert.equal(rows.length, 5);
      for (const row of rows) {
        const rpc = row.schema === 'public';
        assert.equal(row.definer, rpc);
        assert.deepEqual(row.config, ['search_path=""']);
        assert.equal(row.anon, rpc); assert.equal(row.authenticated, rpc);
        assert.equal(row.outsider, false); assert.equal(row.service_role, false);
      }
      const metadata = await db.query(`select relrowsecurity from pg_catalog.pg_class where oid = 'curse_note_private.vaults'::regclass`);
      assert.equal(metadata.rows[0].relrowsecurity, true);
    });

    await t.test('anon and authenticated cannot read/write tables or execute helpers directly', async () => {
      for (const role of ['anon', 'authenticated']) await asRole(role, async () => {
        for (const sql of [
          'select * from curse_note_private.vaults',
          "insert into curse_note_private.vaults(code_hash) values (pg_catalog.sha256('x'::bytea))",
          "update curse_note_private.vaults set records = '[]'::jsonb",
          'delete from curse_note_private.vaults',
          'truncate curse_note_private.vaults',
          "select curse_note_private.hash_code('x')",
          "select curse_note_private.valid_records('[]'::jsonb)",
          "select curse_note_private.valid_timestamp('2026-10-12T03:00:00.000Z')",
        ]) await denied(sql);
      });
      await asRole('outsider', () => denied('select public.curse_note_read($1)', [codeA]));
    });

    await t.test('unknown codes return only an empty missing result', async () => {
      assert.deepEqual(await asRole('anon', () => read(codeMissing)), {status: 'missing', revision: 0, records: []});
      assert.deepEqual(await asRole('anon', () => write(codeMissing, 8, [])), {status: 'conflict', revision: 0, records: []});
      assert.deepEqual(await asRole('anon', () => read(codeMissing)), {status: 'missing', revision: 0, records: []});
    });

    await t.test('each recovery code accesses exactly one independent vault', async () => {
      assert.deepEqual(await asRole('anon', () => write(codeA, 0, [record])), {status: 'ok', revision: 1, records: [record]});
      const other = copy({body: 'Separate vault'});
      assert.deepEqual(await asRole('authenticated', () => write(codeB, 0, [other])), {status: 'ok', revision: 1, records: [other]});
      assert.deepEqual(await asRole('authenticated', () => read(codeA)), {status: 'ok', revision: 1, records: [record]});
      assert.deepEqual(await asRole('anon', () => read(codeB)), {status: 'ok', revision: 1, records: [other]});
      assert.deepEqual(await asRole('anon', () => read(codeMissing)), {status: 'missing', revision: 0, records: []});
    });

    await t.test('stale creation and updates cannot overwrite the current snapshot', async () => {
      assert.deepEqual(await asRole('anon', () => write(codeA, 0, [])), {status: 'conflict', revision: 1, records: [record]});
      const updated = copy({body: 'First writer wins'});
      assert.deepEqual(await asRole('anon', () => write(codeA, 1, [updated])), {status: 'ok', revision: 2, records: [updated]});
      assert.deepEqual(await asRole('authenticated', () => write(codeA, 1, [])), {status: 'conflict', revision: 2, records: [updated]});
      assert.deepEqual(await asRole('anon', () => write(codeA, 99, [])), {status: 'conflict', revision: 2, records: [updated]});
      assert.deepEqual((await asRole('anon', () => read(codeA))).records, [updated]);
    });

    await t.test('only a SHA-256 code hash is persisted in vault rows', async () => {
      const {rows} = await db.query(`select pg_catalog.encode(code_hash, 'hex') as code_hash, records, revision from curse_note_private.vaults order by code_hash`);
      assert.equal(rows.length, 2);
      assert.ok(rows.some(row => row.code_hash === createHash('sha256').update(codeA).digest('hex')));
      assert.ok(rows.some(row => row.code_hash === createHash('sha256').update(codeB).digest('hex')));
      assert.ok(!JSON.stringify(rows).includes(codeA)); assert.ok(!JSON.stringify(rows).includes(codeB));
      const columns = await db.query("select column_name from information_schema.columns where table_schema = 'curse_note_private' and table_name = 'vaults' order by ordinal_position");
      assert.deepEqual(columns.rows.map(row => row.column_name), ['code_hash','records','revision','created_at','updated_at']);
    });

    await t.test('malformed codes and invalid revisions are rejected without mutating vaults', async () => {
      await asRole('anon', async () => {
        for (const code of [null, '', 'short', `cn1_${'a'.repeat(42)}`, `cn1_${'a'.repeat(44)}`, `cn1_${'a'.repeat(42)}!`, `${codeA}\n`]) {
          await assert.rejects(() => read(code), e => e.code === '22023');
          await invalid([], 1, code);
        }
        for (const revision of [null, -1, 9007199254740991]) await invalid([], revision);
        assert.equal((await read()).revision, 2);
      });
    });

    await t.test('record shape, dates, UUID uniqueness, lengths and ritual metadata are validated', async () => {
      const bad = [null, {}, 'x', [null], [1], [{}], [copy({id:'bad'})], [record, record],
        [copy({name:null})], [copy({name:''})], [copy({name:'a'.repeat(61)})], [copy({body:3})], [copy({body:'a'.repeat(20001)})],
        [copy({date:'2026-02-30'})], [copy({date:'2026-13-01'})], [copy({date:'2026-1-01'})], [copy({date:null})],
        [copy({createdAt:null})], [copy({createdAt:'infinity'})], [copy({updatedAt:'2026-02-30T03:00:00.000Z'})],
        [copy({updatedAt:'2026-10-12T25:00:00.000Z'})], [copy({updatedAt: now+'x'})], [copy({extra:'no'})],
        [copy({deleted:false})], [{id:record.id, deleted:true}], [{id:record.id, deleted:true, updatedAt:now, body:'no'}],
        [copy({curse:[]})], [copy({curse:{status:'other', startedAt:0, deadline:1}})],
        [copy({curse:{status:'pending', deadline:1}})], [copy({curse:{status:'pending', startedAt:null, deadline:1}})],
        [copy({curse:{status:'pending', startedAt:'0', deadline:1}})], [copy({curse:{status:'pending', startedAt:2, deadline:1}})],
        [copy({curse:{status:'pending', startedAt:-1, deadline:1}})], [copy({curse:{status:'pending', startedAt:0.5, deadline:1}})],
        [copy({curse:{status:'pending', startedAt:0, deadline:253402300800000}})],
        [copy({curse:{status:'revoked', startedAt:0, deadline:1, revokedAt:'bad'}})],
        [copy({curse:{status:'pending', startedAt:0, deadline:1, extra:1}})],
      ];
      await asRole('anon', async () => {
        for (const records of bad) await invalid(records, 2);
        assert.equal((await read()).revision, 2);
      });
    });

    await t.test('record count and UTF-8 payload limits are enforced', async () => {
      const records = Array.from({length:501}, (_, i) => copy({id:`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`}));
      await asRole('anon', () => invalid(records, 2));
      const large = records.slice(0, 20).map(row => ({...row, body:'가'.repeat(20000)}));
      assert.ok(Buffer.byteLength(JSON.stringify(large)) > 1048576);
      await asRole('anon', () => invalid(large, 2));
      assert.equal((await read()).revision, 2);
    });

    await t.test('valid boundary fields, optional curse and deletion tombstones round trip', async () => {
      const boundary = copy({name:'가'.repeat(60), body:'가'.repeat(20000), date:'2024-02-29', curse:null});
      assert.equal((await asRole('anon', () => write(codeA, 2, [boundary]))).status, 'ok');
      const tombstone = {id:record.id, deleted:true, updatedAt:now};
      assert.deepEqual(await asRole('anon', () => write(codeA, 3, [tombstone])), {status:'ok',revision:4,records:[tombstone]});
      assert.deepEqual(await asRole('authenticated', () => read(codeA)), {status:'ok',revision:4,records:[tombstone]});
      const noCurse = copy(); delete noCurse.curse;
      const revoked = copy({id:'00000000-0000-4000-8000-000000000002', curse:{status:'revoked',startedAt:0,deadline:40000,revokedAt:1000}});
      const fulfilled = copy({id:'00000000-0000-4000-8000-000000000003', curse:{status:'fulfilled',startedAt:0,deadline:40000}});
      assert.equal((await asRole('anon', () => write(codeA, 4, [noCurse, revoked, fulfilled]))).status, 'ok');
      assert.deepEqual(await asRole('anon', () => write(codeA, 5, [])), {status:'ok',revision:6,records:[]});
    });

    await t.test('caller search_path and a shadow table cannot redirect definer access', async () => {
      await asRole('anon', async () => {
        await db.exec("create temporary table vaults(records jsonb); insert into vaults values ('[\"not yours\"]'); set search_path = pg_temp, public");
        assert.deepEqual(await read(), {status:'ok',revision:6,records:[]});
        assert.equal((await write(codeA, 6, [record])).status, 'ok');
        const {rows} = await db.query('select records from pg_temp.vaults');
        assert.deepEqual(rows[0].records, ['not yours']);
      });
    });

    await t.test('deny-all RLS still protects rows if table permissions are accidentally granted', async () => {
      await db.exec('grant usage on schema curse_note_private to anon, authenticated; grant select, insert, update, delete on curse_note_private.vaults to anon, authenticated');
      for (const role of ['anon', 'authenticated']) await asRole(role, async () => {
        assert.deepEqual((await db.query('select * from curse_note_private.vaults')).rows, []);
        assert.equal((await db.query("update curse_note_private.vaults set records = '[]'::jsonb")).affectedRows, 0);
        assert.equal((await db.query('delete from curse_note_private.vaults')).affectedRows, 0);
        await denied("insert into curse_note_private.vaults(code_hash) values (pg_catalog.sha256('no'::bytea))");
      });
      await db.exec('revoke all on schema curse_note_private from anon, authenticated; revoke all on table curse_note_private.vaults from anon, authenticated');
    });

    await t.test('migration is repeatable and preserves saved vaults and unrelated app objects', async () => {
      const before = await read();
      await db.exec(migration);
      assert.deepEqual(await read(), before);
      await asRole('anon', async () => {
        assert.deepEqual((await db.query('select * from public.unrelated_app')).rows, [{value:'keep me'}]);
        assert.equal((await db.query('select public.unrelated_rpc() as value')).rows[0].value, 'keep me');
        await denied('select * from curse_note_private.vaults');
      });
    });
  } finally { await db.close(); }
});
