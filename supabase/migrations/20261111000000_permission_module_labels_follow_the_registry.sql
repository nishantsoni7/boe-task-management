-- Permission module labels follow the registry.
--
-- WHAT THIS FIXES
-- ---------------
-- `npm run permissions:check` has been failing on clean `main` with two
-- issues, both of the same shape:
--
--   module "customer_review_requests" display_name/description differs from the registry
--   module "orders" display_name/description differs from the registry
--
-- src/lib/permissions/modules.ts is the declared source of truth for what
-- modules exist and what they are called (see the header of
-- scripts/sync-permissions.ts). Two merged changes edited that registry and
-- never wrote the migration that carries the new text to the database:
--
--   orders                     3c289f0 "Retire Order Requests" (#50) rewrote the
--                              description because the Order Request workflow
--                              it named no longer exists — an order no longer
--                              arrives "from request", it arrives as a PI
--                              draft.
--   customer_review_requests   674c594 "natural review drafts" (#76) renamed the
--                              module from "Review Workflow Test (Internal)" to
--                              "Review Workflow", because the module stopped
--                              describing itself to its users as a rehearsal.
--                              Two tests pin that value in modules.ts
--                              (src/lib/customerReviews/migration.test.ts and
--                              src/lib/customerReviews/internalTest.test.ts).
--
-- So the registry is right in both cases and the database rows are stale. This
-- migration moves the database to the registry rather than the other way
-- round.
--
-- WHY A MIGRATION AND NOT `npm run permissions:sync`
-- --------------------------------------------------
-- sync upserts EVERY registered module and action in one pass. Three modules
-- register the same `view_all` action key with three different display names
-- (Members, Finance, Orders) and permission_actions.display_name is global per
-- key, so a sync run silently rewrites that label to whichever module happens
-- to register last. A migration naming the two rows it changes cannot do that.
--
-- WHAT THIS CANNOT BREAK
-- ----------------------
-- display_name and description on permission_modules are inert: nothing in the
-- application and nothing in SQL reads either column. The permission engine
-- resolves on `module_key`, the one API route that touches this table selects
-- `id, module_key`, and the Access Control screen carries its own labels. No
-- key, no grant, no policy and no resolver is touched — this migration edits
-- display text and nothing else.
--
-- Idempotent: re-running rewrites the same two rows with the same values. A
-- row that does not exist is a no-op, not an error.
--
-- ROLLBACK
-- --------
--   update public.permission_modules
--      set description = 'Track confirmed orders from request through production and dispatch.'
--    where module_key = 'orders';
--   update public.permission_modules
--      set display_name = 'Review Workflow Test (Internal)',
--          description  = 'Internal test workflow. The tester chooses the WhatsApp recipient. Nothing is posted publicly, and BOE does not send the message automatically.'
--    where module_key = 'customer_review_requests';

-- Order Management: same display name, description no longer names the retired
-- Order Request step.
update public.permission_modules
   set display_name = 'Order Management',
       description  = 'PI Drafts, confirmed orders, production and dispatch.'
 where module_key = 'orders';

-- Review Workflow: the key stays exactly as it is — it is what every existing
-- Control Center grant is written against — and only the human-readable text
-- moves.
update public.permission_modules
   set display_name = 'Review Workflow',
       description  = 'Draft reviews for customers to use. The candidate chooses the WhatsApp recipient. Nothing is posted publicly, and BOE does not send the message automatically.'
 where module_key = 'customer_review_requests';
