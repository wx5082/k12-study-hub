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

create or replace function public.create_space(space_code text, space_name text, seed_data jsonb)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_code text := upper(space_code);
begin
  if auth.uid() is null then
    raise exception '未登录';
  end if;

  insert into public.spaces(code, name, owner_id, data)
  values (normalized_code, coalesce(nullif(space_name, ''), '学习空间'), auth.uid(), coalesce(seed_data, '{}'::jsonb));

  insert into public.space_members(code, user_id, role)
  values (normalized_code, auth.uid(), 'owner')
  on conflict (code, user_id) do update set role = excluded.role;

  update public.profiles
  set active_space = normalized_code, updated_at = now()
  where id = auth.uid();

  return normalized_code;
end;
$$;
