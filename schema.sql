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
