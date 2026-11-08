-- ============================================================
-- CRWD SRFR — Post videos up to 200 MB
-- The New Post form (js/crwd-composer.js) allows videos up to 200 MB (VIDEO_MAX_MB), but the
-- post-media bucket was created with a 50 MB limit, so anything between 50 and 200 MB was
-- refused by Supabase. This raises the bucket to match.
-- Also needed (dashboard, not SQL): Storage → Settings → global upload limit of at least 200 MB.
-- (The Free plan caps that at 50 MB, so on a Free project only the 50 MB limit applies.)
-- ============================================================

update storage.buckets
set file_size_limit = 209715200  -- 200 MB
where id = 'post-media';
