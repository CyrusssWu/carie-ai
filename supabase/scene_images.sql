-- Story-scene picture cache (run after schema.sql).
-- Each job-simulation scenario gets one AI picture brief (Google AI Studio) and one
-- Seedream picture. They are made once by the ai Edge Function and reused for
-- every student. Only the Edge Function (secret key) writes here.

create table if not exists public.scene_images (
  key text primary key,          -- hash of the scenario text
  summary text not null,         -- the picture brief written by Google AI Studio
  image_url text not null,       -- permanent public URL in the scene-images bucket
  created_at timestamptz not null default now()
);
alter table public.scene_images enable row level security;
-- No policies: browsers cannot read or write this table directly.

-- Public bucket so the app can show the saved pictures.
insert into storage.buckets (id, name, public)
values ('scene-images', 'scene-images', true)
on conflict (id) do nothing;
