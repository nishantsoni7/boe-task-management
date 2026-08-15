-- Task attachments, step 1 of 2: record the object path, and make storage
-- authorization follow the parent task.
--
-- THE HOLE THIS CLOSES
-- --------------------
-- `task-attachments` is the only PUBLIC bucket in the project (asset-documents,
-- meeting-product-images, order-request-attachments and payment-proofs are all
-- private). Its storage.objects SELECT policy is:
--
--     public_read : bucket_id = 'task-attachments'      -- to PUBLIC, no role limit
--
-- No task check, no ownership check, no role check. Anyone holding an object URL
-- can read it, and because the bucket is public the URL needs no session at all.
-- 469 attachment rows are reachable this way today.
--
-- WHY TWO MIGRATIONS
-- ------------------
-- Flipping the bucket private in the same step would break every stored URL the
-- moment it landed. The staging is:
--
--   1. deploy the frontend  — writes storage_path, reads through signed URLs
--   2. THIS migration       — adds the column, backfills it, and makes storage
--                             authorization task-aware. The bucket is still
--                             public, so every existing public URL keeps working
--                             and nothing can break.
--   3. verify the backfill  — the assertion below already fails the migration if
--                             a single row cannot be mapped
--   4. 20260907000000       — flips the bucket private and drops public read
--
-- Steps 2 and 4 are separate files precisely so 4 can wait for human
-- confirmation of 3.
--
-- SCOPE
-- -----
-- Additive and idempotent. One nullable column, one index, one backfill of a
-- column that did not exist before, and the three task-attachments policies on
-- storage.objects. No other bucket is touched. No task, attachment, permission
-- or grant row has its meaning changed — the backfill only fills a new column.

-- ── 1. The column ───────────────────────────────────────────────────────────
--
-- Nullable on purpose. The frontend deploys BEFORE this migration, so during the
-- window between the two, rows arrive from a build that already sets it; rows
-- from before the deploy are filled by the backfill. NOT NULL is a later
-- tightening once both are provably true in production — see the report.

-- THREE surfaces carry a task-attachment URL, not one. Audited against
-- production before writing this:
--
--   task_attachments.url              469 rows, all in this bucket
--   tasks.attachment_url               40 rows, all in this bucket
--   task_activity_log.attachment_url   10 rows, all in this bucket
--
-- The two `attachment_url` columns are the legacy single-attachment fields that
-- predate the task_attachments table. Missing them would leave 50 images
-- broken the moment 20260907000000 lands, which is exactly the class of failure
-- this staging exists to prevent.

ALTER TABLE public.task_attachments
  ADD COLUMN IF NOT EXISTS storage_path text;

ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS attachment_storage_path text;

ALTER TABLE public.task_activity_log
  ADD COLUMN IF NOT EXISTS attachment_storage_path text;

COMMENT ON COLUMN public.task_attachments.storage_path IS
  'Object key inside the task-attachments bucket, e.g. tasks/<id>/f.png or updates/<id>/f.png. '
  'The authority for signing, downloading and deleting. `url` is legacy: it is a public URL that '
  'stops resolving once 20260907000000 makes the bucket private.';

-- ── 2. Backfill ─────────────────────────────────────────────────────────────
--
-- Every stored URL has the shape
--   https://<ref>.supabase.co/storage/v1/object/public/task-attachments/<path>
-- and <path> is exactly what the Storage API wants. Verified against production
-- before writing this: 469 rows, 0 percent-encoded, 0 carrying a query string,
-- 0 unparseable, and exactly two prefixes (`tasks/` 215, `updates/` 254). No URL
-- decoding step is therefore needed — and if that ever stops being true, the
-- assertion in section 4 fails rather than storing a wrong path.
--
-- Only fills what is empty, so re-running cannot overwrite a path the frontend
-- wrote.

UPDATE public.task_attachments
SET storage_path = split_part(url, '/storage/v1/object/public/task-attachments/', 2)
WHERE storage_path IS NULL
  AND url LIKE '%/storage/v1/object/public/task-attachments/%'
  AND split_part(url, '/storage/v1/object/public/task-attachments/', 2) <> '';

