-- ============================================================
-- CRWD SRFR — v1 database schema (Supabase / Postgres)
-- Run once in Supabase Dashboard → SQL Editor, top to bottom.
--
-- Replaces the phase 1 file. If you already ran phase 1,
-- uncomment and run this block first (dev data only):
--
--   drop trigger if exists on_auth_user_created on auth.users;
--   drop function if exists public.handle_new_user();
--   drop table if exists public.favorites;
--   drop table if exists public.profiles;
--
-- Contents
--   1. Tables
--   2. Helper functions
--   3. Triggers
--   4. Row-level security (who can read/write what)
--   5. Column-level write limits + table access for the Data API
--   6. Public views (privacy-filtered reads + counts)
--   7. RPC functions (message requests, post moderation)
--   8. Storage buckets (avatars, profile header images, post media)
--   9. Realtime
--  10. Lineup (ripples: updates about your posts/comments; waves helpers)
-- ============================================================


-- ============================================================
-- 1. TABLES
-- ============================================================

-- ---------- Profiles ----------
-- One row per user, created automatically at sign-up.
-- username = unique handle chosen at registration, used in profile URLs (/u/?kevin).
-- display_name = optional, free-form, not unique; set on the profile page, not at sign-up,
--   and shown only on the profile page. Everywhere else uses the username. Email is never stored here.
-- The show_* flags control what the public sees (enforced in section 6).
create table public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  username      text not null unique,
  display_name  text,                         -- null until the user sets one
  avatar_path   text,                         -- path inside the 'avatars' bucket
  hero_path     text,                         -- pro only: header image, path inside the 'profile-heroes' bucket
  status        text,                         -- shown as "Blurb" on the site (a line about you, on the profile page)
  bio           text,
  area          text,
  anthem_url    text,                         -- Spotify/YouTube/SoundCloud/Apple Music link
  anthem_title  text,                         -- e.g. "Song — Artist"
  links         jsonb not null default '[]',  -- up to 3: [{ "label": "...", "url": "https://..." }]
  about         jsonb not null default '{}',  -- About tab extras (best/worst/first, top 5, prompts, show history); rules in section 2
  show_display_name boolean not null default true,  -- no switch in Edit Profile (clear the field to hide it); always on
  show_status   boolean not null default true,  -- same
  show_anthem   boolean not null default true,
  show_about    boolean not null default true,  -- bio, links + About tab extras
  show_area     boolean not null default true,
  show_joined   boolean not null default true,  -- "Est. Oct 2026"
  show_follower_count boolean not null default true,  -- the hype/follower number (the followers themselves are never shown)
  show_posts    boolean not null default true,  -- the post list on their profile (board posts still show on the Board)
  show_hyped_shows  boolean not null default true,  -- the Hyped tab on their profile, one switch per kind
  show_hyped_acts   boolean not null default true,
  show_hyped_venues boolean not null default true,
  -- Settings page
  profile_visibility text not null default 'everyone',  -- everyone | members (signed in) | connections (accepted messages) | nobody
  message_requests   text not null default 'everyone',  -- everyone | nobody (they can still start conversations)
  email_message_requests boolean not null default true,  -- email preferences (sending is set up separately)
  email_new_messages     boolean not null default true,
  email_weekly_roundup   boolean not null default false, -- Max only (validate_profile)
  show_max_badge     boolean not null default true,     -- shows next to their username while they have Max
  username_changed_at timestamptz,                      -- set by validate_profile; one change per 30 days
  created_at    timestamptz not null default now(),

  constraint username_format     check (username ~ '^[a-z0-9_]{3,24}$'),
  constraint display_name_length check (char_length(display_name) between 1 and 40),
  constraint status_length       check (char_length(status) <= 140),
  constraint bio_length          check (char_length(bio) <= 300),
  constraint area_length         check (char_length(area) <= 40),
  -- Only links from services we know how to embed
  constraint anthem_provider     check (anthem_url ~ '^https://(open\.spotify\.com|(www\.|m\.|music\.)?youtube\.com|youtu\.be|soundcloud\.com|music\.apple\.com)/'),
  constraint anthem_title_length check (char_length(anthem_title) <= 100),
  constraint links_shape         check (jsonb_typeof(links) = 'array' and jsonb_array_length(links) <= 3),
  constraint profile_visibility_valid check (profile_visibility in ('everyone', 'members', 'connections', 'nobody')),
  constraint message_requests_valid   check (message_requests in ('everyone', 'nobody'))
);

-- ---------- Entitlements (account tier) ----------
-- Kept out of profiles so users can never upgrade themselves.
-- Written only by your payment webhook (service role). No row = free.
-- pro_until lets a lapsed subscription expire on its own.
create table public.entitlements (
  user_id    uuid primary key references public.profiles (id) on delete cascade,
  tier       text not null default 'free' check (tier in ('free', 'pro')),
  pro_until  timestamptz,
  updated_at timestamptz not null default now()
);

-- ---------- Admins ----------
-- Who can approve posts and read reports. Add yourself once in the dashboard:
--   insert into public.admins (user_id) values ('<your user id>');
create table public.admins (
  user_id uuid primary key references public.profiles (id) on delete cascade
);

-- ---------- Blocks ----------
-- A block hides both users from each other everywhere (profiles, posts, comments, DMs).
create table public.blocks (
  blocker_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  blocked_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint no_self_block check (blocker_id <> blocked_id)
);
create index blocks_blocked_idx on public.blocks (blocked_id);

-- ---------- Follows (hyping another user) ----------
-- Like Reddit: only a COUNT of followers is ever shown (public_profiles.follower_count).
-- Nobody, including the person being followed, can see who follows them.
create table public.follows (
  follower_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  followee_id uuid not null references public.profiles (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (follower_id, followee_id),
  constraint no_self_follow check (follower_id <> followee_id)
);
create index follows_followee_idx on public.follows (followee_id);

-- ---------- Item hypes (events, acts, venues) ----------
-- item_id = the id from events.json / acts.json / venues.json.
create table public.item_hypes (
  user_id    uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  kind       text not null check (kind in ('event', 'act', 'venue')),
  item_id    text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, kind, item_id)
);
create index item_hypes_item_idx on public.item_hypes (kind, item_id);

