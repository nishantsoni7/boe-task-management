-- Logo marks on quotation pictures (owner, 18 Nov 2026): the clean picture moves to a PRIVATE bucket, and the public
-- 'quotation-images' bucket (what the client link, the PDF and the screens show) holds the marked copy at the SAME path,
-- so no stored path changes.
--
-- Adds the private bucket 'quotation-originals' (JPEG, 3 MB, same as the public one) with two policies:
--   insert: the same rule as the public bucket (own folder, a .jpg, quotation create or edit);
--   select: a signed-in person who may enter Quotations (the builder, the PI conversion and the image studio read the
--           clean original as the caller).
-- No update or delete policy: only the server (service role) ever replaces or removes an original.
-- Nothing existing changes. The marked copies are written by /api/quotations/picture-mark and by the backfill script
-- (scripts/quotations/mark-existing-pictures.ts), which first copies each clean picture here.
--
-- Rollback: delete the objects in the bucket (after copying them back to 'quotation-images' if the marks are to go),
-- drop both policies and delete the bucket.

begin;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('quotation-originals', 'quotation-originals', false, 3145728, array['image/jpeg'])
on conflict (id) do update set
  public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists quotation_originals_insert on storage.objects;
create policy quotation_originals_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'quotation-originals' and public.quotation_can_upload(name));

drop policy if exists quotation_originals_select on storage.objects;
create policy quotation_originals_select on storage.objects
  for select to authenticated
  using (bucket_id = 'quotation-originals' and public.module_entry_open('quotations'));

do $$
begin
  if (select public from storage.buckets where id = 'quotation-originals') is distinct from false then
    raise exception 'QUOTATION_ORIGINALS: the originals bucket must be private';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'quotation_originals_insert')
     or not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'quotation_originals_select') then
    raise exception 'QUOTATION_ORIGINALS: a policy is missing';
  end if;
end $$;

commit;
