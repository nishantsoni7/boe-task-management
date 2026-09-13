-- Minop raw capture authenticated by a secret URL path segment.
--
-- The Minop Developer Dashboard accepts only a callback URL. It cannot send an
-- Authorization header, a custom header, or an AuthToken inside the body, so
-- POST /api/integrations/minop/webhook/[token] authenticates the secret carried
-- in the URL path and records it as a fourth auth_method, 'url-path-token'.
--
-- One CHECK constraint widened by one value. No table, column, index, policy,
-- grant or function is added or changed, and no existing row can violate the
-- wider constraint, so the currently deployed code is unaffected.
--
-- APPLY BEFORE DEPLOYING THE ROUTE. Without it, every valid-token delivery
-- fails this CHECK (23514) and Minop receives a 500.
--
-- The DROP deliberately has no IF EXISTS: the constraint name was confirmed in
-- production, and a missing constraint must abort this migration rather than
-- leave an unknown CHECK still refusing the new value.

ALTER TABLE public.minop_webhook_deliveries
  DROP CONSTRAINT minop_webhook_deliveries_auth_method_check;

ALTER TABLE public.minop_webhook_deliveries
  ADD CONSTRAINT minop_webhook_deliveries_auth_method_check
  CHECK (auth_method IN ('bearer', 'x-minop-webhook-secret', 'payload-auth-token', 'url-path-token'));
