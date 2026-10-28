-- ============================================================
-- CRWD SRFR — Admin page helpers (/admin/)
--
--   • am_i_admin(): lets the site show the Admin menu item and page
--     (the admins table itself stays unreachable from the browser).
--   • admin_reports(open_only): the reports queue with what each report is
--     about — the post title, comment or message text, and usernames — which
--     admins couldn't otherwise read (private profiles, messages).
--     Returns nothing for anyone who isn't an admin.
--
-- Approving/rejecting posts uses moderate_post() from the v1 schema.
-- Removing a reported post/comment and updating report status use the
-- admin rules already in v1 (delete policies, reports update policy).
-- ============================================================

-- sb.rpc('am_i_admin') → true / false
create or replace function public.am_i_admin()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.is_admin();
$$;

revoke execute on function public.am_i_admin() from public, anon;
grant execute on function public.am_i_admin() to authenticated;

-- sb.rpc('admin_reports', { open_only: true })  → newest first, up to 200
create or replace function public.admin_reports(open_only boolean default true)
returns table (
  id                uuid,
  created_at        timestamptz,
  status            text,
  reason            text,
  details           text,
  target_type       text,         -- 'user' | 'post' | 'comment' | 'message'
  target_id         text,
  reporter_username text,
  target_username   text,         -- the reported user / the post's, comment's or message's author
  target_title      text,         -- post title (for post reports)
  target_body       text,         -- comment or message text
  target_post_id    uuid,         -- the post (post reports, and comments on a post)
  target_post_destination text,   -- 'board' | 'profile', for building the link
  target_event_id   text,         -- comments on a show
  target_exists     boolean       -- false once it's been deleted
)
language sql stable security definer set search_path = ''
as $$
  select
    r.id, r.created_at, r.status, r.reason, r.details, r.target_type, r.target_id,
    rp.username,
    coalesce(tu.username, pa.username, ca.username, ma.username),
    po.title,
    coalesce(c.body, m.body),
    coalesce(po.id, c.post_id),
    coalesce(po.destination, cp.destination),
    c.event_id,
    (tu.id is not null or po.id is not null or c.id is not null or m.id is not null)
  from public.reports r
  left join public.profiles rp on rp.id = r.reporter_id
  left join public.profiles tu on r.target_type = 'user'    and (tu.id::text = r.target_id or tu.username = r.target_id)
  left join public.posts po    on r.target_type = 'post'    and po.id::text = r.target_id
  left join public.profiles pa on pa.id = po.author_id
  left join public.comments c  on r.target_type = 'comment' and c.id::text = r.target_id
  left join public.posts cp    on cp.id = c.post_id
  left join public.profiles ca on ca.id = c.author_id
  left join public.messages m  on r.target_type = 'message' and m.id::text = r.target_id
  left join public.profiles ma on ma.id = m.sender_id
  where private.is_admin()
    and (not open_only or r.status = 'open')
  order by r.created_at desc
  limit 200;
$$;

revoke execute on function public.admin_reports(boolean) from public, anon;
grant execute on function public.admin_reports(boolean) to authenticated;