-- ---------- Posts (board + profile) ----------
-- destination 'board'   → shows on the Board page AND the author's profile
-- destination 'profile' → shows only on the author's profile
-- Every post starts 'pending' and is visible only to its author until an admin approves it
-- (trigger in section 3). Editing an approved post sends it back to 'pending'.
--
-- post_type 'shot' (1 photo/video) | 'gallery' (2+) | 'discussion' (text only)
-- media: [{ src, type: 'photo'|'video', caption?, thumb?, cover? }]  (rules in section 2)
--   src: "<author id>/…" in the post-media bucket, or "/board/…" (the site's own Board files)
-- hero: optional cover shown at the top of the post (same shape as one media entry)
create table public.posts (
  id          uuid primary key default gen_random_uuid(),
  author_id   uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  destination text not null check (destination in ('board', 'profile')),
  post_type   text not null default 'discussion',
  title       text not null,
  opener      text,                              -- optional text before the media
  media       jsonb not null default '[]',
  closer      text,                              -- optional text after the media
  hero        jsonb,
  venue_id    text,                              -- id from venues.json
  show_date   date,
  act_ids     text[] not null default '{}',      -- tagged acts: keys from acts.json
  act_names   text[] not null default '{}',      -- tagged acts not on the Acts page, as typed
  credit      text,                              -- e.g. "Photos by Sam" (imported posts)
  legacy_id   text,                              -- old board-media.json id, keeps old links working
  status      text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_at timestamptz,
  created_at  timestamptz not null default now(),
  edited_at   timestamptz,

  constraint post_type_valid  check (post_type in ('shot', 'gallery', 'discussion')),
  constraint title_length     check (char_length(trim(title)) between 1 and 120),
  constraint opener_length    check (char_length(opener) <= 4000),
  constraint closer_length    check (char_length(closer) <= 4000),
  constraint venue_id_format  check (venue_id ~ '^[a-z0-9-]{1,80}$'),
  constraint act_ids_valid    check (cardinality(act_ids) <= 10
                                     and array_to_string(act_ids, ',') ~ '^([a-z0-9-]{1,80}(,|$))*$'),
  constraint credit_length    check (char_length(credit) <= 80),
  constraint legacy_id_unique unique (legacy_id)
);
create index posts_author_idx     on public.posts (author_id, created_at desc);
create index posts_board_idx      on public.posts (destination, created_at desc) where status = 'approved';
create index posts_board_feed_idx on public.posts (created_at desc) where destination = 'board' and status = 'approved';
create index posts_pending_idx    on public.posts (created_at) where status = 'pending';

-- ---------- Post hypes ----------
create table public.post_hypes (
  user_id    uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  post_id    uuid not null references public.posts (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, post_id)
);
create index post_hypes_post_idx on public.post_hypes (post_id);

-- ---------- Comments (on posts or events) ----------
-- Exactly one target: post_id OR event_id.
create table public.comments (
  id         uuid primary key default gen_random_uuid(),
  author_id  uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  post_id    uuid references public.posts (id) on delete cascade,
  event_id   text,
  body       text not null,
  created_at timestamptz not null default now(),
  edited_at  timestamptz,

  constraint comment_length check (char_length(body) between 1 and 1000),
  constraint one_target     check (num_nonnulls(post_id, event_id) = 1)
);
create index comments_post_idx  on public.comments (post_id, created_at);
create index comments_event_idx on public.comments (event_id, created_at);

-- ---------- Direct messages ----------
-- 1:1 only, request-based:
--   1. Requester calls start_conversation() with a first message → status 'pending'
--   2. Recipient accepts or declines with respond_to_request()
--   3. Only 'accepted' conversations allow more messages, from either side
-- A declined request still looks 'pending' to the requester (see my_conversations),
-- so declining is never announced.
create table public.conversations (
  id           uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles (id) on delete cascade,
  status       text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  responded_at timestamptz,
  created_at   timestamptz not null default now()
);

create table public.conversation_members (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id         uuid not null references public.profiles (id) on delete cascade,
  last_read_at    timestamptz,          -- for unread badges
  left_at         timestamptz,          -- left the conversation (it's gone for them, read-only for the other person)
  primary key (conversation_id, user_id)
);
create index conversation_members_user_idx on public.conversation_members (user_id);

create table public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_id       uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  body            text not null,
  created_at      timestamptz not null default now(),
  constraint message_length check (char_length(body) between 1 and 2000)
);
create index messages_conversation_idx on public.messages (conversation_id, created_at);

-- ---------- Reports ----------
-- Users can file and see their own reports; you review them in the dashboard.
create table public.reports (
  id          uuid primary key default gen_random_uuid(),
  reporter_id uuid default auth.uid() references public.profiles (id) on delete set null,
  target_type text not null check (target_type in ('user', 'post', 'comment', 'message')),
  target_id   text not null,
  reason      text not null check (reason in ('spam', 'harassment', 'hate', 'impersonation', 'inappropriate', 'other')),
  details     text check (char_length(details) <= 1000),
  status      text not null default 'open' check (status in ('open', 'reviewed', 'actioned', 'dismissed')),
  created_at  timestamptz not null default now()
);


-- ============================================================
-- 2. HELPER FUNCTIONS
-- Kept in a "private" schema, which the Data API doesn't expose, so they can't
-- be called directly from the browser (e.g. to probe who has blocked whom).
-- Policies and views can still use them.
-- ============================================================

create schema private;
grant usage on schema private to anon, authenticated, service_role;

-- security definer = they can look at rows the caller can't,
-- so policies can ask "is this user pro / blocked / private?"

-- Usernames nobody can register
create function private.is_reserved_username(name text)
returns boolean
language sql immutable set search_path = ''
as $$
  select lower(name) = any (array[
    'admin', 'administrator', 'mod', 'moderator', 'support', 'help', 'staff', 'team',
    'crwdsrfr', 'crwd_srfr', 'crowdsurfer', 'official', 'root', 'system', 'null',
    'settings', 'messages', 'board', 'featured', 'events', 'acts', 'venues', 'u'
  ]) or lower(name) like 'user\_%';   -- user_ is for placeholders only
$$;

-- Reserved names are kept out by handle_new_user (sign-up) and validate_profile (renames).
-- The SQL editor can still assign one, e.g. "crwdsrfr" for the official account.

-- Post media rules (used by the posts constraints just below)
create function private.valid_media_src(src text, author uuid)
returns boolean
language sql immutable set search_path = ''
as $$
  select coalesce(src, '') ~ '^/board/[^\s"''<>]+$'
      or (coalesce(src, '') like author::text || '/%' and src !~ '\.\.');
$$;

create function private.valid_post_media(items jsonb, author uuid)
returns boolean
language sql immutable set search_path = ''
as $$
  select jsonb_typeof(items) = 'array'
     and jsonb_array_length(items) <= 30
     and not exists (
       select 1 from jsonb_array_elements(items) i
       where jsonb_typeof(i) <> 'object'
          or coalesce(i ->> 'type', '') not in ('photo', 'video')
          or not private.valid_media_src(i ->> 'src', author)
          or (i ? 'thumb' and not private.valid_media_src(i ->> 'thumb', author))
          or char_length(coalesce(i ->> 'caption', '')) > 1000
     );
$$;

-- Typed act names: 1–80 characters each, and no more than 10 acts in all
create function private.valid_act_names(names text[], ids text[])
returns boolean
language sql immutable set search_path = ''
as $$
  select cardinality(names) + cardinality(ids) <= 10
     and not exists (
       select 1 from unnest(names) n
       where n is null or char_length(trim(n)) not between 1 and 80
     );
$$;

alter table public.posts
  add constraint act_names_valid check (private.valid_act_names(act_names, act_ids)),
  add constraint media_valid check (private.valid_post_media(media, author_id)),
  add constraint hero_valid  check (hero is null or private.valid_post_media(jsonb_build_array(hero), author_id)),
  -- shot: exactly one photo/video · gallery: 2+ · discussion: text only (an opener), no media or cover
  add constraint post_shape check (
       (post_type = 'shot'       and jsonb_array_length(media) = 1 and hero is null)
    or (post_type = 'gallery'    and jsonb_array_length(media) >= 2)
    or (post_type = 'discussion' and jsonb_array_length(media) = 0 and hero is null
                                 and char_length(trim(coalesce(opener, ''))) > 0)
  );

-- Profile "About" tab extras (all optional), stored together in profiles.about:
--   { bwf: text (≤ 300) — "Best, Worst, First", one free-text answer,
--     top_artists: up to 5 strings (≤ 80 each; "" keeps a rank empty),
--     prompts: up to 5 [{ prompt (1–100), answer (1–500) }],
--     history: up to 500 [{ acts (1–200), venue? (≤ 80), date? 'YYYY-MM-DD' }] }
create function private.valid_profile_about(a jsonb)
returns boolean
language sql immutable set search_path = ''
as $$
  select jsonb_typeof(a) = 'object'
     and not exists (
       select 1 from jsonb_object_keys(a) k
       where k not in ('bwf', 'top_artists', 'prompts', 'history')
     )
     and (not a ? 'bwf' or (jsonb_typeof(a -> 'bwf') = 'string' and char_length(a ->> 'bwf') between 1 and 300))
     and (not a ? 'top_artists' or (
       jsonb_typeof(a -> 'top_artists') = 'array'
       and jsonb_array_length(a -> 'top_artists') <= 5
       and not exists (
         select 1 from jsonb_array_elements(a -> 'top_artists') x
         where jsonb_typeof(x) <> 'string' or char_length(x #>> '{}') > 80
       )
     ))
     and (not a ? 'prompts' or (
       jsonb_typeof(a -> 'prompts') = 'array'
       and jsonb_array_length(a -> 'prompts') <= 5
       and not exists (
         select 1 from jsonb_array_elements(a -> 'prompts') p
         where jsonb_typeof(p) <> 'object'
            or jsonb_typeof(p -> 'prompt') is distinct from 'string'
            or jsonb_typeof(p -> 'answer') is distinct from 'string'
            or char_length(p ->> 'prompt') not between 1 and 100
            or char_length(p ->> 'answer') not between 1 and 500
       )
     ))
     and (not a ? 'history' or (
       jsonb_typeof(a -> 'history') = 'array'
       and jsonb_array_length(a -> 'history') <= 500
       and not exists (
         select 1 from jsonb_array_elements(a -> 'history') h
         where jsonb_typeof(h) <> 'object'
            or jsonb_typeof(h -> 'acts') is distinct from 'string'
            or char_length(h ->> 'acts') not between 1 and 200
            or (h ? 'venue' and (jsonb_typeof(h -> 'venue') <> 'string' or char_length(h ->> 'venue') not between 1 and 80))
            or (h ? 'date' and coalesce(h ->> 'date', '') !~ '^\d{4}-\d{2}-\d{2}$')
       )
     ));
$$;

alter table public.profiles
  add constraint about_valid check (private.valid_profile_about(about));

-- Live "is this name free?" check for the registration form.
-- Call from JS: sb.rpc('username_available', { name: 'kevin' })
create function public.username_available(name text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce(lower(name), '') ~ '^[a-z0-9_]{3,24}$'
     and not private.is_reserved_username(name)
     and not exists (select 1 from public.profiles p where p.username = lower(name));
$$;

grant execute on function public.username_available(text) to anon, authenticated;

create function private.is_admin()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

create function private.is_pro(uid uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.entitlements e
    where e.user_id = uid
      and e.tier = 'pro'
      and (e.pro_until is null or e.pro_until > now())
  );
$$;

-- True if either user has blocked the other. Logged-out viewers (null) are never blocked.
create function private.blocked_between(a uuid, b uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select a is not null and b is not null and exists (
    select 1 from public.blocks
    where (blocker_id = a and blocked_id = b)
       or (blocker_id = b and blocked_id = a)
  );
$$;

-- Can the current viewer see this profile at all? (Settings → Privacy → Profile visibility)
create or replace function private.can_view_profile(owner uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce(owner = auth.uid(), false) or coalesce((
    select case p.profile_visibility
      when 'everyone' then true
      when 'members'  then auth.uid() is not null
      when 'connections' then exists (
        select 1
        from public.conversations c
        join public.conversation_members a on a.conversation_id = c.id and a.user_id = auth.uid() and a.left_at is null
        join public.conversation_members b on b.conversation_id = c.id and b.user_id = owner and b.left_at is null
        where c.status = 'accepted'
      )
      else false
    end
    from public.profiles p
    where p.id = owner
  ), false);
$$;

-- Does this user show a given profile section publicly?
create or replace function private.privacy_allows(owner uuid, section text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.can_view_profile(owner) and coalesce((
    select case section
      when 'posts' then p.show_posts
      when 'hypes:event' then p.show_hyped_shows
      when 'hypes:act'   then p.show_hyped_acts
      when 'hypes:venue' then p.show_hyped_venues
      else false
    end
    from public.profiles p
    where p.id = owner
  ), false);
$$;

-- Is the current user still in this conversation (not left)? (A function avoids a policy that queries its own table.)
create function private.is_member(conv uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.conversation_members
    where conversation_id = conv and user_id = auth.uid() and left_at is null
  );
$$;

-- Member of an ACCEPTED conversation nobody has left, AND not blocked by/blocking the other person.
create function private.can_send(conv uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.is_member(conv)
  and exists (select 1 from public.conversations c where c.id = conv and c.status = 'accepted')
  and not exists (
    select 1 from public.conversation_members m
    where m.conversation_id = conv
      and (m.left_at is not null
           or (m.user_id <> auth.uid() and private.blocked_between(auth.uid(), m.user_id)))
  );
$$;


-- ============================================================
-- 3. TRIGGERS
-- ============================================================

-- Create a profile at sign-up using the username from the registration form
-- (sent as signup metadata). Display name starts empty; it's set on the profile page. If the username is missing,
-- invalid, reserved, or was just taken by someone else, the account is still
-- created with a placeholder (user_xxxxxxxxxxxx) and the site asks them to
-- pick another. A taken name never makes sign-up fail.
create function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  placeholder text := 'user_' || substr(replace(new.id::text, '-', ''), 1, 12);
  wanted      text := lower(trim(coalesce(new.raw_user_meta_data ->> 'username', '')));
begin
  if public.username_available(wanted) then
    begin
      insert into public.profiles (id, username)
      values (new.id, wanted);
      return new;
    exception when unique_violation then
      null;  -- someone claimed it a moment ago; fall through to placeholder
    end;
  end if;

  insert into public.profiles (id, username)
  values (new.id, placeholder);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Profile edits: Max-only fields, the 30-day username limit + safe links.
-- The header image is the Max field (anthems and links are open to everyone).
-- Only checked when it CHANGES, so a lapsed pro can still edit the rest of their
-- profile. Their header image is kept but hidden (section 6) and comes back if they resubscribe.
create or replace function public.validate_profile()
returns trigger
language plpgsql set search_path = ''
as $$
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

  -- Turning the weekly roundup on needs Max (a lapsed member's setting is kept, but nothing is sent)
  if new.email_weekly_roundup and not old.email_weekly_roundup
     and not private.is_pro(new.id) then
    raise exception 'The weekly roundup is a Max feature';
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
$$;

create trigger before_profile_update
  before update on public.profiles
  for each row execute function public.validate_profile();

-- New posts start pending, whatever the browser sends (admins and the SQL editor excepted).
create function public.prepare_new_post()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if (select auth.uid()) is not null and not private.is_admin() then
    -- The New Post form allows 10; imported/admin posts can have more (up to 30)
    if jsonb_array_length(coalesce(new.media, '[]')) > 10 then
      raise exception 'too_many_media';
    end if;
    new.status      := 'pending';
    new.reviewed_at := null;
    new.legacy_id   := null;   -- only for imported posts
    new.created_at  := now();
  end if;
  return new;
end;
$$;

create trigger before_post_insert
  before insert on public.posts
  for each row execute function public.prepare_new_post();

-- Editing a post's content sends it back for review.
create function public.reset_post_review()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if (new.title, new.opener, new.closer, new.media, new.hero, new.post_type,
      new.venue_id, new.show_date, new.act_ids, new.act_names, new.credit)
     is distinct from
     (old.title, old.opener, old.closer, old.media, old.hero, old.post_type,
      old.venue_id, old.show_date, old.act_ids, old.act_names, old.credit) then
    new.status      := 'pending';
    new.reviewed_at := null;
    new.edited_at   := now();
  end if;
  return new;
end;
$$;

create trigger before_post_update
  before update on public.posts
  for each row execute function public.reset_post_review();

-- Blocking someone also removes follows in both directions.
create function public.handle_block()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  delete from public.follows
  where (follower_id = new.blocker_id and followee_id = new.blocked_id)
     or (follower_id = new.blocked_id and followee_id = new.blocker_id);
  return new;
end;
$$;

create trigger after_block
  after insert on public.blocks
  for each row execute function public.handle_block();


-- ============================================================
-- 4. ROW-LEVEL SECURITY
-- Every table has RLS on. No policy = no access (except the service role).
-- (select auth.uid()) is wrapped in a select so Postgres evaluates it once per query.
-- ============================================================

alter table public.profiles             enable row level security;
alter table public.admins               enable row level security;  -- no policies: dashboard only
alter table public.entitlements         enable row level security;
alter table public.blocks               enable row level security;
alter table public.follows              enable row level security;
alter table public.item_hypes           enable row level security;
alter table public.posts                enable row level security;
alter table public.post_hypes           enable row level security;
alter table public.comments             enable row level security;
alter table public.conversations        enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages             enable row level security;
alter table public.reports              enable row level security;

-- ---------- Profiles ----------
-- The raw table is owner-only. Everyone else reads public_profiles (section 6),
-- which applies the privacy toggles.
create policy "Owner reads own profile"
  on public.profiles for select to authenticated
  using ((select auth.uid()) = id);

create policy "Owner updates own profile"
  on public.profiles for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- ---------- Entitlements ----------
create policy "Owner reads own tier"
  on public.entitlements for select to authenticated
  using ((select auth.uid()) = user_id);

-- ---------- Blocks ----------
-- Only the blocker can see their block list; the blocked person isn't told.
create policy "Owner reads own blocks"
  on public.blocks for select to authenticated
  using ((select auth.uid()) = blocker_id);

create policy "Owner adds blocks"
  on public.blocks for insert to authenticated
  with check ((select auth.uid()) = blocker_id);

create policy "Owner removes blocks"
  on public.blocks for delete to authenticated
  using ((select auth.uid()) = blocker_id);

-- ---------- Follows ----------
-- You can see who YOU follow, never who follows you. Counts come from public_profiles.
create policy "Users read who they follow"
  on public.follows for select to authenticated
  using ((select auth.uid()) = follower_id);

create policy "Users follow others"
  on public.follows for insert to authenticated
  with check (
    (select auth.uid()) = follower_id
    and not private.blocked_between(follower_id, followee_id)
  );

-- Unfollow. (To shed an unwanted follower, block them: blocking removes the follow.)
create policy "Users unfollow"
  on public.follows for delete to authenticated
  using ((select auth.uid()) = follower_id);

-- ---------- Item hypes ----------
-- Users see only their own rows. Everyone else gets counts (item_stats) or,
-- for a profile's hype list, get_profile_hypes() — never "who hyped this act".
create policy "Users read own hypes"
  on public.item_hypes for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users add own hypes"
  on public.item_hypes for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users remove own hypes"
  on public.item_hypes for delete to authenticated
  using ((select auth.uid()) = user_id);

-- ---------- Posts ----------
-- Authors always see their own (any status). Everyone else sees approved posts only;
-- approved board posts are always public, profile posts follow show_posts.
-- Admins see everything, including the pending queue.
create policy "Read visible posts"
  on public.posts for select
  using (
    (select auth.uid()) = author_id
    or private.is_admin()
    or (
      status = 'approved'
      and not private.blocked_between((select auth.uid()), author_id)
      and (destination = 'board' or private.privacy_allows(author_id, 'posts'))
    )
  );

create policy "Users create own posts"
  on public.posts for insert to authenticated
  with check ((select auth.uid()) = author_id);

create policy "Users edit own posts"
  on public.posts for update to authenticated
  using ((select auth.uid()) = author_id)
  with check ((select auth.uid()) = author_id);

create policy "Users delete own posts; admins delete any"
  on public.posts for delete to authenticated
  using ((select auth.uid()) = author_id or private.is_admin());

-- ---------- Post hypes ----------
-- Who hyped a post: visible to the hyper and the post's author. Public counts via post_stats.
create policy "Read own hypes or hypes on my posts"
  on public.post_hypes for select to authenticated
  using (
    (select auth.uid()) = user_id
    or exists (
      select 1 from public.posts p
      where p.id = post_id and p.author_id = (select auth.uid())
    )
  );

-- Only approved posts you can see
create policy "Users hype visible posts"
  on public.post_hypes for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.posts p where p.id = post_id and p.status = 'approved')
  );

create policy "Users remove own post hypes"
  on public.post_hypes for delete to authenticated
  using ((select auth.uid()) = user_id);

-- ---------- Comments ----------
create policy "Read visible comments"
  on public.comments for select
  using (
    (select auth.uid()) = author_id
    or (
      not private.blocked_between((select auth.uid()), author_id)
      and (event_id is not null or exists (select 1 from public.posts p where p.id = post_id))
    )
  );

create policy "Users comment on events and visible posts"
  on public.comments for insert to authenticated
  with check (
    (select auth.uid()) = author_id
    and (
      event_id is not null
      or exists (select 1 from public.posts p where p.id = post_id and p.status = 'approved')
    )
  );

create policy "Users edit own comments"
  on public.comments for update to authenticated
  using ((select auth.uid()) = author_id)
  with check ((select auth.uid()) = author_id);

-- Authors can delete their comments; post authors can clear comments on their posts;
-- admins can delete any comment.
create policy "Delete own comments or comments on my posts"
  on public.comments for delete to authenticated
  using (
    (select auth.uid()) = author_id
    or private.is_admin()
    or exists (
      select 1 from public.posts p
      where p.id = post_id and p.author_id = (select auth.uid())
    )
  );

-- ---------- Conversations / members / messages ----------
-- No select policy on conversations: the inbox reads my_conversations (section 6),
-- which hides 'declined' from the requester.

create policy "Members read membership"
  on public.conversation_members for select to authenticated
  using (private.is_member(conversation_id));

-- Only for marking a conversation read (column limit in section 5)
create policy "Members update own read marker"
  on public.conversation_members for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Members read messages"
  on public.messages for select to authenticated
  using (private.is_member(conversation_id));

create policy "Members send messages"
  on public.messages for insert to authenticated
  with check (
    (select auth.uid()) = sender_id
    and private.can_send(conversation_id)
  );

-- ---------- Reports ----------
create policy "Users file reports"
  on public.reports for insert to authenticated
  with check ((select auth.uid()) = reporter_id and status = 'open');

create policy "Users read own reports; admins read all"
  on public.reports for select to authenticated
  using ((select auth.uid()) = reporter_id or private.is_admin());

create policy "Admins update report status"
  on public.reports for update to authenticated
  using (private.is_admin())
  with check (private.is_admin());


-- ============================================================
-- 5. COLUMN-LEVEL WRITE LIMITS
-- RLS controls which rows; these control which columns.
-- Stops users from changing ids, authors, dates, or destinations.
-- ============================================================

revoke update on public.profiles from anon, authenticated;
grant update (
  username, display_name, avatar_path, hero_path, status, bio, area,
  anthem_url, anthem_title, links, about,
  show_display_name, show_status, show_anthem, show_about, show_area, show_joined,
  show_follower_count, show_posts, show_hyped_shows, show_hyped_acts, show_hyped_venues,
  profile_visibility, message_requests, email_message_requests, email_new_messages,
  email_weekly_roundup, show_max_badge
) on public.profiles to authenticated;

-- status/reviewed_at aren't here: only moderate_post() (section 7) can approve.
revoke update on public.posts from anon, authenticated;
grant update (post_type, title, opener, media, closer, hero, venue_id, show_date, act_ids, act_names, credit)
  on public.posts to authenticated;

revoke update on public.reports from anon, authenticated;
grant update (status) on public.reports to authenticated;   -- admins only, via policy

revoke update on public.comments from anon, authenticated;
grant update (body, edited_at) on public.comments to authenticated;

revoke update on public.conversation_members from anon, authenticated;
grant update (last_read_at) on public.conversation_members to authenticated;



-- ============================================================
-- 5b. TABLE ACCESS FOR THE DATA API
-- New Supabase projects no longer expose tables automatically, so each
-- role gets exactly what it needs. RLS then decides which rows.
-- Tables not listed here (admins, conversations) aren't reachable from the browser.
-- ============================================================

-- Logged-out visitors: read posts and comments (RLS shows approved/public ones only)
grant select on public.posts, public.comments to anon;

-- Signed-in users
grant select                 on public.profiles, public.entitlements           to authenticated;
grant select, insert, delete on public.blocks, public.follows, public.item_hypes,
                                public.posts, public.post_hypes, public.comments to authenticated;
grant select                 on public.conversation_members                    to authenticated;
grant select, insert         on public.messages, public.reports                to authenticated;
-- (column-limited update grants are in section 5)

-- Server-side code with the secret key (e.g. your payment webhook writing entitlements)
grant all on all tables in schema public to service_role;

-- ============================================================
-- 6. PUBLIC VIEWS
-- These run with the table owner's rights (bypassing RLS) and apply
-- the privacy rules themselves. The Supabase linter flags this as
-- "security definer view" — that's expected here.
-- ============================================================

-- What anyone sees of a profile. Owners read their full row from profiles instead.
-- Hidden or not-yet-set fields come back as null; the header image (Max) is null for non-Max accounts.
-- A profile the viewer can't see (profile_visibility) comes back with only its username,
-- profile_visible = false, profile_visibility (so the page can say why), accepts_requests and max_badge.
create view public.public_profiles as
select
  p.id,
  p.username,
  case when v.ok and p.show_display_name then p.display_name end           as display_name,  -- only the profile page shows it
  case when v.ok then p.avatar_path end                                     as avatar_path,
  case when v.ok and private.is_pro(p.id) then p.hero_path end              as hero_path,
  v.ok and private.is_pro(p.id)                                             as is_pro,
  case when v.ok and p.show_status then p.status end                        as status,
  case when v.ok and p.show_anthem then p.anthem_url end                    as anthem_url,
  case when v.ok and p.show_anthem then p.anthem_title end                  as anthem_title,
  case when v.ok and p.show_about then p.bio end                            as bio,
  case when v.ok and p.show_about then p.links end                          as links,
  case when v.ok and p.show_area then p.area end                            as area,
  case when v.ok and p.show_joined then p.created_at end                    as joined_at,
  -- owners always see their own count, even when it's hidden from others
  case when v.ok and (p.show_follower_count or p.id = (select auth.uid())) then (
    select count(*) from public.follows f where f.followee_id = p.id
  ) end                                                                     as follower_count,
  v.ok and p.show_posts                                                     as posts_visible,  -- profile page: skip the post list when false
  v.ok and p.show_hyped_shows                                               as hyped_shows_visible,
  v.ok and p.show_hyped_acts                                                as hyped_acts_visible,
  v.ok and p.show_hyped_venues                                              as hyped_venues_visible,
  case when v.ok and p.show_about then p.about end                          as about,
  v.ok                                                                      as profile_visible,
  p.profile_visibility,
  p.message_requests = 'everyone'                                           as accepts_requests,
  private.is_pro(p.id) and p.show_max_badge                                 as max_badge
from public.profiles p
cross join lateral (select private.can_view_profile(p.id) as ok) v
where not private.blocked_between((select auth.uid()), p.id);

-- One row per conversation for the signed-in user (same columns as before, plus some at the end):
--   status          'pending' | 'accepted' | 'declined'. Declines are quiet: the sender sees 'pending'.
--                   ('declined' only shows to the person who declined.)
--   other_username  the other person
--   responded_at    when the request was accepted (or declined — only shown to the decliner)
--   other_left_at   when the other person left (the conversation is read-only after that)
--   updated_at      latest of: request sent, answered, last message, other person left
--   unread          something new since I last opened it (a message from them, my request
--                   accepted, or they left)
-- Conversations I left aren't listed.
create view public.my_conversations as
select
  c.id as conversation_id,
  other.user_id as other_user_id,
  c.requester_id = (select auth.uid()) as i_requested,
  case
    when c.status = 'declined' and c.requester_id = (select auth.uid()) then 'pending'
    else c.status
  end as status,
  me.last_read_at,
  (select max(m.created_at) from public.messages m where m.conversation_id = c.id) as last_message_at,
  c.created_at,
  p.username as other_username,
  v.responded_at,
  other.left_at as other_left_at,
  greatest(
    c.created_at,
    v.responded_at,
    other.left_at,
    (select max(m.created_at) from public.messages m where m.conversation_id = c.id)
  ) as updated_at,
  coalesce(
    exists (
      select 1 from public.messages m
      where m.conversation_id = c.id
        and m.sender_id = other.user_id
        and m.created_at > coalesce(me.last_read_at, '-infinity')
    )
    or (c.requester_id = (select auth.uid()) and c.status = 'accepted'
        and c.responded_at > coalesce(me.last_read_at, '-infinity'))
    or (other.left_at > coalesce(me.last_read_at, '-infinity')),
    false
  ) as unread
from public.conversations c
join public.conversation_members me
  on me.conversation_id = c.id and me.user_id = (select auth.uid())
join public.conversation_members other
  on other.conversation_id = c.id and other.user_id <> (select auth.uid())
join public.profiles p on p.id = other.user_id
cross join lateral (
  select case
    when c.status = 'declined' and c.requester_id = (select auth.uid()) then null  -- keep the decline quiet
    else c.responded_at
  end as responded_at
) v
where not private.blocked_between((select auth.uid()), other.user_id)
  and me.left_at is null;

-- Hype + comment counts per post
create view public.post_stats as
select
  p.id as post_id,
  (select count(*) from public.post_hypes h where h.post_id = p.id) as hype_count,
  (select count(*) from public.comments c where c.post_id = p.id)   as comment_count
from public.posts p;

-- Hype counts per event / act / venue (counts include private hypers, names don't)
create view public.item_stats as
select kind, item_id, count(*) as hype_count
from public.item_hypes
group by kind, item_id;

-- Comment counts per event
create view public.event_comment_stats as
select event_id, count(*) as comment_count
from public.comments
where event_id is not null
group by event_id;

grant select on public.public_profiles, public.post_stats, public.item_stats, public.event_comment_stats
  to anon, authenticated;
revoke all on public.my_conversations from anon;
grant select on public.my_conversations to authenticated;

-- A profile's hype list (events, acts, venues), respecting the show_hyped_* switches and blocks.
-- Call from JS: sb.rpc('get_profile_hypes', { profile_id: '<uuid>' })
create function public.get_profile_hypes(profile_id uuid)
returns table (kind text, item_id text, created_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  select h.kind, h.item_id, h.created_at
  from public.item_hypes h
  where h.user_id = profile_id
    and (
      profile_id = auth.uid()
      or (private.privacy_allows(profile_id, 'hypes:' || h.kind)
          and not private.blocked_between(auth.uid(), profile_id))
    )
  order by h.created_at desc;
$$;


-- ============================================================
-- 7. RPC FUNCTIONS (called from JS with sb.rpc)
-- ============================================================

-- ---------- Message requests ----------
-- sb.rpc('start_conversation', { other_user: '<uuid>', first_message: 'Hey!' })
-- Sends a request with one message. Returns the conversation id.
-- If the other person already sent YOU a request, this accepts it instead.
-- New requests to someone with message_requests = 'nobody' are refused.
-- A conversation either person left doesn't count: a new request starts a fresh one.
create function public.start_conversation(other_user uuid, first_message text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  me   uuid := auth.uid();
  conv public.conversations%rowtype;
begin
  if me is null then
    raise exception 'Sign in to send messages';
  end if;
  if other_user = me then
    raise exception 'You cannot message yourself';
  end if;
  if not exists (select 1 from public.profiles where id = other_user)
     or private.blocked_between(me, other_user) then
    raise exception 'User not found';   -- same message for both, so blocks aren't revealed
  end if;
  if char_length(coalesce(trim(first_message), '')) not between 1 and 2000 then
    raise exception 'Message must be 1–2000 characters';
  end if;

  -- Existing 1:1 conversation between these two that nobody has left?
  select c.* into conv
  from public.conversations c
  join public.conversation_members a on a.conversation_id = c.id and a.user_id = me
  join public.conversation_members b on b.conversation_id = c.id and b.user_id = other_user
  where a.left_at is null and b.left_at is null
  limit 1;

  if conv.id is null then
    if exists (select 1 from public.profiles where id = other_user and message_requests = 'nobody') then
      raise exception 'This member isn''t accepting message requests';
    end if;
    insert into public.conversations (requester_id) values (me) returning * into conv;
    insert into public.conversation_members (conversation_id, user_id)
    values (conv.id, me), (conv.id, other_user);

  elsif conv.status = 'accepted' then
    null;  -- already chatting; just send the message below

  elsif conv.requester_id = me then
    -- Already asked (pending, or quietly declined): no follow-up messages until accepted
    raise exception 'Your message request is waiting for a reply';

  else
    -- They requested me earlier; messaging back counts as accepting
    update public.conversations
    set status = 'accepted', responded_at = now()
    where id = conv.id;
  end if;

  insert into public.messages (conversation_id, sender_id, body)
  values (conv.id, me, trim(first_message));

  return conv.id;
end;
$$;

-- sb.rpc('respond_to_request', { conversation: '<uuid>', accept: true })
-- Only the recipient of a pending request can answer it.
create function public.respond_to_request(conversation uuid, accept boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.conversations c
  set status = case when accept then 'accepted' else 'declined' end,
      responded_at = now()
  where c.id = conversation
    and c.status = 'pending'
    and c.requester_id <> auth.uid()
    and private.is_member(c.id);

  if not found then
    raise exception 'No pending request to respond to';
  end if;
end;
$$;

-- sb.rpc('cancel_request', { conversation: '<uuid>' })
-- The sender takes back a request that hasn't been accepted. It's deleted (with its message).
create function public.cancel_request(conversation uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  delete from public.conversations c
  where c.id = conversation
    and c.requester_id = auth.uid()
    and c.status in ('pending', 'declined');   -- a quiet decline still looks pending to the sender

  if not found then
    raise exception 'No request to cancel';
  end if;
end;
$$;

-- sb.rpc('leave_conversation', { conversation: '<uuid>' })
-- Leave an accepted conversation. Once both people have left, it's deleted.
create function public.leave_conversation(conversation uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.conversation_members m
  set left_at = now()
  where m.conversation_id = conversation
    and m.user_id = auth.uid()
    and m.left_at is null
    and exists (select 1 from public.conversations c where c.id = conversation and c.status = 'accepted');

  if not found then
    raise exception 'No conversation to leave';
  end if;

  delete from public.conversations c
  where c.id = conversation
    and not exists (
      select 1 from public.conversation_members m
      where m.conversation_id = c.id and m.left_at is null
    );
end;
$$;

-- ---------- Post moderation (admins only) ----------
-- sb.rpc('moderate_post', { post: '<uuid>', decision: 'approved' })   -- or 'rejected'
-- The pending queue is just: sb.from('posts').select('*').eq('status', 'pending')
create function public.moderate_post(post uuid, decision text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'Not allowed';
  end if;
  if decision not in ('approved', 'rejected') then
    raise exception 'Decision must be approved or rejected';
  end if;

  update public.posts
  set status = decision, reviewed_at = now()
  where id = post;

  if not found then
    raise exception 'Post not found';
  end if;
end;
$$;

-- Functions are runnable by everyone unless revoked from "public" too
revoke execute on function public.start_conversation(uuid, text)   from public, anon;
revoke execute on function public.respond_to_request(uuid, boolean) from public, anon;
revoke execute on function public.moderate_post(uuid, text)         from public, anon;
grant execute on function public.start_conversation(uuid, text)    to authenticated;
grant execute on function public.respond_to_request(uuid, boolean)  to authenticated;
grant execute on function public.moderate_post(uuid, text)          to authenticated;
revoke execute on function public.cancel_request(uuid)     from public, anon;
revoke execute on function public.leave_conversation(uuid) from public, anon;
grant execute on function public.cancel_request(uuid)      to authenticated;
grant execute on function public.leave_conversation(uuid)  to authenticated;


-- The signed-in user's own block list, with usernames (the blocked person's profile is
-- otherwise hidden from them). Used to show "You blocked @x · Unblock" and for Settings.
-- Call from JS: sb.rpc('my_blocked_users')
create or replace function public.my_blocked_users()
returns table (user_id uuid, username text, blocked_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  select b.blocked_id, p.username, b.created_at
  from public.blocks b
  join public.profiles p on p.id = b.blocked_id
  where b.blocker_id = auth.uid()
  order by b.created_at desc;
$$;

-- Functions are runnable by everyone unless revoked from "public" too
revoke execute on function public.my_blocked_users() from public, anon;
grant execute on function public.my_blocked_users() to authenticated;


-- Download My Data (Settings → Account)
-- -- sb.rpc('export_my_data') → one JSON object with everything tied to the signed-in account.
create or replace function public.export_my_data()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with me as (select auth.uid() as id)
  select case when (select id from me) is null then null else jsonb_build_object(
    'exported_at', now(),
    'account', (select jsonb_build_object('email', u.email, 'created_at', u.created_at)
                from auth.users u where u.id = (select id from me)),
    'profile', (select to_jsonb(p) from public.profiles p where p.id = (select id from me)),
    'membership', (select jsonb_build_object('tier', e.tier, 'max_until', e.pro_until)
                   from public.entitlements e where e.user_id = (select id from me)),
    'posts', coalesce((select jsonb_agg(to_jsonb(x) - 'author_id' order by x.created_at)
                       from public.posts x where x.author_id = (select id from me)), '[]'),
    'comments', coalesce((select jsonb_agg(jsonb_build_object('post_id', c.post_id, 'event_id', c.event_id,
                            'body', c.body, 'created_at', c.created_at, 'edited_at', c.edited_at) order by c.created_at)
                          from public.comments c where c.author_id = (select id from me)), '[]'),
    'hyped', coalesce((select jsonb_agg(jsonb_build_object('kind', h.kind, 'id', h.item_id, 'created_at', h.created_at) order by h.created_at)
                       from public.item_hypes h where h.user_id = (select id from me)), '[]'),
    'hyped_posts', coalesce((select jsonb_agg(jsonb_build_object('post_id', h.post_id, 'created_at', h.created_at) order by h.created_at)
                             from public.post_hypes h where h.user_id = (select id from me)), '[]'),
    'hyped_members', coalesce((select jsonb_agg(jsonb_build_object('username', p.username, 'created_at', f.created_at) order by f.created_at)
                               from public.follows f join public.profiles p on p.id = f.followee_id
                               where f.follower_id = (select id from me)), '[]'),
    'blocked', coalesce((select jsonb_agg(jsonb_build_object('username', p.username, 'created_at', b.created_at) order by b.created_at)
                         from public.blocks b join public.profiles p on p.id = b.blocked_id
                         where b.blocker_id = (select id from me)), '[]'),
    'conversations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'with', (select p.username from public.conversation_members o join public.profiles p on p.id = o.user_id
                 where o.conversation_id = c.id and o.user_id <> (select id from me) limit 1),
        'status', c.status,
        'started_by_me', c.requester_id = (select id from me),
        'created_at', c.created_at,
        'messages', coalesce((select jsonb_agg(jsonb_build_object(
                       'from', case when m.sender_id = (select id from me) then 'me' else 'them' end,
                       'body', m.body, 'created_at', m.created_at) order by m.created_at)
                     from public.messages m where m.conversation_id = c.id), '[]')
      ) order by c.created_at)
      from public.conversations c
      join public.conversation_members mine on mine.conversation_id = c.id and mine.user_id = (select id from me)
    ), '[]'),
    'reports', coalesce((select jsonb_agg(jsonb_build_object('type', r.target_type, 'target', r.target_id,
                           'reason', r.reason, 'details', r.details, 'status', r.status, 'created_at', r.created_at) order by r.created_at)
                         from public.reports r where r.reporter_id = (select id from me)), '[]')
  ) end;
$$;

revoke execute on function public.export_my_data() from public, anon;
grant execute on function public.export_my_data() to authenticated;


-- ============================================================
-- 8. STORAGE BUCKETS
-- Files go in a folder named after the user's id: avatars/<uid>/photo.webp
-- (profile-heroes holds pro header images; written only by pro accounts, enforced by validate_profile)
-- Public buckets: anyone with the URL can view; only the owner can write.
-- ============================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('avatars',    'avatars',    true, 2097152,  array['image/jpeg', 'image/png', 'image/webp']),
  ('profile-heroes', 'profile-heroes', true, 5242880, array['image/jpeg', 'image/png', 'image/webp']),
  ('post-media', 'post-media', true, 52428800,  -- 50 MB: Board shots can be videos
   array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'video/quicktime']);

create policy "Users read own uploads"
  on storage.objects for select to authenticated
  using (
    bucket_id in ('avatars', 'profile-heroes', 'post-media')
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "Users upload to own folder"
  on storage.objects for insert to authenticated
  with check (
    bucket_id in ('avatars', 'profile-heroes', 'post-media')
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "Users replace own uploads"
  on storage.objects for update to authenticated
  using (
    bucket_id in ('avatars', 'profile-heroes', 'post-media')
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id in ('avatars', 'profile-heroes', 'post-media')
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "Users delete own uploads"
  on storage.objects for delete to authenticated
  using (
    bucket_id in ('avatars', 'profile-heroes', 'post-media')
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );


-- ============================================================
-- 9. REALTIME
-- New messages push to open chats (RLS still applies).
-- ============================================================

alter publication supabase_realtime add table public.messages;


-- ============================================================
-- 10. LINEUP
-- Ripples: updates about your own posts and comments (made by triggers).
-- Waves: followed_hypes() for what the members you hype are hyping.
-- ============================================================

-- ---------- Tables ----------
create table if not exists public.ripples (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,   -- who it's for
  kind        text not null check (kind in ('post_hype', 'post_comment', 'commented_post', 'event_comment')),
  post_id     uuid references public.posts (id) on delete cascade,
  event_id    text,
  target      text not null,                         -- the post id or show id (one card per target + kind)
  actor_ids   uuid[] not null default '{}',          -- who did it, newest first (up to 3)
  actor_count integer not null default 0,            -- how many times since it showed up
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint ripple_one_target check (num_nonnulls(post_id, event_id) = 1),
  constraint ripple_unique unique (user_id, kind, target)
);
create index if not exists ripples_user_idx on public.ripples (user_id, updated_at desc);

create table if not exists public.ripple_mutes (
  user_id    uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  kind       text not null check (kind in ('post_hype', 'post_comment', 'commented_post', 'event_comment')),
  target     text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, kind, target)
);

alter table public.ripples      enable row level security;
alter table public.ripple_mutes enable row level security;

drop policy if exists "Owner reads own ripples" on public.ripples;
create policy "Owner reads own ripples"
  on public.ripples for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Owner dismisses own ripples" on public.ripples;
create policy "Owner dismisses own ripples"
  on public.ripples for delete to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Owner reads own mutes" on public.ripple_mutes;
create policy "Owner reads own mutes"
  on public.ripple_mutes for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Owner adds mutes" on public.ripple_mutes;
create policy "Owner adds mutes"
  on public.ripple_mutes for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Owner removes mutes" on public.ripple_mutes;
create policy "Owner removes mutes"
  on public.ripple_mutes for delete to authenticated
  using ((select auth.uid()) = user_id);

-- Read + dismiss only; ripples are made by the triggers below
grant select, delete         on public.ripples      to authenticated;
grant select, insert, delete on public.ripple_mutes to authenticated;
grant all on public.ripples, public.ripple_mutes to service_role;

-- ---------- Making ripples ----------
-- Adds to (or starts) the recipient's card for this target + kind.
create or replace function private.add_ripple(recipient uuid, k text, post uuid, ev text, actor uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  t text := coalesce(post::text, ev);
begin
  if recipient is null or actor is null or recipient = actor then return; end if;
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

-- Someone hyped a post → its author
create or replace function public.ripple_on_post_hype()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.add_ripple(p.author_id, 'post_hype', p.id, null, new.user_id)
  from public.posts p where p.id = new.post_id;
  return new;
end;
$$;

-- Someone commented → the post's author, and everyone else who commented on that post (or show)
create or replace function public.ripple_on_comment()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  post_author uuid;
  other uuid;
begin
  if new.post_id is not null then
    select author_id into post_author from public.posts where id = new.post_id;
    perform private.add_ripple(post_author, 'post_comment', new.post_id, null, new.author_id);
    for other in
      select distinct c.author_id from public.comments c
      where c.post_id = new.post_id and c.id <> new.id
        and c.author_id <> new.author_id and c.author_id is distinct from post_author
    loop
      perform private.add_ripple(other, 'commented_post', new.post_id, null, new.author_id);
    end loop;
  else
    for other in
      select distinct c.author_id from public.comments c
      where c.event_id = new.event_id and c.id <> new.id and c.author_id <> new.author_id
    loop
      perform private.add_ripple(other, 'event_comment', null, new.event_id, new.author_id);
    end loop;
  end if;
  return new;
end;
$$;

drop trigger if exists after_post_hype_ripple on public.post_hypes;
create trigger after_post_hype_ripple
  after insert on public.post_hypes
  for each row execute function public.ripple_on_post_hype();

drop trigger if exists after_comment_ripple on public.comments;
create trigger after_comment_ripple
  after insert on public.comments
  for each row execute function public.ripple_on_comment();

-- ---------- Reading them ----------
-- The signed-in user's ripples, newest first, with what the page needs to show them:
--   actor_usernames  up to 3 people, newest first (blocked people left out)
--   actor_count      how many times in all (e.g. "@a, @b and 3 others")
--   post_title / post_destination / post_author_username  for the link to the post
-- Muted and expired (90 days) ones are left out.
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
  );

revoke all on public.my_ripples from anon;
grant select on public.my_ripples to authenticated;

-- ---------- Waves: what your SRFRs hyped ----------
-- sb.rpc('followed_hypes', { since: '<iso time>' })
-- Act and venue hypes by members you hype, newest first (up to 500), only where they
-- share that list and you can see their profile.
create or replace function public.followed_hypes(since timestamptz)
returns table (user_id uuid, username text, kind text, item_id text, created_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  select h.user_id, p.username, h.kind, h.item_id, h.created_at
  from public.follows f
  join public.item_hypes h on h.user_id = f.followee_id
  join public.profiles p on p.id = h.user_id
  where f.follower_id = auth.uid()
    and h.kind in ('act', 'venue')
    and h.created_at >= since
    and private.privacy_allows(h.user_id, 'hypes:' || h.kind)
    and not private.blocked_between(auth.uid(), h.user_id)
  order by h.created_at desc
  limit 500;
$$;

revoke execute on function public.followed_hypes(timestamptz) from public, anon;
grant execute on function public.followed_hypes(timestamptz) to authenticated;

-- ---------- Email preference ----------
alter table public.profiles add column if not exists email_ripples boolean not null default true;
grant update (email_ripples) on public.profiles to authenticated;
