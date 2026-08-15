-- Task attachments, step 2 of 2: make the bucket private.
--
-- APPLY THIS LAST, AND ONLY AFTER VERIFYING THE BACKFILL.
--
-- This is the step that actually closes the hole, and it is the only step that
-- can break something. Once `task-attachments` is private, every URL of the form
--   https://<ref>.supabase.co/storage/v1/object/public/task-attachments/<path>
-- stops resolving. Any screen still reaching for a public URL shows a broken
-- image from that instant.
--
-- PRECONDITIONS — all three must hold before applying:
--
--   1. The frontend that signs URLs is DEPLOYED. It reads storage_path and calls
--      createSignedUrl; it never builds a public URL.
--   2. 20260906000000 is APPLIED, and its backfill assertion passed. That
--      migration refuses to complete while any row is unmapped, so a successful
--      apply is the verification.
--   3. This query returns 0:
--
--        SELECT count(*) FROM public.task_attachments
--        WHERE storage_path IS NULL OR storage_path = '';
--
-- The guard below re-checks 2 and 3 and refuses to run otherwise. It cannot
-- check 1 — that is a human confirmation.
--
-- ROLLBACK: set `public` back to true on the bucket row. Objects, paths, rows
-- and policies are all untouched by this migration, so the reversal is complete
-- and immediate.
--
-- SCOPE: one bucket. asset-documents, meeting-product-images,
-- order-request-attachments and payment-proofs are already private and are not
-- referenced here.

-- ── 0. Re-run the backfill ──────────────────────────────────────────────────
--
-- Between 20260906000000 and the frontend deploy, the OLD build is still live
-- and inserts rows carrying a public URL and no storage_path. They are perfectly
-- mappable — they just arrived after the first backfill ran. Re-running the same
-- idempotent statements here catches them, so a normal deploy does not trip the
-- guard below for a reason that needs no human judgement.
--
-- Identical to 20260906000000 section 2: fills only what is empty, so a path the
-- frontend wrote is never overwritten.

UPDATE public.task_attachments
SET storage_path = split_part(url, '/storage/v1/object/public/task-attachments/', 2)
WHERE coalesce(storage_path, '') = ''
  AND url LIKE '%/storage/v1/object/public/task-attachments/%'
  AND split_part(url, '/storage/v1/object/public/task-attachments/', 2) <> '';

UPDATE public.tasks
SET attachment_storage_path =
      split_part(attachment_url, '/storage/v1/object/public/task-attachments/', 2)
WHERE coalesce(attachment_storage_path, '') = ''
  AND attachment_url LIKE '%/storage/v1/object/public/task-attachments/%'
  AND split_part(attachment_url, '/storage/v1/object/public/task-attachments/', 2) <> '';

UPDATE public.task_activity_log
SET attachment_storage_path =
      split_part(attachment_url, '/storage/v1/object/public/task-attachments/', 2)
WHERE coalesce(attachment_storage_path, '') = ''
  AND attachment_url LIKE '%/storage/v1/object/public/task-attachments/%'
  AND split_part(attachment_url, '/storage/v1/object/public/task-attachments/', 2) <> '';

DO $$
DECLARE
  v_unmapped int;
BEGIN
  -- Precondition 2: the column exists, i.e. 20260906000000 ran.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'task_attachments'
      AND column_name = 'storage_path'
  ) THEN
    RAISE EXCEPTION
      'task_attachments.storage_path does not exist — apply 20260906000000 first';
  END IF;

  -- Precondition 3: every attachment is reachable by path, across all THREE
  -- surfaces — task_attachments.url, tasks.attachment_url and
  -- task_activity_log.attachment_url.
  SELECT
    (SELECT count(*) FROM public.task_attachments
      WHERE coalesce(storage_path, '') = '')
    + (SELECT count(*) FROM public.tasks
        WHERE attachment_url IS NOT NULL AND coalesce(attachment_storage_path, '') = '')
    + (SELECT count(*) FROM public.task_activity_log
        WHERE attachment_url IS NOT NULL AND coalesce(attachment_storage_path, '') = '')
  INTO v_unmapped;

  IF v_unmapped > 0 THEN
    RAISE EXCEPTION
      'Refusing to make the bucket private: % attachment rows have no storage_path '
      'and would become unreachable.', v_unmapped;
  END IF;

  -- The task-aware policies must already be in place, or making the bucket
  -- private would leave NO way to read an attachment at all.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'storage' AND c.relname = 'objects'
      AND p.polname = 'task_attachments_storage_select'
  ) THEN
    RAISE EXCEPTION
      'task_attachments_storage_select is missing — apply 20260906000000 first';
  END IF;
END $$;

-- ── The flip ────────────────────────────────────────────────────────────────

UPDATE storage.buckets
SET public = false
WHERE id = 'task-attachments';

-- ── Assertions ──────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_still_public text;
BEGIN
  IF EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'task-attachments' AND public) THEN
    RAISE EXCEPTION 'task-attachments is still public';
  END IF;

  -- Every other bucket keeps the visibility it had. This migration must not be
  -- the reason any other bucket changed state.
  SELECT string_agg(id, ', ') INTO v_still_public
  FROM storage.buckets
  WHERE public AND id <> 'task-attachments';

  IF v_still_public IS NOT NULL THEN
    RAISE WARNING 'Other public buckets exist and were left alone: %', v_still_public;
  END IF;

  -- Reading an attachment must still be possible for somebody authorized.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'storage' AND c.relname = 'objects'
      AND p.polname = 'task_attachments_storage_select'
  ) THEN
    RAISE EXCEPTION 'No SELECT policy remains for task-attachments';
  END IF;
END $$;
