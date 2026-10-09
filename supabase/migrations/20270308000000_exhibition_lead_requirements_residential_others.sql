-- Exhibition Leads — two more Requirement options: Residential and Others.
--
-- The Requirement list was a closed pair (restaurant_cafe, hotel) held by one
-- CHECK on exhibition_leads.requirements, which also allowed at most two picks.
-- This widens that CHECK to the four options and at most four picks. Nothing
-- else changes: existing rows already satisfy the wider rule.

alter table public.exhibition_leads
  drop constraint if exists exhibition_leads_requirements_check;

alter table public.exhibition_leads
  add constraint exhibition_leads_requirements_check check (
    cardinality(requirements) between 1 and 4
    and requirements <@ array['restaurant_cafe','hotel','residential','others']::text[]);
