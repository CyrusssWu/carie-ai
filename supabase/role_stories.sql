-- v0.2: AI-written job-simulation stories (run after schema.sql and scene_images.sql).

-- One generated story per role, reused by every student who picks that role.
-- Only the ai Edge Function (secret key) reads or writes this table.
create table if not exists public.role_stories (
  key text primary key,          -- normalised role name + model
  role text not null,
  story jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.role_stories enable row level security;

-- Students now give their name after signing up (onboarding step 1),
-- so they may update their own display name. Role cannot be changed.
create or replace function public.update_my_name(new_name text) returns void
language sql security definer set search_path = public as $$
  update profiles set name = left(trim(new_name), 80)
   where id = auth.uid() and length(trim(new_name)) > 0
$$;
revoke execute on function public.update_my_name(text) from public, anon;
grant execute on function public.update_my_name(text) to authenticated;
