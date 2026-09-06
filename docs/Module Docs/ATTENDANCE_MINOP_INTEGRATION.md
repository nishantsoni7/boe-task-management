# Attendance — Minop Live Integration

Last Updated: 6 September 2026

## Purpose

Add Minop biometric punches as a live input to BOE's existing Attendance system without redesigning Attendance or Payroll.

Current production Attendance already owns employee mapping, daily attendance rows, employee self-service, corrections and Payroll consumption. Minop is therefore an external input adapter, not a second attendance system.

## Stage 1 — Raw authenticated ingestion

Status: **implemented on `feature/minop-raw-ingestion-v2`, not merged/deployed yet**.

Stage 1 adds only the transport/audit boundary:

- `POST /api/integrations/minop/webhook`
- `public.minop_webhook_deliveries`
- `src/lib/minop/webhook.ts`
- `src/lib/minop/webhook.test.ts`

### Authentication

The route fails closed unless server environment variable `MINOP_WEBHOOK_SECRET` exists.

It can validate the configured secret from any of:

1. `Authorization: Bearer <secret>`;
2. `x-minop-webhook-secret: <secret>`; or
3. the payload's own `AuthToken` — either top-level or, as Minop's published real-time callback shape carries it, `RealTime.AuthToken`.

Which mechanism the physical Minop service will use is **not yet confirmed**. Header-based auth is BOE's receiving contract for testing; the payload `AuthToken` path matches Minop's published real-time callback documentation and is the most likely real-device mechanism until one genuine delivery proves what the vendor actually sends.

The secret itself is never stored.

### What is stored

Every authenticated HTTP delivery is retained with:

- exact raw request body;
- parsed JSON copy when valid;
- SHA-256 of the exact raw body;
- received timestamp;
- content type;
- user agent;
- authentication method;
- processing status;
- safe quarantine reason for invalid JSON.

Raw payloads are inaccessible to `anon` and `authenticated`. The table has RLS enabled with no browser policy and is written only by the service-role webhook route.

### Invalid payloads

Authenticated malformed JSON is preserved rather than discarded. It receives status:

`quarantined_invalid_json`

This is intentional. The raw layer exists so BOE can prove what the device/service sent even when the payload cannot yet be interpreted.

### Duplicate/retry rule

`body_sha256` is indexed for audit/search, but it is deliberately **not unique**.

BOE does not yet have a confirmed Minop event/delivery identifier. Treating a request-body hash as an idempotency key could discard a legitimate second punch whose payload happens to serialize identically.

Semantic duplicate prevention will be added only after a genuine Minop payload or vendor contract identifies the correct event key.

## Hard Stage-1 boundary

Stage 1 does **not**:

- read or write `attendance_records`;
- map `fingerprint_employee_code`;
- infer punch direction;
- parse a vendor timestamp;
- change My Attendance;
- touch Payroll;
- process locked payroll months;
- provision users or biometrics to a Minop device.

The endpoint acknowledging with HTTP `200` and body `{"status":"1"}` — Minop's documented success shape — means only that BOE accepted and stored the transport delivery. It does not mean attendance changed.

## Required environment configuration

Before any deployed endpoint can receive Minop traffic, configure:

`MINOP_WEBHOOK_SECRET=<long random shared secret>`

`NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` remain the existing server configuration used by BOE.

Do not place the Minop secret in any `NEXT_PUBLIC_*` variable.

## Input still required from Minop

Before Stage 2, obtain at least one genuine Minop webhook request or official webhook/API documentation proving:

- employee/device user identifier;
- event identifier or delivery identifier;
- punch timestamp and timezone semantics;
- IN/OUT direction, if the vendor sends one;
- device identifier, if applicable;
- webhook authentication capabilities;
- retry behaviour.

No application code should guess these fields.

## Stage 2 — Live punch processor

After the vendor payload is proven:

1. normalize a raw Minop event without losing the original delivery;
2. deduplicate using the real vendor event key;
3. map the proven employee identifier to `users.fingerprint_employee_code` where compatible;
4. calculate the BOE attendance date in IST;
5. merge the event into the existing one-row-per-user/date `attendance_records` model;
6. reuse existing punch-direction behaviour;
7. enforce payroll lock;
8. record mapping/processing failures without deleting raw data;
9. verify out-of-order and retry behaviour;
10. keep Payroll unchanged.

## Verification gate for Stage 1

Before merge:

- TypeScript: 0 errors
- ESLint: 0 errors/warnings
- full test suite: 0 failures/skips
- build: green
- `git diff --check`: clean
- migration ledger tests updated if the repository's pinned migration lists require it
- confirm diff contains no `attendance_records` or Payroll write from Minop route

No Supabase production migration and no Vercel production configuration should be changed until this gate passes.
