# CURSE NOTE database

This migration adds a login-free recovery-code vault to an existing Supabase project. It creates only `curse_note_private` objects and the two `public.curse_note_*` RPCs. It does not configure Supabase Auth, enable extensions, change project-wide defaults, or touch another application's data.

## Apply to the chosen project

1. Confirm the intended Supabase project before running SQL.
2. Open that project's SQL Editor as the database owner (`postgres`) and run the complete [migration](migrations/20261012000000_curse_note_vault.sql). It runs in one transaction and can be reapplied without deleting saved vaults.
3. Keep `curse_note_private` outside the API's exposed schemas. The `public` schema needs to be exposed for the two RPCs; this is Supabase's normal configuration.
4. Configure the website with the project's HTTPS URL and browser-safe publishable key (or legacy `anon` key). Never put a secret key, `service_role` key, database password, or connection string in the website or repository.
5. On the deployed website, create a disposable record, copy its recovery code, and recover it in a separate browser profile. Check that an unrelated generated code finds no records. Local tests below do not replace this project-specific HTTPS check.

No account or anonymous Auth session is required. Requests use the `anon` role. The RPCs also allow the `authenticated` role, but neither role can access vault tables or helper functions directly.

## RPC contract

Call with a JSON POST body to `<SUPABASE_URL>/rest/v1/rpc/<function>`, using the project's public API key in the `apikey` header and `Content-Type: application/json`. The browser client handles the legacy anon JWT header when applicable.

| Function | JSON parameters | Result |
| --- | --- | --- |
| `curse_note_read` | `{"p_code":"cn1_..."}` | `{"status":"ok","revision":1,"records":[...]}` or `{"status":"missing","revision":0,"records":[]}` |
| `curse_note_write` | `{"p_code":"cn1_...","p_revision":1,"p_records":[...]}` | `{"status":"ok","revision":2,"records":[...]}` or `{"status":"conflict","revision":2,"records":[...]}` |

A recovery code is exactly `cn1_` followed by 43 base64url characters (`A–Z`, `a–z`, `0–9`, `_`, `-`). Generate it in the browser from 32 bytes supplied by `crypto.getRandomValues`; omit base64 padding. Do not accept a short, human-chosen password in place of this random code.

Use revision `0` only for a new vault. Its first successful write returns revision `1`. Every successful replacement increments the revision by one. A stale revision does not change the vault and returns its current snapshot for the same code. A write to a missing vault with a nonzero revision returns a conflict at revision `0` with an empty array. Re-read, merge by record ID (including deletion tombstones), and retry using the returned revision. Do not silently retry by discarding the current snapshot.

Malformed codes, revisions, or record data raise SQLSTATE `22023`. Revisions must be integers from `0` through `9007199254740990` when writing. Responses are JSON objects, not result arrays.

## Record format and limits

Each vault contains at most **500 records, including tombstones**. The UTF-8 length of PostgreSQL's `jsonb` text representation must be at most **1,048,576 bytes**. This includes JSON syntax and PostgreSQL's formatting spaces, so allow some headroom when checking size in the browser.

An ordinary record has only these keys:

```json
{
  "id": "b1517a02-7a48-4051-98db-581f225d879c",
  "name": "Example",
  "body": "A note",
  "date": "2026-10-12",
  "createdAt": "2026-10-12T03:00:00.000Z",
  "updatedAt": "2026-10-12T03:00:00.000Z",
  "curse": { "status": "pending", "startedAt": 1791774000000, "deadline": 1791774040000 }
}
```

- `id`: unique within the array, lowercase UUID string.
- `name`: 1–60 Unicode characters; `body`: 0–20,000 Unicode characters.
- `date`: a real calendar date in `YYYY-MM-DD` format.
- `createdAt` and `updatedAt`: valid UTC timestamps exactly matching the 24-character `Date.toISOString()` format above (four-digit years).
- `curse`: omitted, `null`, or an object containing `status`, `startedAt`, `deadline`, and optionally `revokedAt`. Status is `pending`, `fulfilled`, or `revoked`. Times are integer Unix milliseconds between `0` and `253402300799999`; deadline cannot precede startedAt.
- A deleted record contains only `id`, `deleted: true`, and `updatedAt`. Preserve these tombstones during device merges so an older device cannot recreate deleted content.
- Unknown fields are rejected. The server stores the validated array as supplied; ritual times are application metadata, not a trusted scheduler.

## Access model

Possession of the recovery code authorizes reading and replacing that one vault. There is no listing endpoint and no code recovery endpoint. An unrelated code cannot reveal another vault's contents. Keep recovery codes out of URLs, analytics, screenshots, and application logs.

The database stores only `SHA-256(UTF8(code))` as the vault key. It does not persist the plaintext code in application tables. The code is still sent over HTTPS to the RPC. Note contents are ordinary database JSON, **not end-to-end encrypted**; authorized database administrators can read them. Losing both the saved browser code and the copied recovery code loses access.

RLS is enabled with no allow policies. Explicit grants deny `PUBLIC`, `anon`, `authenticated`, and `service_role` access to the private schema, table, and helpers. The two narrowly scoped `SECURITY DEFINER` RPCs use a fixed empty search path, fully qualified object names, strict input validation, and an atomic revision predicate. Do not replace these checks with table-wide anonymous access. There are per-vault size limits; deployment-level rate limiting and storage quotas remain the project's operational responsibility.

## Local verification

From the repository root:

```sh
npm --prefix supabase ci --ignore-scripts
npm --prefix supabase test
```

The pinned PGlite dependency runs PostgreSQL in an isolated in-memory database. No hosted database, credentials, Docker, or global installation is used. The suite checks migration repeatability, preservation of unrelated objects, ACL/RLS denial, private helper access, recovery-code isolation, hashed storage, revision conflicts, input limits, tombstones, and search-path shadowing. It simulates two writers using the same expected revision sequentially; PGlite is a single-connection runtime, so it does not exercise multi-connection lock contention or Supabase's HTTP gateway.

The implementation follows [Supabase's database function security guidance](https://supabase.com/docs/guides/database/functions) and [RLS guidance](https://supabase.com/docs/guides/database/postgres/row-level-security). Hashing uses PostgreSQL's built-in [SHA-256 function](https://www.postgresql.org/docs/16/functions-binarystring.html), requiring no `pgcrypto` extension. The test runtime is documented by [PGlite](https://pglite.dev/docs/).
