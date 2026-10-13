-- LearnX database schema
-- Neon / Supabase / kisi bhi Postgres pe chalega.
-- Isse apne DB console (Neon SQL editor / Supabase SQL editor) me ek baar
-- paste karke run kar do — ye saari tables ban jaayengi.

create extension if not exists pgcrypto;

-- Users: email/password aur Google dono se login support karta hai
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text unique not null,
  password_hash text,           -- null agar sirf Google se signup kiya
  google_id text unique,        -- null agar sirf email/password se signup kiya
  avatar_url text,
  created_at timestamptz default now()
);

-- Har user ka progress/notes/xp/streak — ek hi JSONB row, fast aur simple
create table if not exists user_state (
  user_id uuid primary key references users(id) on delete cascade,
  progress jsonb default '{}',
  notes jsonb default '{}',
  bookmarks jsonb default '[]',
  flashcards jsonb default '[]',
  quiz_scores jsonb default '{}',
  xp integer default 0,
  streak jsonb default '{"count":0,"lastDate":null,"days":{}}',
  settings jsonb default '{}',
  updated_at timestamptz default now()
);

-- AI chat conversations. id text hai kyunki frontend khud id generate karta
-- hai (jaise "chat_1699999999").
create table if not exists chats (
  id text primary key,
  user_id uuid references users(id) on delete cascade,
  title text default 'New conversation',
  messages jsonb default '[]',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_chats_user on chats(user_id);

-- AI chat rate-limiting (per user, per minute)
create table if not exists rate_limits (
  user_id uuid not null,
  window_start timestamptz not null,
  count integer not null default 1,
  primary key (user_id, window_start)
);

-- Origin Play: video files stay in each creator's Google Drive; only metadata lives here.
create table if not exists videos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 160),
  description text not null default '',
  drive_file_id text not null unique,
  mime_type text not null,
  size_bytes bigint not null default 0 check (size_bytes >= 0),
  view_count bigint not null default 0 check (view_count >= 0),
  created_at timestamptz not null default now()
);
create index if not exists idx_videos_feed on videos(created_at desc);
create index if not exists idx_videos_owner on videos(user_id, created_at desc);

create table if not exists video_follows (
  user_id uuid not null references users(id) on delete cascade,
  channel_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, channel_id),
  check (user_id <> channel_id)
);
create index if not exists idx_video_follows_channel on video_follows(channel_id);

create table if not exists video_messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references users(id) on delete cascade,
  recipient_id uuid not null references users(id) on delete cascade,
  message text not null check (char_length(message) between 1 and 2000),
  created_at timestamptz not null default now(),
  check (sender_id <> recipient_id)
);
create index if not exists idx_video_messages_pair on video_messages(sender_id, recipient_id, created_at desc);

-- Profile picture: chhoti JPEG (client 256x256 me resize karke bhejta hai, ~20KB)
alter table users add column if not exists avatar_data bytea;
