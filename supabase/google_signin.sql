-- Google sign-in (run after schema.sql).
-- Google sign-ups can't carry the Student/Mentor choice, so every new Google
-- account starts as a student. If "Mentor" was chosen, the app calls this once,
-- right after the first sign-in. It only works on a brand-new account that has
-- no student data yet.
create or replace function public.claim_mentor_role() returns void
language sql security definer set search_path = public as $$
  update profiles set role = 'mentor'
   where id = auth.uid()
     and role = 'student'
     and created_at > now() - interval '15 minutes'
     and not exists (select 1 from passports where student_id = auth.uid())
$$;
revoke execute on function public.claim_mentor_role() from public, anon;
grant execute on function public.claim_mentor_role() to authenticated;