UPDATE public.tasks
SET attachment_storage_path =
      split_part(attachment_url, '/storage/v1/object/public/task-attachments/', 2)
WHERE attachment_storage_path IS NULL
  AND attachment_url LIKE '%/storage/v1/object/public/task-attachments/%'
  AND split_part(attachment_url, '/storage/v1/object/public/task-attachments/', 2) <> '';

UPDATE public.task_activity_log
SET attachment_storage_path =
      split_part(attachment_url, '/storage/v1/object/public/task-attachments/', 2)
WHERE attachment_storage_path IS NULL
  AND attachment_url LIKE '%/storage/v1/object/public/task-attachments/%'
  AND split_part(attachment_url, '/storage/v1/object/public/task-attachments/', 2) <> '';

-- ── 3. Index ────────────────────────────────────────────────────────────────
--
-- The storage policies below join storage.objects.name to this column on every
-- signed-URL request. Without an index that is a sequential scan per object.

CREATE INDEX IF NOT EXISTS task_attachments_storage_path_idx
  ON public.task_attachments (storage_path);

-- ── 4. Backfill assertion ───────────────────────────────────────────────────
--
-- The migration fails rather than leaving a row that will become unreachable
-- when the bucket goes private.

DO $$
DECLARE
  v_unmapped int;
  v_bad_shape int;
BEGIN
  -- All THREE surfaces, because 20260907000000 breaks any URL left behind.
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
      '% task-attachment rows could not be mapped to a storage path. '
      'Do NOT apply 20260907000000 until every row maps.', v_unmapped;
  END IF;

  -- A path must look like an object key, not a URL fragment or an absolute URL.
  SELECT count(*) INTO v_bad_shape
  FROM public.task_attachments
  WHERE storage_path LIKE 'http%'
     OR storage_path LIKE '/%'
     OR storage_path LIKE '%?%'
     OR split_part(storage_path, '/', 1) NOT IN ('tasks', 'updates');

  IF v_bad_shape > 0 THEN
    RAISE EXCEPTION '% task_attachments rows have a malformed storage_path', v_bad_shape;
  END IF;
END $$;

-- ── 5. Storage authorization follows the parent task ────────────────────────
--
-- THE ACCESS RULE, matching the task_attachments_read policy exactly: a person
-- may reach an attachment when they are the parent task's creator, assignee or
-- delegator. Admins are added explicitly (the tasks SELECT policy has no admin
-- branch of its own — admin task screens go through the service role).
--
-- The parent MODULE gate is applied first, so an employee whose Task Management
-- access is switched off cannot reach attachments even for a task they created.
-- That is the same rule 20260904000000 applies to Sample Tracking and
-- 20260905000000 applies to the rest.
--
-- `owner = auth.uid()` is the third branch and it is load-bearing: comment
-- attachments upload the OBJECT before the task_attachments ROW exists (see
-- src/lib/tasks/commentAttachments.ts), so during that window the row-join finds
-- nothing. Restricting it to the uploader keeps that safe — knowing somebody
-- else's path grants nothing, because you are not its owner.

DROP POLICY IF EXISTS "public_read" ON storage.objects;
DROP POLICY IF EXISTS "task_attachments_storage_select" ON storage.objects;

CREATE POLICY "task_attachments_storage_select" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'task-attachments'
    AND public.module_entry_open('task_management')
    AND (
      owner = auth.uid()
      OR EXISTS (
        SELECT 1 FROM public.users u
        WHERE u.id = auth.uid() AND u.role = 'admin'
      )
      OR EXISTS (
        SELECT 1
        FROM public.task_attachments a
        JOIN public.tasks t ON t.id = a.task_id
        WHERE a.storage_path = storage.objects.name
          AND (
            auth.uid() = t.created_by
            OR auth.uid() = t.assigned_to
            OR auth.uid() = t.delegated_by
          )
      )
      -- The two legacy single-attachment columns resolve through the same
      -- task-access rule, so the 50 objects they point at stay reachable.
      OR EXISTS (
        SELECT 1
        FROM public.tasks t
        WHERE t.attachment_storage_path = storage.objects.name
          AND (
            auth.uid() = t.created_by
            OR auth.uid() = t.assigned_to
            OR auth.uid() = t.delegated_by
          )
      )
      OR EXISTS (
        SELECT 1
        FROM public.task_activity_log l
        JOIN public.tasks t ON t.id = l.task_id
        WHERE l.attachment_storage_path = storage.objects.name
          AND (
            auth.uid() = t.created_by
            OR auth.uid() = t.assigned_to
            OR auth.uid() = t.delegated_by
          )
      )
    )
  );

