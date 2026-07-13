-- Grocery Ledger shared-sync schema. Run in Supabase SQL Editor as the project owner.
-- It stores reviewed ledger data only. It intentionally has no receipt, address,
-- payment-method, bank, card, UPI, or payment-reference columns.

create extension if not exists pgcrypto;

create table if not exists public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 1 and 80),
  invite_code uuid not null unique default gen_random_uuid(),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table if not exists public.household_members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (household_id, user_id)
);

create table if not exists public.purchases (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  label text not null check (char_length(trim(label)) between 1 and 160),
  category text not null check (category in ('Groceries', 'Food', 'Wi-Fi', 'Water', 'Household', 'Other')),
  amount numeric(12,2) not null check (amount > 0),
  paid_by uuid not null references auth.users(id) on delete restrict,
  purchased_on date not null,
  is_personal boolean not null default false,
  is_tracked_for_restock boolean not null default false,
  estimated_use_by date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not is_personal or not is_tracked_for_restock)
);

create table if not exists public.settlements (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  payer uuid not null references auth.users(id) on delete restrict,
  receiver uuid not null references auth.users(id) on delete restrict,
  amount numeric(12,2) not null check (amount > 0),
  settled_on date not null,
  created_at timestamptz not null default now(),
  check (payer <> receiver)
);

create index if not exists purchases_household_date_idx on public.purchases (household_id, purchased_on desc);
create index if not exists settlements_household_date_idx on public.settlements (household_id, settled_on desc);

alter table public.households enable row level security;
alter table public.household_members enable row level security;
alter table public.purchases enable row level security;
alter table public.settlements enable row level security;

create or replace function public.is_household_member(target_household uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.household_members
    where household_id = target_household and user_id = auth.uid()
  );
$$;

create or replace function public.create_household(household_name text)
returns table(id uuid, invite_code uuid)
language plpgsql security definer set search_path = public as $$
declare new_household public.households;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  insert into public.households (name, created_by)
  values (trim(household_name), auth.uid()) returning * into new_household;
  insert into public.household_members (household_id, user_id, role)
  values (new_household.id, auth.uid(), 'owner');
  return query select new_household.id, new_household.invite_code;
end;
$$;

create or replace function public.join_household(code uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare target public.households;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  select * into target from public.households where invite_code = code;
  if target.id is null then raise exception 'Invalid household invite code'; end if;
  insert into public.household_members (household_id, user_id)
  values (target.id, auth.uid()) on conflict do nothing;
  return target.id;
end;
$$;

grant execute on function public.create_household(text) to authenticated;
grant execute on function public.join_household(uuid) to authenticated;
grant execute on function public.is_household_member(uuid) to authenticated;

create policy "members read households" on public.households for select using (public.is_household_member(id));
create policy "members read memberships" on public.household_members for select using (public.is_household_member(household_id));
create policy "members read purchases" on public.purchases for select using (public.is_household_member(household_id));
create policy "members create purchases" on public.purchases for insert with check (public.is_household_member(household_id) and paid_by = auth.uid());
create policy "members update purchases" on public.purchases for update using (public.is_household_member(household_id)) with check (public.is_household_member(household_id));
create policy "members delete purchases" on public.purchases for delete using (public.is_household_member(household_id));
create policy "members read settlements" on public.settlements for select using (public.is_household_member(household_id));
create policy "members create settlements" on public.settlements for insert with check (public.is_household_member(household_id) and payer = auth.uid());
create policy "members delete settlements" on public.settlements for delete using (public.is_household_member(household_id));

alter publication supabase_realtime add table public.purchases, public.settlements, public.household_members;
