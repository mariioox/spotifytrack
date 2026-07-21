-- Run this in the Supabase SQL Editor to set up the database
-- Create the tracks table for storing listening history

create table if not exists tracks (
  id bigint generated always as identity primary key,
  track_id text not null,
  track_name text not null,
  artists jsonb not null default '[]'::jsonb,
  album text not null,
  album_image text,
  duration_ms integer not null,
  played_at timestamptz not null default now(),
  is_playing boolean default false
);

-- Index for fast history queries and stats (range scans)
create index if not exists idx_tracks_played_at on tracks (played_at desc);

-- Enable Row Level Security (recommended)
alter table tracks enable row level security;

-- Allow the service_role key (used by the server) full access
-- RLS is bypassed for service_role, but we add a policy for good measure
create policy "Service role can do everything"
  on tracks
  using (true)
  with check (true);

-- Table for persisting Spotify OAuth tokens across server restarts
create table if not exists tokens (
  id integer primary key default 1,
  access_token text,
  refresh_token text,
  updated_at timestamptz default now(),
  constraint single_row check (id = 1)
);

create policy "Service role can do everything on tokens"
  on tokens
  using (true)
  with check (true);
