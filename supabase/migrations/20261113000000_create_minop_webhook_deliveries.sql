-- Stage 1 of the Minop biometric integration.
--
-- Raw transport/audit boundary only. It preserves what Minop sent BOE and the
-- service-tag query parameter, but it does NOT map an employee, interpret a
-- punch, or write public.attendance_records/payroll.

CREATE TABLE public.minop_webhook_deliveries (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  received_at       timestamptz NOT NULL DEFAULT now(),
  service_tag_id    text,
  content_type      text,
  user_agent        text,
  raw_body          text        NOT NULL,
  payload           jsonb,
  body_sha256       text        NOT NULL,
  auth_method       text        NOT NULL
                                CHECK (auth_method IN ('bearer', 'x-minop-webhook-secret', 'payload-auth-token')),
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

-- A payload hash is an audit/search aid, not an idempotency key. Minop's
-- published OperationID is retained inside payload but is not made unique here:
-- Stage 1 has not yet proved its uniqueness semantics on BOE's actual device.
CREATE INDEX minop_webhook_deliveries_sha256_idx
  ON public.minop_webhook_deliveries (body_sha256);

CREATE INDEX minop_webhook_deliveries_received_at_idx
  ON public.minop_webhook_deliveries (received_at DESC);

CREATE INDEX minop_webhook_deliveries_service_tag_idx
  ON public.minop_webhook_deliveries (service_tag_id)
  WHERE service_tag_id IS NOT NULL;

-- External callers never receive a Supabase credential. The Next.js webhook
-- route writes with the service-role client after validating Minop's AuthToken
-- (or BOE's header-authenticated simulator path). No browser/session role may
-- read or write raw device payloads.
ALTER TABLE public.minop_webhook_deliveries ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.minop_webhook_deliveries FROM anon, authenticated;
GRANT ALL ON public.minop_webhook_deliveries TO service_role;

COMMENT ON TABLE public.minop_webhook_deliveries IS
  'Raw authenticated Minop webhook deliveries. Stage-1 audit/quarantine only; never final attendance.';
COMMENT ON COLUMN public.minop_webhook_deliveries.service_tag_id IS
  'Minop stgid query parameter when supplied by the callback.';
COMMENT ON COLUMN public.minop_webhook_deliveries.raw_body IS
  'Exact HTTP request body as received before JSON parsing.';
COMMENT ON COLUMN public.minop_webhook_deliveries.body_sha256 IS
  'SHA-256 of raw_body for audit/search only. Not a semantic event id and not unique.';
