-- Carie AI cloud database (Supabase / Postgres).
-- Run this once in the Supabase SQL editor.

-- Profiles: one row per registered email, created automatically on sign-up.
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  email text not null,
  role text not null check (role in ('student', 'mentor')),
  name text not null default '',
  stage text not null default '',
  organization text not null default '',
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
drop policy if exists "read own profile" on public.profiles;
create policy "read own profile" on public.profiles for select using (id = auth.uid());

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, role, name, stage, organization)
  values (
    new.id,
    coalesce(new.email, ''),
    case when new.raw_user_meta_data->>'role' = 'mentor' then 'mentor' else 'student' end,
    left(coalesce(new.raw_user_meta_data->>'name', ''), 80),
    left(coalesce(new.raw_user_meta_data->>'stage', ''), 20),
    left(coalesce(new.raw_user_meta_data->>'organization', ''), 120)
  );
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.is_mentor() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'mentor')
$$;
create or replace function public.is_student() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'student')
$$;

-- Career Passport: owned by the student. Mentors never read this table
-- directly; they use shared_students(), which hides unshared sections.
create table if not exists public.passports (
  student_id uuid primary key references public.profiles on delete cascade,
  field text not null default '',
  story text not null default '',
  saved boolean not null default false,
  decisions jsonb not null default '[]',
  skills jsonb not null default '[]',
  energy text not null default '',
  reflection text not null default '',
  share_field boolean not null default false,
  share_skills boolean not null default false,
  share_decisions boolean not null default false,
  share_reflection boolean not null default false,
  requested_checkin boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table public.passports enable row level security;
drop policy if exists "student reads own passport" on public.passports;
drop policy if exists "student inserts own passport" on public.passports;
drop policy if exists "student updates own passport" on public.passports;
create policy "student reads own passport" on public.passports for select using (student_id = auth.uid());
create policy "student inserts own passport" on public.passports for insert with check (student_id = auth.uid() and public.is_student());
create policy "student updates own passport" on public.passports for update using (student_id = auth.uid()) with check (student_id = auth.uid());

create or replace function public.student_has_shared(sid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from passports
    where student_id = sid
      and (share_field or share_skills or share_decisions or share_reflection or requested_checkin)
  )
$$;

-- What a mentor sees: only students who opted in, and only the sections they chose.
create or replace function public.shared_students()
returns table (
  student_id uuid, name text, stage text,
  field text, story text, saved boolean, decisions jsonb, skills jsonb, energy text, reflection text,
  share_field boolean, share_skills boolean, share_decisions boolean, share_reflection boolean,
  requested_checkin boolean, updated_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select p.student_id, pr.name, pr.stage,
    case when p.share_field then p.field end,
    case when p.share_field then p.story end,
    case when p.share_field then p.saved end,
    case when p.share_decisions then p.decisions end,
    case when p.share_skills then p.skills end,
    case when p.share_reflection then p.energy end,
    case when p.share_reflection then p.reflection end,
    p.share_field, p.share_skills, p.share_decisions, p.share_reflection,
    p.requested_checkin, p.updated_at
  from passports p
  join profiles pr on pr.id = p.student_id
  where public.is_mentor()
    and (p.share_field or p.share_skills or p.share_decisions or p.share_reflection or p.requested_checkin)
  order by p.updated_at desc
$$;

-- Plans and pathways: written by mentors for students who are sharing.
create table if not exists public.plans (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles on delete cascade,
  mentor_id uuid not null references public.profiles on delete cascade,
  mentor_name text not null default '',
  goal text not null default '',
  tasks jsonb not null default '[]',
  created_at timestamptz not null default now()
);
create table if not exists public.pathways (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles on delete cascade,
  mentor_id uuid not null references public.profiles on delete cascade,
  mentor_name text not null default '',
  route text not null default '',
  title text not null default '',
  note text not null default '',
  opportunity text not null default '',
  created_at timestamptz not null default now()
);
create table if not exists public.mentor_notes (
  id uuid primary key default gen_random_uuid(),
  mentor_id uuid not null references public.profiles on delete cascade,
  student_id uuid not null references public.profiles on delete cascade,
  text text not null,
  created_at timestamptz not null default now()
);

-- The mentor's display name is taken from their profile, not from the client.
create or replace function public.stamp_mentor_name() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.mentor_name := coalesce((select name from profiles where id = new.mentor_id), '');
  return new;
end $$;
drop trigger if exists plans_mentor_name on public.plans;
create trigger plans_mentor_name before insert on public.plans for each row execute function public.stamp_mentor_name();
drop trigger if exists pathways_mentor_name on public.pathways;
create trigger pathways_mentor_name before insert on public.pathways for each row execute function public.stamp_mentor_name();

alter table public.plans enable row level security;
alter table public.pathways enable row level security;
alter table public.mentor_notes enable row level security;

drop policy if exists "plan participants read" on public.plans;
drop policy if exists "mentor creates plan" on public.plans;
drop policy if exists "mentor deletes plan" on public.plans;
create policy "plan participants read" on public.plans for select using (student_id = auth.uid() or mentor_id = auth.uid());
create policy "mentor creates plan" on public.plans for insert with check (mentor_id = auth.uid() and public.is_mentor() and public.student_has_shared(student_id));
create policy "mentor deletes plan" on public.plans for delete using (mentor_id = auth.uid());

drop policy if exists "pathway participants read" on public.pathways;
drop policy if exists "mentor offers pathway" on public.pathways;
drop policy if exists "mentor deletes pathway" on public.pathways;
create policy "pathway participants read" on public.pathways for select using (student_id = auth.uid() or mentor_id = auth.uid());
create policy "mentor offers pathway" on public.pathways for insert with check (mentor_id = auth.uid() and public.is_mentor() and public.student_has_shared(student_id));
create policy "mentor deletes pathway" on public.pathways for delete using (mentor_id = auth.uid());

drop policy if exists "mentor manages own notes" on public.mentor_notes;
create policy "mentor manages own notes" on public.mentor_notes for all
  using (mentor_id = auth.uid()) with check (mentor_id = auth.uid() and public.is_mentor());

-- Students can tick tasks done, but cannot otherwise edit a mentor's plan.
create or replace function public.set_plan_task_done(plan_id uuid, task_index int, is_done boolean) returns void
language sql security definer set search_path = public as $$
  update plans
     set tasks = jsonb_set(tasks, array[task_index::text, 'done'], to_jsonb(is_done))
   where id = plan_id
     and student_id = auth.uid()
     and task_index >= 0
     and task_index < jsonb_array_length(tasks)
$$;

revoke execute on function public.shared_students() from public, anon;
revoke execute on function public.set_plan_task_done(uuid, int, boolean) from public, anon;
grant execute on function public.shared_students() to authenticated;
grant execute on function public.set_plan_task_done(uuid, int, boolean) to authenticated;

-- Story pictures: see scene_images.sql (picture cache table + storage bucket).
