-- ============================================================================
-- Academic Calendar migration — Term: July 2026 to May 2027 (Term 26-1, 26-2)
-- Source: RNGPIT official calendar L-GEN-001A, Rev.0 (Dr. J. B. Chaudhari)
-- Programs: B.Tech, B.Voc, iM.Sc IT, iMBA
--
-- Applied to the LIVE DB (project dnjmgxsvwmzeprginaeo) as migration
-- `seed_academic_calendar_2026_27`. It migrates onto the existing CURRENT
-- academic year (relabels it 2026-27) rather than creating a duplicate year,
-- so all existing FKs (students, results, meetings…) stay intact.
--
-- Week numbers are computed the same way the app does:
--   week = floor((event_start - semester_start) / 7) + 1   (capped at 26)
--   Odd  semester start = 2026-06-29   Even semester start = 2027-01-01
--
-- ES = Expert Speech, IV = Industrial Visit, IAT = Internal Assessment Test,
-- SBT = Skill-Based Training. Idempotent: safe to re-run.
-- ============================================================================

DO $$
DECLARE
  ay_id uuid;
BEGIN
  SELECT id INTO ay_id FROM academic_years WHERE is_current = true LIMIT 1;
  IF ay_id IS NULL THEN
    RAISE EXCEPTION 'No current academic year found';
  END IF;

  -- Relabel current year to reflect the migrated term
  UPDATE academic_years
     SET year_name = '2026-27', start_date = '2026-06-29', end_date = '2027-05-31'
   WHERE id = ay_id;

  -- Align semester windows with the new calendar term dates
  UPDATE semesters SET start_date = '2026-06-29', end_date = '2026-12-31'
    WHERE academic_year_id = ay_id AND semester_type = 'odd';
  UPDATE semesters SET start_date = '2027-01-01', end_date = '2027-05-31'
    WHERE academic_year_id = ay_id AND semester_type = 'even';

  -- Replace this year's events with the official calendar
  DELETE FROM academic_events WHERE academic_year_id = ay_id;

  INSERT INTO academic_events (academic_year_id, title, type, start_date, end_date, week, semester_type) VALUES
    -- ── ODD TERM (SEM 1, 3, 5, 7) ────────────────────────────────────────────
    (ay_id, 'SBT-1, 2 for SEM 3, 5',                                'academic',   '2026-06-29', '2026-07-10', '1,2',                 'odd'),
    (ay_id, 'Induction Program for SEM 1',                          'academic',   '2026-07-01', '2026-07-10', '1,2',                 'odd'),
    (ay_id, 'Academic Activities & ES-1, IV-1',                     'academic',   '2026-07-13', '2026-08-29', '3,4,5,6,7,8,9',       'odd'),
    (ay_id, 'IAT - 1',                                              'exam',       '2026-08-31', '2026-09-04', '10',                  'odd'),
    (ay_id, 'Academic Activities & ES-2, IV-2',                     'academic',   '2026-09-07', '2026-10-17', '11,12,13,14,15,16',   'odd'),
    (ay_id, 'IAT - 2',                                              'exam',       '2026-10-19', '2026-10-26', '17,18',               'odd'),
    (ay_id, 'Academic Activities, Re-mid Exam & Final Submission',  'submission', '2026-10-27', '2026-11-04', '18,19',               'odd'),
    (ay_id, 'Diwali Vacation',                                      'vacation',   '2026-11-05', '2026-11-25', '19,20,21,22',         'odd'),
    (ay_id, 'Final Exam, Re-mid Exam',                              'exam',       '2026-11-30', '2026-12-31', '23,24,25,26',         'odd'),

    -- ── EVEN TERM (SEM 2, 4, 6, 8) ───────────────────────────────────────────
    (ay_id, 'Academic Activities & ES-1, IV-1',                     'academic',   '2027-01-01', '2027-02-20', '1,2,3,4,5,6,7,8',     'even'),
    (ay_id, 'IAT - 1',                                              'exam',       '2027-02-22', '2027-02-26', '8,9',                 'even'),
    (ay_id, 'Academic Activities & ES-2, IV-2',                     'academic',   '2027-03-01', '2027-04-10', '9,10,11,12,13,14,15', 'even'),
    (ay_id, 'IAT - 2',                                              'exam',       '2027-04-12', '2027-04-17', '15,16',               'even'),
    (ay_id, 'Academic Activities, Re-mid Exam & Final Submission',  'submission', '2027-04-19', '2027-05-02', '16,17,18',            'even'),
    (ay_id, 'Final Exam, Re-mid Exam',                              'exam',       '2027-05-10', '2027-05-31', '19,20,21,22',         'even');

  RAISE NOTICE 'Academic calendar 2026-27 migrated onto year %', ay_id;
END $$;
