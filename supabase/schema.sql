create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text not null default '',
  grade text not null default '',
  active_space text,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.spaces (
  code text primary key,
  name text not null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.space_members (
  code text not null references public.spaces(code) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member',
  created_at timestamptz not null default now(),
  primary key (code, user_id)
);

alter table public.profiles enable row level security;
alter table public.spaces enable row level security;
alter table public.space_members enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own" on public.profiles
  for insert with check (auth.uid() = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "members_select_own_spaces" on public.space_members;
create policy "members_select_own_spaces" on public.space_members
  for select using (user_id = auth.uid());

drop policy if exists "members_insert_self" on public.space_members;
create policy "members_insert_self" on public.space_members
  for insert with check (user_id = auth.uid());

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

drop policy if exists "spaces_select_member" on public.spaces;
create policy "spaces_select_member" on public.spaces
  for select using (public.is_space_member(code));

drop policy if exists "spaces_insert_owner" on public.spaces;
create policy "spaces_insert_owner" on public.spaces
  for insert with check (owner_id = auth.uid());

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

create or replace function public.join_space(join_code text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception '未登录';
  end if;

  if not exists (select 1 from public.spaces where code = upper(join_code)) then
    raise exception '共享空间不存在';
  end if;

  insert into public.space_members(code, user_id, role)
  values (upper(join_code), auth.uid(), 'member')
  on conflict (code, user_id) do nothing;
end;
$$;
