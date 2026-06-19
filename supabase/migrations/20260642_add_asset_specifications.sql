-- Asset Inventory enhancement: free-text specifications/details field.
-- Single flexible text column instead of per-type fields (RAM, IMEI, etc.).

alter table public.assets
  add column if not exists specifications text null;
