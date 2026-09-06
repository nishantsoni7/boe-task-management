-- Stage 1 of the Minop biometric integration.
--
-- This table is deliberately a transport/audit boundary only. It preserves
-- exactly what the external device service sent BOE, but it does NOT map an
-- employee, infer IN/OUT, or write public.attendance_records. Those decisions
-- require a real Minop payload contract and belong to the later processor.

CREATE TABLE public.minop_webhook_deliveries (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  received_at       timestamptz NOT NULL DEFAULT now(),
  content_type      text,
  user_agent        text,
  raw_body          text        NOT NULL,
  payload           jsonb,
  body_sha256       text        NOT NULL,
  auth_method       text        NOT NULL
                                CHECK (auth_method IN ('bearer', 'x-minop-webhook-secret')),
  processing_status text        NOT NULL
                                CHECK (processing_status IN ('received', 'quarantined_invalid_json')),
  error_text        text,

  CONSTRAINT minop_webhook_deliveries_sha256_format
    CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT minop_webhook_deliveries_payload_state
    CHECK (
      (processing_status = 'received' AND payload IS NOT NULL AND error_text IS NULL)
      OR
      (processing_status = 'quarantined_invalid_json' AND payload IS NULL AND error_text IS NOT NULL)
    )
);

-- A payload hash is an audit/search aid, not an idempotency key. Until Minop's
-- real event/delivery identifier is known, identical bodies must NOT be made
-- unique because two legitimate punches may serialize identically.
CREATE INDEX minop_webhook_deliveries_sha256_idx
  ON public.minop_webhook_deliveries (body_sha256);

CREATE INDEX minop_webhook_deliveries_received_at_idx
  ON public.minop_webhook_deliveries (received_at DESC);

-- External callers never receive a Supabase credential. The Next.js webhook
-- route writes with the service-role client after validating BOE's shared
-- secret. No browser/session role may read or write raw device payloads.
ALTER TABLE public.minop_webhook_deliveries ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.minop_webhook_deliveries FROM anon, authenticated;
GRANT ALL ON public.minop_webhook_deliveries TO service_role;

COMMENT ON TABLE public.minop_webhook_deliveries IS
  'Raw authenticated Minop webhook deliveries. Stage-1 audit/quarantine only; never final attendance.';
COMMENT ON COLUMN public.minop_webhook_deliveries.raw_body IS
  'Exact HTTP request body as received before JSON parsing.';
COMMENT ON COLUMN public.minop_webhook_deliveries.body_sha256 IS
  'SHA-256 of raw_body for audit/search only. Not a semantic event id and not unique.';
