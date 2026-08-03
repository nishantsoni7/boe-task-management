-- Tighten the mandatory-remark constraint on attendance_day_corrections.
--
-- 20260807000000 used `btrim(remark) <> ''`. btrim() with no second argument
-- strips SPACES ONLY, so '' and '   ' were rejected but a remark consisting of
-- a single tab, carriage return or newline was accepted — verified against the
-- applied table, not assumed.
--
-- The API has always rejected those (validateCorrectionInput uses JS .trim(),
-- which strips all whitespace) and it is the only write path, since no client
-- role holds INSERT on this table. This is therefore defence in depth being
-- brought up to the standard the column comment already claimed, not a live
-- data problem. No existing row can violate it: the table's only writer has
-- always trimmed.
--
-- `remark ~ '\S'` reads as "contains at least one non-whitespace character",
-- which is the rule stated directly. It also avoids the E'...' escape-string
-- form, whose backslash sequences are the reason the first attempt did not end
-- up in the database as written.

ALTER TABLE public.attendance_day_corrections
  DROP CONSTRAINT IF EXISTS attendance_day_corrections_remark_check;

ALTER TABLE public.attendance_day_corrections
  ADD CONSTRAINT attendance_day_corrections_remark_check
  CHECK (remark ~ '\S');
