-- One-time cleanup of existing questions (docs/superpowers/specs/2026-09-19-
-- hands-free-audio-design.md §3.2/part D): alternatives in prompt_text are
-- written with commas from now on ("седоватый, с проседью"), never with a
-- slash, matching the generator's new rule and lib/audio/sequence.ts's
-- speakable() (which already normalizes slashes at speak time, but the
-- review screen also shows prompt_text verbatim, so the stored text itself
-- is rewritten here too). Handles the spacing variants in order, innermost
-- first: ' / ', ' /', '/ ', then a bare '/'. Touches only prompt_text, only
-- on rows that actually contain a slash. Append-only: the deployed database
-- holds real cards.
UPDATE cards
   SET prompt_text = REPLACE(
                        REPLACE(
                          REPLACE(
                            REPLACE(prompt_text, ' / ', ', '),
                          ' /', ', '),
                        '/ ', ', '),
                      '/', ', ')
 WHERE prompt_text LIKE '%/%';
