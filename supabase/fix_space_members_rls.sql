create or replace function public.is_space_member(space_code text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.space_members sm
    where sm.code = space_code and sm.user_id = auth.uid()
  );
$$;

drop policy if exists "members_select_own_spaces" on public.space_members;
create policy "members_select_own_spaces" on public.space_members
  for select using (user_id = auth.uid());

drop policy if exists "spaces_select_member" on public.spaces;
create policy "spaces_select_member" on public.spaces
  for select using (public.is_space_member(code));

drop policy if exists "spaces_update_member" on public.spaces;
create policy "spaces_update_member" on public.spaces
  for update using (public.is_space_member(code));
