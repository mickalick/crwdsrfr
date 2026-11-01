-- ============================================================
-- CRWD SRFR — Settings → Notifications
-- (run after 20261027180010_crwdsrfr_v1_schema and 20261028182605_admin_tools)
--
--   Ripples      one on/off per ripple type (profiles.ripple_*). Off = no new ripples of that
--                type are made for you, and the ones you already have are hidden from the
--                Lineup (they come back if you turn it on again, until they expire at 90 days).
--   Messages     whether the "new" dot shows for message requests / conversation updates
--                (profiles.dot_message_*). The Messages page itself still marks what's unread.
--   Email        the Hype Report (Max only), formerly the Weekly Roundup:
--                  email_weekly_roundup → email_hype_report (renamed; everyone's choice is kept)
--                  hype_report_day ('mon' … 'sun', default 'sun') — the day it's sent
--
-- profiles.email_ripples is left in place, no longer shown in Settings.
-- ============================================================


-- ---------- 1. Settings columns ----------
alter table public.profiles
  add column if not exists ripple_post_hype      boolean not null default true,  -- hypes on my posts
  add column if not exists ripple_post_comment   boolean not null default true,  -- comments on my posts
  add column if not exists ripple_commented_post boolean not null default true,  -- new comments on posts I commented on
  add column if not exists ripple_event_comment  boolean not null default true,  -- new comments on shows I commented on
  add column if not exists dot_message_requests  boolean not null default true,  -- "new" dot for message requests
  add column if not exists dot_message_updates   boolean not null default true;  -- "new" dot for conversation updates

-- Weekly Roundup → Hype Report. Renaming (not add + drop) keeps each member's choice.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'profiles' and column_name = 'email_weekly_roundup') then
    alter table public.profiles rename column email_weekly_roundup to email_hype_report;
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'profiles' and column_name = 'surf_report_day') then
    alter table public.profiles rename column surf_report_day to hype_report_day;
  end if;
end;
$$;
alter table public.profiles add column if not exists hype_report_day text not null default 'sun';

alter table public.profiles drop constraint if exists surf_report_day_valid;
alter table public.profiles drop constraint if exists hype_report_day_valid;
alter table public.profiles add constraint hype_report_day_valid
  check (hype_report_day in ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'));

-- Members can change their own (the table is otherwise update-by-column only).
-- (Renamed columns keep their grants; listing them again is harmless.)
grant update (
  ripple_post_hype, ripple_post_comment, ripple_commented_post, ripple_event_comment,
  dot_message_requests, dot_message_updates, email_hype_report, hype_report_day
) on public.profiles to authenticated;

-- ---------- 1b. validate_profile: the Max check uses the new column name ----------
-- Same as before except the Hype Report lines.
create or replace function public.validate_profile()
returns trigger
language plpgsql set search_path = ''
as $fn$
begin
  -- Renames follow the same rules as registration (placeholders can't be picked by hand).
  -- (select auth.uid()) is null only in the SQL editor / server code, never for a signed-in user.
  if new.username is distinct from old.username
     and private.is_reserved_username(new.username)
     and (select auth.uid()) is not null then
    raise exception 'That username isn''t available';
  end if;

  -- One username change every 30 days. Replacing a placeholder (user_…) is free.
  if new.username is distinct from old.username
     and (select auth.uid()) is not null
     and old.username !~ '^user_[0-9a-f]{12}$' then
    if old.username_changed_at > now() - interval '30 days' then
      raise exception 'You can change your username again on %',
        to_char(old.username_changed_at + interval '30 days', 'FMMonth FMDD, YYYY');
    end if;
    new.username_changed_at := now();
  end if;

  if not private.is_pro(new.id)
     and new.hero_path is not null and new.hero_path is distinct from old.hero_path then
    raise exception 'Custom header images are a Max feature';
  end if;

  -- Turning the Hype Report on needs Max (a lapsed member's setting is kept, but nothing is sent)
  if new.email_hype_report and not old.email_hype_report
     and not private.is_pro(new.id) then
    raise exception 'The Hype Report is a Max feature';
  end if;

  -- Every link needs a label and an https:// URL (blocks javascript: links)
  if exists (
    select 1 from jsonb_array_elements(new.links) l
    where coalesce(l ->> 'url', '') !~ '^https://'
       or char_length(coalesce(l ->> 'label', '')) not between 1 and 40
  ) then
    raise exception 'Each link needs a label (1–40 characters) and an https:// URL';
  end if;

  return new;
end;
$fn$;

-- ---------- 2. Is this ripple type on for this person? ----------
create or replace function private.ripple_kind_on(who uuid, k text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select case k
      when 'post_hype'      then p.ripple_post_hype
      when 'post_comment'   then p.ripple_post_comment
      when 'commented_post' then p.ripple_commented_post
      when 'event_comment'  then p.ripple_event_comment
      else true                       -- a new type nobody has a setting for yet: on
    end
    from public.profiles p where p.id = who
  ), true);
$$;

-- ---------- 3. Don't make ripples of a type the recipient turned off ----------
-- Same as before, plus the ripple_kind_on check.
create or replace function private.add_ripple(recipient uuid, k text, post uuid, ev text, actor uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  t text := coalesce(post::text, ev);
begin
  if recipient is null or actor is null or recipient = actor then return; end if;
  if not private.ripple_kind_on(recipient, k) then return; end if;
  if private.blocked_between(recipient, actor) then return; end if;
  if exists (select 1 from public.ripple_mutes m where m.user_id = recipient and m.kind = k and m.target = t) then return; end if;

  -- Cleanup: their ripples nobody dismissed in 90 days
  delete from public.ripples where user_id = recipient and updated_at < now() - interval '90 days';

  insert into public.ripples (user_id, kind, post_id, event_id, target, actor_ids, actor_count)
  values (recipient, k, post, ev, t, array[actor], 1)
  on conflict (user_id, kind, target) do update
    set actor_ids   = (array[actor] || array_remove(public.ripples.actor_ids, actor))[1:3],
        actor_count = public.ripples.actor_count + 1,
        updated_at  = now();
end;
$$;

-- ---------- 4. Hide ripples of a type that's turned off ----------
-- Same view as before, plus the last condition. (The Lineup page and the header's "new" dot
-- both read this view, so both follow the setting.)
create or replace view public.my_ripples as
select
  r.id,
  r.kind,
  r.post_id,
  r.event_id,
  r.actor_count,
  r.created_at,
  r.updated_at,
  coalesce((
    select array_agg(p.username order by a.ord)
    from unnest(r.actor_ids) with ordinality a(uid, ord)
    join public.profiles p on p.id = a.uid
    where not private.blocked_between((select auth.uid()), a.uid)
  ), '{}') as actor_usernames,
  po.title       as post_title,
  po.destination as post_destination,
  au.username    as post_author_username
from public.ripples r
left join public.posts po on po.id = r.post_id
left join public.profiles au on au.id = po.author_id
where r.user_id = (select auth.uid())
  and r.updated_at > now() - interval '90 days'
  and not exists (
    select 1 from public.ripple_mutes m
    where m.user_id = r.user_id and m.kind = r.kind and m.target = r.target
  )
  and private.ripple_kind_on(r.user_id, r.kind);

revoke all on public.my_ripples from anon;
grant select on public.my_ripples to authenticated;

