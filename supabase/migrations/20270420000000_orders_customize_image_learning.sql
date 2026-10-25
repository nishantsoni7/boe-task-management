-- Orders: Customize image learns from approved rules and examples (Phase 1).
--
-- WHY
--   Customize image (Edit PI, PR #449) turns a salesperson's words into exact
--   drawing instructions ("Check understanding", Claude) and then a picture.
--   The same few changes repeat most of the time — a longer table on two
--   pedestals sharing one floor plate, square to round, wood to marble. The
--   owner wants it to get those right by default, and an admin to teach it.
--
--   It learns WITHOUT retraining any model: every attempt is recorded; an
--   admin writes HOUSE RULES and approves EXAMPLES (a customization and the
--   correct instruction for it); Check understanding is given the active rules
--   and the most similar approved examples every time. Nothing is learned
--   without an admin approving it, and any rule or example can be switched off.
--
-- WHAT THIS DOES
--   1. Registers orders.train_customize_image (deny-by-default; admins hold it
--      through the admin branch of actor_has_module_permission).
--   2. pi_customization_attempts  one row per Check understanding press, then
--                                 updated by Regenerate / Use / Discard /
--                                 Refine / 👍 / 👎.
--   3. pi_customization_rules     house rules, plain English, on/off.
--   4. pi_customization_examples  approved examples, on/off. Their pictures are
--                                 COPIED to order-files/customize-learning/… by
--                                 the app at approval, so an example outlives
--                                 the PI it came from.
--   5. can_train_customize_image()  the one door for the admin Learning page.
--   6. Five seed rules (source 'seed') for the owner to review.
--
-- ACCESS MODEL
--   RLS on, NO policies, nothing granted to anon/authenticated: the three
--   tables are reached only by the API routes with the service role, after the
--   route has asked the database, as the person, whether they may
--   (mayChangePiPhotos for a salesperson's own attempt; can_train_customize_image
--   for the Learning page). Same shape as the Image Editor history routes.
--
-- WHAT IT DELIBERATELY DOES NOT DO
--   * No model training, no provider call, no storage objects (the app copies
--     pictures). No change to any existing table, function or policy.
--   * An attempt goes with its PI: ON DELETE CASCADE from order_submissions,
--     so PI deletion and test-data cleanup need no new step. An approved
--     example does NOT (attempt_id is set null) — it keeps its own copies.
--   * A deleted member's attempts stay, anonymised (created_by set null).
--
-- ROLLBACK
--   drop function public.can_train_customize_image();
--   drop table public.pi_customization_examples;
--   drop table public.pi_customization_rules;
--   drop table public.pi_customization_attempts;
--   The permission rows may stay. Copied example pictures under
--   order-files/customize-learning/ can be removed by hand.

do $dep$
begin
  if to_regprocedure('public.actor_has_module_permission(text, text)') is null then
    raise exception 'DEPENDENCY MISSING: public.actor_has_module_permission(text, text)';
  end if;
  if to_regprocedure('public.module_entry_open(text)') is null then
    raise exception 'DEPENDENCY MISSING: public.module_entry_open(text)';
  end if;
  if to_regclass('public.order_submissions') is null then
    raise exception 'DEPENDENCY MISSING: public.order_submissions';
  end if;
  if not exists (select 1 from public.permission_modules where module_key = 'orders') then
    raise exception 'DEPENDENCY MISSING: permission module orders';
  end if;
end $dep$;


-- ═══ §1. orders.train_customize_image ═══════════════════════════════════════

insert into public.permission_actions (action_key, display_name, is_system)
values ('train_customize_image', 'Train Customize image', false)
on conflict (action_key) do nothing;

insert into public.module_permission_actions (module_id, action_id, default_allowed)
select pm.id, pa.id, false
from public.permission_modules pm
join public.permission_actions pa on pa.action_key = 'train_customize_image'
where pm.module_key = 'orders'
on conflict (module_id, action_id) do nothing;


-- ═══ §2. Attempts ═══════════════════════════════════════════════════════════

create table public.pi_customization_attempts (
  id                       uuid primary key default gen_random_uuid(),
  submission_id            uuid not null references public.order_submissions(id) on delete cascade,
  -- The PI line. Not a foreign key: a line added in Edit PI has no row until the edit is saved.
  item_id                  uuid not null,
  created_by               uuid references public.users(id) on delete set null,
  -- What the person asked, and what was known about the product.
  source_path              text not null check (char_length(source_path) <= 400),
  comment                  text not null check (char_length(comment) between 1 and 1500),
  product_name             text check (char_length(product_name) <= 300),
  pi_dimensions            text check (char_length(pi_dimensions) <= 500),
  pi_material              text check (char_length(pi_material) <= 1000),
  reference_count          smallint not null default 0 check (reference_count between 0 and 2),
  -- What Claude understood, and what was finally sent to the image model (after any edit).
  understood_instruction   text not null check (char_length(understood_instruction) <= 1500),
  understood_assumptions   jsonb not null default '[]'::jsonb check (jsonb_typeof(understood_assumptions) = 'array'),
  final_instruction        text check (char_length(final_instruction) <= 1500),
  instruction_edited       boolean not null default false,
  result_path              text check (char_length(result_path) <= 400),
  -- Which rules and examples Check understanding was given.
  applied_rule_ids         uuid[] not null default '{}',
  applied_example_ids      uuid[] not null default '{}',
  outcome                  text not null default 'understood'
                           check (outcome in ('understood', 'generated', 'used', 'discarded', 'refined', 'failed')),
  feedback                 text check (feedback in ('correct', 'wrong')),
  feedback_note            text check (char_length(feedback_note) <= 1000),
  feedback_at              timestamptz,
  -- Set when an admin has looked at it on the Learning page (taught from it or dismissed it).
  reviewed_by              uuid references public.users(id) on delete set null,
  reviewed_at              timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index pi_customization_attempts_created_idx on public.pi_customization_attempts (created_at desc);
create index pi_customization_attempts_review_idx on public.pi_customization_attempts (feedback, reviewed_at, created_at desc);
create index pi_customization_attempts_submission_idx on public.pi_customization_attempts (submission_id);

comment on table public.pi_customization_attempts is
  'Customize image (Edit PI): one row per Check understanding, updated by Regenerate/Use/Discard/Refine and the salesperson''s 👍/👎. Read and written only by API routes with the service role (20270420000000). Goes with its PI (cascade).';


-- ═══ §3. House rules ════════════════════════════════════════════════════════

create table public.pi_customization_rules (
  id           uuid primary key default gen_random_uuid(),
  rule_text    text not null check (char_length(btrim(rule_text)) between 5 and 500),
  is_active    boolean not null default true,
  source       text not null default 'admin' check (source in ('admin', 'seed', 'suggested')),
  created_by   uuid references public.users(id) on delete set null,
  updated_by   uuid references public.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index pi_customization_rules_active_idx on public.pi_customization_rules (is_active, created_at);

comment on table public.pi_customization_rules is
  'Customize image house rules: plain-English rules an admin writes or approves; every ACTIVE rule is given to Check understanding. Service-role only (20270420000000).';


-- ═══ §4. Approved examples ══════════════════════════════════════════════════

create table public.pi_customization_examples (
  id                    uuid primary key default gen_random_uuid(),
  attempt_id            uuid references public.pi_customization_attempts(id) on delete set null,
  product_name          text check (char_length(product_name) <= 300),
  pi_dimensions         text check (char_length(pi_dimensions) <= 500),
  comment               text not null check (char_length(btrim(comment)) between 1 and 1500),
  -- The CORRECT instruction for that comment, as the admin approved it.
  instruction           text not null check (char_length(btrim(instruction)) between 5 and 1500),
  -- Lower-case words used to find similar requests (product type, parts, changes).
  keywords              text[] not null default '{}',
  -- Copies under order-files/customize-learning/examples/{id}/…, made by the app.
  before_path           text check (before_path is null or before_path ~ '^customize-learning/examples/[0-9a-f-]{36}/before\.(jpg|png|webp)$'),
  after_path            text check (after_path is null or after_path ~ '^customize-learning/examples/[0-9a-f-]{36}/after\.(jpg|png|webp)$'),
  is_active             boolean not null default true,
  approved_by           uuid references public.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index pi_customization_examples_active_idx on public.pi_customization_examples (is_active, created_at desc);
create index pi_customization_examples_keywords_idx on public.pi_customization_examples using gin (keywords);

comment on table public.pi_customization_examples is
  'Customize image approved examples: a salesperson''s customization and the correct instruction for it. The most similar ACTIVE ones are given to Check understanding. Pictures are copies the example owns. Service-role only (20270420000000).';


-- ═══ §5. Access: service role only ══════════════════════════════════════════

alter table public.pi_customization_attempts enable row level security;
alter table public.pi_customization_rules    enable row level security;
alter table public.pi_customization_examples enable row level security;

revoke all on public.pi_customization_attempts from public, anon, authenticated;
revoke all on public.pi_customization_rules    from public, anon, authenticated;
revoke all on public.pi_customization_examples from public, anon, authenticated;


-- ═══ §6. The door to the Learning page ══════════════════════════════════════

create or replace function public.can_train_customize_image()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select auth.uid() is not null
     and public.module_entry_open('orders')
     and public.actor_has_module_permission('orders', 'train_customize_image');
$fn$;
revoke all on function public.can_train_customize_image() from public, anon;
grant execute on function public.can_train_customize_image() to authenticated;

comment on function public.can_train_customize_image() is
  'May open the Customize image Learning page: review attempts, write house rules, approve examples. orders.train_customize_image (admins through the admin branch). 20270420000000.';


-- ═══ §7. Seed rules (the owner reviews them on the Learning page) ═══════════

insert into public.pi_customization_rules (rule_text, source) values
  ('If the PI dimensions describe a rectangle (length clearly greater than width) but the photograph shows a square or round top, make the top rectangular in that length-to-width ratio.', 'seed'),
  ('A single-pedestal table whose top becomes longer than about 1.8 m, or more than about 1.6 times its width, gets two identical pedestals of the same design, one under each end of the top.', 'seed'),
  ('When a single-pedestal table gets two pedestals, both stand on ONE continuous floor plate that joins them, unless the customization asks for separate plates.', 'seed'),
  ('When only the top material changes, keep the top''s shape, thickness and edge profile exactly as in the photograph.', 'seed'),
  ('When only the size changes, keep the base design, its finish and the proportions of its parts as in the photograph.', 'seed');


-- ═══ §8. Self-assertion (runs on apply) ═════════════════════════════════════

do $assert$
declare
  t text;
begin
  if not exists (
    select 1
      from public.module_permission_actions mpa
      join public.permission_actions pa on pa.id = mpa.action_id
      join public.permission_modules pm on pm.id = mpa.module_id
     where pm.module_key = 'orders' and pa.action_key = 'train_customize_image' and mpa.default_allowed = false
  ) then
    raise exception 'ASSERT: orders.train_customize_image must be registered and deny-by-default';
  end if;

  foreach t in array array['pi_customization_attempts', 'pi_customization_rules', 'pi_customization_examples'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception 'ASSERT: RLS must be on for %', t;
    end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t) then
      raise exception 'ASSERT: % must have no policies (service role only)', t;
    end if;
    if has_table_privilege('authenticated', 'public.' || t, 'select')
       or has_table_privilege('anon', 'public.' || t, 'select') then
      raise exception 'ASSERT: % must not be readable by anon/authenticated', t;
    end if;
  end loop;

  if has_function_privilege('anon', 'public.can_train_customize_image()', 'execute') then
    raise exception 'ASSERT: anon must not execute can_train_customize_image()';
  end if;
  if (select count(*) from public.pi_customization_rules where source = 'seed') < 5 then
    raise exception 'ASSERT: seed rules missing';
  end if;
end $assert$;
