-- Add multi-image support and structured dimensions to showroom_products.
-- Backward compat: image_url stays. images[] is the new primary store.
-- If images is empty, consumers fall back to image_url.

alter table public.showroom_products
  add column if not exists images     text[]  not null default '{}',
  add column if not exists dimensions jsonb;

-- Back-fill: move existing image_url into images[] for older rows
update public.showroom_products
  set images = array[image_url]
  where image_url is not null and array_length(images, 1) is null;