DROP POLICY IF EXISTS "auth_delete" ON storage.objects;
DROP POLICY IF EXISTS "task_attachments_storage_delete" ON storage.objects;

CREATE POLICY "task_attachments_storage_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'task-attachments'
    AND public.module_entry_open('task_management')
    AND (
      owner = auth.uid()
      OR EXISTS (
        SELECT 1 FROM public.users u
        WHERE u.id = auth.uid() AND u.role = 'admin'
      )
      OR EXISTS (
        SELECT 1
        FROM public.task_attachments a
        JOIN public.tasks t ON t.id = a.task_id
        WHERE a.storage_path = storage.objects.name
          AND (
            auth.uid() = t.created_by
            OR auth.uid() = t.assigned_to
            OR auth.uid() = t.delegated_by
          )
      )
      -- The two legacy single-attachment columns resolve through the same
      -- task-access rule, so the 50 objects they point at stay reachable.
      OR EXISTS (
        SELECT 1
        FROM public.tasks t
        WHERE t.attachment_storage_path = storage.objects.name
          AND (
            auth.uid() = t.created_by
            OR auth.uid() = t.assigned_to
            OR auth.uid() = t.delegated_by
          )
      )
      OR EXISTS (
        SELECT 1
        FROM public.task_activity_log l
        JOIN public.tasks t ON t.id = l.task_id
        WHERE l.attachment_storage_path = storage.objects.name
          AND (
            auth.uid() = t.created_by
            OR auth.uid() = t.assigned_to
            OR auth.uid() = t.delegated_by
          )
      )
    )
  );

-- Upload keeps its existing shape — any authenticated user may write into the
-- bucket — with the module gate added and ownership pinned so an upload cannot
-- be attributed to somebody else.

DROP POLICY IF EXISTS "auth_upload" ON storage.objects;
DROP POLICY IF EXISTS "task_attachments_storage_insert" ON storage.objects;

CREATE POLICY "task_attachments_storage_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'task-attachments'
    AND public.module_entry_open('task_management')
    AND owner = auth.uid()
  );

-- ── 6. Assertions ───────────────────────────────────────────────────────────

DO $$
DECLARE
  v_leftover text;
  v_missing  text;
BEGIN
  -- The unrestricted read must be gone.
  IF EXISTS (
    SELECT 1 FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'storage' AND c.relname = 'objects' AND p.polname = 'public_read'
  ) THEN
    RAISE EXCEPTION 'public_read still exists on storage.objects';
  END IF;

  -- The three replacements exist and all resolve the parent module gate.
  SELECT string_agg(want, ', ') INTO v_missing
  FROM unnest(ARRAY[
    'task_attachments_storage_select',
    'task_attachments_storage_delete',
    'task_attachments_storage_insert'
  ]) AS want
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'storage' AND c.relname = 'objects' AND p.polname = want
      AND (coalesce(pg_get_expr(p.polqual, p.polrelid), '')
           || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''))
          LIKE '%module_entry_open%'
  );

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Missing or ungated task-attachment storage policies: %', v_missing;
  END IF;

  -- No other bucket lost a policy.
  SELECT string_agg(want, ', ') INTO v_leftover
  FROM unnest(ARRAY[
    'asset_documents_storage_select',
    'order_request_attachments_storage_select',
    'payment_proofs_select',
    'meeting_product_images_select'
  ]) AS want
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'storage' AND c.relname = 'objects' AND p.polname = want
  );

  IF v_leftover IS NOT NULL THEN
    RAISE EXCEPTION 'Other buckets must be untouched, but these are missing: %', v_leftover;
  END IF;

  -- The bucket is still PUBLIC at this point, by design.
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'task-attachments' AND public) THEN
    RAISE WARNING 'task-attachments is already private — 20260907000000 appears to have run first';
  END IF;
END $$;
