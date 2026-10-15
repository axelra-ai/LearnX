-- LearnX schema for Supabase Postgres, including private Realtime policies.

create extension if not exists pgcrypto;

-- Users: Google sign-in; password_hash remains nullable for old-schema compatibility.
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text unique not null,
  password_hash text,
  google_id text unique,
  avatar_url text,
  drive_refresh_token text,
  created_at timestamptz default now()
);
alter table users add column if not exists drive_refresh_token text;
update users set password_hash = null where password_hash is not null;

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
  thumbnail_file_id text null,
  mime_type text not null,
  size_bytes bigint not null default 0 check (size_bytes >= 0),
  view_count bigint not null default 0 check (view_count >= 0),
  created_at timestamptz not null default now()
);
-- Purani videos table me ye columns nahi hote; "create table if not exists" unhe add nahi karta.
alter table videos add column if not exists thumbnail_file_id text;
alter table videos add column if not exists description text not null default '';
alter table videos add column if not exists mime_type text not null default 'video/mp4';
alter table videos add column if not exists size_bytes bigint not null default 0;
alter table videos add column if not exists view_count bigint not null default 0;
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
create index if not exists idx_video_messages_recipient_pair on video_messages(recipient_id, sender_id, created_at desc);

-- Short-lived online and typing state for direct messages.
create table if not exists video_presence (
  user_id uuid primary key references users(id) on delete cascade,
  last_seen timestamptz not null default now(),
  typing_to uuid references users(id) on delete set null,
  typing_until timestamptz
);

-- Direct-message content lives in a shared Google Drive folder; only routing metadata stays here.
create table if not exists video_conversations (
  id uuid primary key default gen_random_uuid(),
  participant_one_id uuid not null references users(id) on delete cascade,
  participant_two_id uuid not null references users(id) on delete cascade,
  drive_folder_id text not null unique,
  last_message_preview varchar(160),
  last_sender_id uuid references users(id) on delete set null,
  last_read_one_at timestamptz,
  last_read_two_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (participant_one_id < participant_two_id),
  unique (participant_one_id, participant_two_id)
);
alter table video_conversations add column if not exists last_message_preview varchar(160);
alter table video_conversations add column if not exists last_sender_id uuid references users(id) on delete set null;
alter table video_conversations add column if not exists last_read_one_at timestamptz;
alter table video_conversations add column if not exists last_read_two_at timestamptz;
create index if not exists idx_video_conversations_one on video_conversations(participant_one_id, updated_at desc);
create index if not exists idx_video_conversations_two on video_conversations(participant_two_id, updated_at desc);

-- Supabase Realtime Broadcast is private and limited to actual conversation participants.
drop policy if exists learnx_chat_receive on realtime.messages;
create policy learnx_chat_receive on realtime.messages
  for select to authenticated
  using (
    extension = 'broadcast'
    and exists (
      select 1 from public.video_conversations c
      where realtime.topic() = 'learnx-chat:' || c.participant_one_id::text || ':' || c.participant_two_id::text
        and auth.uid() in (c.participant_one_id, c.participant_two_id)
    )
  );
drop policy if exists learnx_chat_send on realtime.messages;
create policy learnx_chat_send on realtime.messages
  for insert to authenticated
  with check (
    extension = 'broadcast'
    and exists (
      select 1 from public.video_conversations c
      where realtime.topic() = 'learnx-chat:' || c.participant_one_id::text || ':' || c.participant_two_id::text
        and auth.uid() in (c.participant_one_id, c.participant_two_id)
    )
  );

-- Legacy profile photo bytes; new uploads are stored in Google Drive.
alter table users add column if not exists avatar_data bytea;

-- Web Push subscriptions (har device ka ek endpoint) — chat notifications ke liye.
create table if not exists push_subscriptions (
  endpoint text primary key,
  user_id uuid not null references users(id) on delete cascade,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_push_subscriptions_user on push_subscriptions(user_id);
