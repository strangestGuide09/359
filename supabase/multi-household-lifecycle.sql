-- Grocery Ledger — Multi-household lifecycle and roles
-- Run ONCE after the existing schema and local-PDF migrations. This file is
-- idempotent; do not rerun schema.sql (it contains one-time policy creation).
--
-- Privacy: no receipt bytes/text, address, payment method/reference, bank,
-- card, or UPI data is added. Activity records only actions and opaque IDs.

alter table public.households
  add column if not exists archived_at timestamptz,
  add column if not exists purge_after timestamptz;

alter table public.household_members drop constraint if exists household_members_role_check;
alter table public.household_members
  add constraint household_members_role_check check (role in ('owner', 'admin', 'member'));

alter table public.purchases
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by uuid references auth.users(id) on delete restrict;
alter table public.settlements
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by uuid references auth.users(id) on delete restrict;

create table if not exists public.admin_requests (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  requester_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id) on delete restrict,
  unique (household_id, requester_id, status)
);

create table if not exists public.ledger_activity (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  actor_id uuid not null references auth.users(id) on delete restrict,
  action text not null check (char_length(action) between 1 and 80),
  subject_id uuid,
  created_at timestamptz not null default now()
);

-- Usable invite codes live separately from the readable household record.
-- Only Owner/Admin RPCs may issue them; old household-level codes are retired
-- by the replacement join function below.
create table if not exists public.household_invites (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  invite_code uuid not null unique default gen_random_uuid(),
  created_by uuid not null references auth.users(id) on delete restrict,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.admin_requests enable row level security;
alter table public.ledger_activity enable row level security;
alter table public.household_invites enable row level security;
grant select on public.admin_requests, public.ledger_activity to authenticated;

create or replace function private.household_role(target_household uuid)
returns text language sql stable security definer set search_path = '' as $$
  select role from public.household_members
  where household_id = target_household and user_id = auth.uid()
$$;

create or replace function private.is_household_active_member(target_household uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.household_members m
    join public.households h on h.id = m.household_id
    where m.household_id = target_household and m.user_id = auth.uid()
      and h.archived_at is null
  )
$$;

create or replace function private.is_household_manager(target_household uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.household_role(target_household) in ('owner', 'admin')
$$;

create or replace function private.is_household_owner(target_household uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.household_role(target_household) = 'owner'
$$;

create or replace function private.member_balance(target_household uuid, target_member uuid)
returns numeric language sql stable security definer set search_path = '' as $$
  with member_count as (
    select count(*)::numeric as total from public.household_members where household_id = target_household
  ), shared_purchases as (
    select coalesce(sum(amount), 0)::numeric as total_spend,
           coalesce(sum(case when paid_by = target_member then amount else 0 end), 0)::numeric as paid
    from public.purchases
    where household_id = target_household and archived_at is null and not is_personal
  ), payment_net as (
    select coalesce(sum(case when payer = target_member then amount when receiver = target_member then -amount else 0 end), 0)::numeric as total
    from public.settlements where household_id = target_household and archived_at is null
  )
  select shared_purchases.paid - (shared_purchases.total_spend / nullif(member_count.total, 0)) + payment_net.total
  from member_count, shared_purchases, payment_net
$$;

-- Replace broad member-write policies with owner/admin-or-own-entry rules.
drop policy if exists "members update purchases" on public.purchases;
drop policy if exists "members delete purchases" on public.purchases;
drop policy if exists "members create purchases" on public.purchases;
drop policy if exists "active members create purchases" on public.purchases;
drop policy if exists "managers or authors update purchases" on public.purchases;
drop policy if exists "managers or authors delete purchases" on public.purchases;
create policy "active members create purchases" on public.purchases for insert
  with check (private.is_household_active_member(household_id) and paid_by = auth.uid());
create policy "managers or authors update purchases" on public.purchases for update
  using (private.is_household_active_member(household_id) and (paid_by = auth.uid() or private.is_household_manager(household_id)))
  with check (private.is_household_active_member(household_id) and (paid_by = auth.uid() or private.is_household_manager(household_id)));
create policy "managers or authors delete purchases" on public.purchases for delete
  using (private.is_household_active_member(household_id) and (paid_by = auth.uid() or private.is_household_manager(household_id)));

drop policy if exists "members create settlements" on public.settlements;
drop policy if exists "members delete settlements" on public.settlements;
drop policy if exists "active members create settlements" on public.settlements;
drop policy if exists "managers or authors update settlements" on public.settlements;
drop policy if exists "managers or authors delete settlements" on public.settlements;
create policy "active members create settlements" on public.settlements for insert
  with check (private.is_household_active_member(household_id) and payer = auth.uid());
create policy "managers or authors update settlements" on public.settlements for update
  using (private.is_household_active_member(household_id) and (payer = auth.uid() or private.is_household_manager(household_id)))
  with check (private.is_household_active_member(household_id) and (payer = auth.uid() or private.is_household_manager(household_id)));
create policy "managers or authors delete settlements" on public.settlements for delete
  using (private.is_household_active_member(household_id) and (payer = auth.uid() or private.is_household_manager(household_id)));

-- The baseline grants settlements insert/delete only. Archive and restore are
-- updates, so grant that narrow capability once the guarded policy above exists.
grant update on table public.settlements to authenticated;

drop policy if exists "members read admin requests" on public.admin_requests;
drop policy if exists "members read activity" on public.ledger_activity;
create policy "members read admin requests" on public.admin_requests for select
  using (private.is_household_member(household_id));
create policy "members read activity" on public.ledger_activity for select
  using (private.is_household_member(household_id));

create or replace function private.log_ledger_activity(target_household uuid, event_action text, event_subject uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.ledger_activity (household_id, actor_id, action, subject_id)
  values (target_household, auth.uid(), event_action, event_subject);
end;
$$;

-- Replaces the baseline functions without re-running its policy creation.
create or replace function public.create_household(household_name text)
returns table(id uuid, invite_code uuid)
language plpgsql security definer set search_path = '' as $$
declare new_household public.households; new_code uuid;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  insert into public.households (name, created_by) values (trim(household_name), auth.uid()) returning * into new_household;
  insert into public.household_members (household_id, user_id, role) values (new_household.id, auth.uid(), 'owner');
  insert into public.household_invites (household_id, created_by) values (new_household.id, auth.uid()) returning invite_code into new_code;
  return query select new_household.id, new_code;
end;
$$;

create or replace function public.create_household_invite(p_household_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare new_code uuid;
begin
  if not private.is_household_active_member(p_household_id) or not private.is_household_manager(p_household_id) then raise exception 'Only the household owner or an admin can invite members'; end if;
  update public.household_invites set revoked_at = now()
  where household_id = p_household_id and revoked_at is null;
  insert into public.household_invites (household_id, created_by) values (p_household_id, auth.uid()) returning invite_code into new_code;
  perform private.log_ledger_activity(p_household_id, 'invite_created');
  return new_code;
end;
$$;

create or replace function public.join_household(code uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare target_household uuid;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  select i.household_id into target_household from public.household_invites i
  join public.households h on h.id = i.household_id
  where i.invite_code = code and i.revoked_at is null and h.archived_at is null;
  if target_household is null then raise exception 'Invalid or inactive household invite code'; end if;
  insert into public.household_members (household_id, user_id) values (target_household, auth.uid()) on conflict do nothing;
  perform private.log_ledger_activity(target_household, 'member_joined', auth.uid());
  return target_household;
end;
$$;

-- Ensure archived households cannot be modified through the PDF RPC either.
create or replace function public.import_purchase(
  p_household_id uuid, p_exact_pdf_hash text, p_content_hash text, p_label text,
  p_category text, p_amount numeric, p_purchased_on date, p_is_personal boolean,
  p_is_tracked_for_restock boolean, p_estimated_use_by date
) returns uuid language plpgsql security definer set search_path = '' as $$
declare new_purchase_id uuid; new_import_id uuid;
begin
  if auth.uid() is null or not private.is_household_active_member(p_household_id) then raise exception 'Active household membership is required'; end if;
  insert into public.invoice_imports (household_id, exact_pdf_hash, content_hash, imported_by)
  values (p_household_id, p_exact_pdf_hash, p_content_hash, auth.uid()) on conflict do nothing returning id into new_import_id;
  if new_import_id is null then raise exception 'This bill was already imported'; end if;
  insert into public.purchases (household_id, label, category, amount, paid_by, purchased_on, is_personal, is_tracked_for_restock, estimated_use_by)
  values (p_household_id, trim(p_label), p_category, p_amount, auth.uid(), p_purchased_on, p_is_personal, p_is_tracked_for_restock, p_estimated_use_by) returning id into new_purchase_id;
  return new_purchase_id;
end;
$$;

create or replace function public.request_admin_access(p_household_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare request_id uuid;
begin
  if not private.is_household_active_member(p_household_id) then raise exception 'Active household membership is required'; end if;
  if private.household_role(p_household_id) in ('owner', 'admin') then raise exception 'You already have admin access'; end if;
  insert into public.admin_requests (household_id, requester_id)
  values (p_household_id, auth.uid())
  on conflict (household_id, requester_id, status) where status = 'pending' do nothing
  returning id into request_id;
  if request_id is null then raise exception 'An admin request is already pending'; end if;
  perform private.log_ledger_activity(p_household_id, 'admin_requested', request_id);
  return request_id;
end;
$$;

-- The Owner alone resolves role requests and can transfer ownership.
create or replace function public.resolve_admin_request(p_request_id uuid, p_approve boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare request_row public.admin_requests;
begin
  select * into request_row from public.admin_requests where id = p_request_id for update;
  if request_row.id is null then raise exception 'Admin request not found'; end if;
  if not private.is_household_owner(request_row.household_id) then raise exception 'Only the household owner can resolve admin requests'; end if;
  if request_row.status <> 'pending' then raise exception 'This admin request has already been resolved'; end if;
  update public.admin_requests set status = case when p_approve then 'approved' else 'rejected' end, resolved_at = now(), resolved_by = auth.uid() where id = p_request_id;
  if p_approve then update public.household_members set role = 'admin' where household_id = request_row.household_id and user_id = request_row.requester_id; end if;
  perform private.log_ledger_activity(request_row.household_id, case when p_approve then 'admin_approved' else 'admin_rejected' end, request_row.requester_id);
end;
$$;

create or replace function public.transfer_household_ownership(p_household_id uuid, p_new_owner uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_household_owner(p_household_id) then raise exception 'Only the household owner can transfer ownership'; end if;
  if not exists (select 1 from public.household_members where household_id = p_household_id and user_id = p_new_owner) then raise exception 'New owner must be a household member'; end if;
  update public.household_members set role = case when user_id = p_new_owner then 'owner' when user_id = auth.uid() then 'admin' else role end where household_id = p_household_id and user_id in (p_new_owner, auth.uid());
  update public.households set created_by = p_new_owner where id = p_household_id;
  perform private.log_ledger_activity(p_household_id, 'ownership_transferred', p_new_owner);
end;
$$;

-- Managers may remove ordinary members only after that member is settled.
-- Owner removal requires ownership transfer first. The browser calculates the
-- current equal-share balance and presents it before this guarded action.
create or replace function public.remove_household_member(p_household_id uuid, p_member_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare member_role text;
begin
  if not private.is_household_manager(p_household_id) then raise exception 'Only the owner or an admin can remove members'; end if;
  select role into member_role from public.household_members where household_id = p_household_id and user_id = p_member_id;
  if member_role is null then raise exception 'Member not found'; end if;
  if member_role = 'owner' then raise exception 'Transfer ownership before removing the owner'; end if;
  if abs(private.member_balance(p_household_id, p_member_id)) > 0.005 then raise exception 'Settle this member’s balance before removing them'; end if;
  delete from public.household_members where household_id = p_household_id and user_id = p_member_id;
  perform private.log_ledger_activity(p_household_id, 'member_removed', p_member_id);
end;
$$;

-- A household must have every member's active shared balance at zero before it
-- can be made read-only. Record final settlements first, then archive. It is restorable
-- for exactly 30 days; permanent deletion is possible only after that window.
create or replace function public.archive_household(p_household_id uuid)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare recover_until timestamptz;
begin
  if not private.is_household_owner(p_household_id) then raise exception 'Only the household owner can archive this household'; end if;
  if exists (
    select 1 from public.household_members
    where household_id = p_household_id and abs(private.member_balance(p_household_id, user_id)) > 0.005
  ) then
    raise exception 'Settle every member’s balance before archiving this household';
  end if;
  recover_until := now() + interval '30 days';
  update public.households set archived_at = now(), purge_after = recover_until where id = p_household_id;
  perform private.log_ledger_activity(p_household_id, 'household_archived');
  return recover_until;
end;
$$;

create or replace function public.restore_household(p_household_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_household_owner(p_household_id) then raise exception 'Only the household owner can restore this household'; end if;
  update public.households set archived_at = null, purge_after = null
  where id = p_household_id and archived_at is not null and purge_after > now();
  if not found then raise exception 'This household cannot be restored; its recovery period ended'; end if;
  perform private.log_ledger_activity(p_household_id, 'household_restored');
end;
$$;

create or replace function public.permanently_delete_household(p_household_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_household_owner(p_household_id) then raise exception 'Only the household owner can permanently delete this household'; end if;
  delete from public.households where id = p_household_id and archived_at is not null and purge_after <= now();
  if not found then raise exception 'Archive the household and wait for its 30-day recovery period before permanent deletion'; end if;
end;
$$;

-- Some early test databases had a subset of these functions, sometimes with
-- a different signature. Revoke only functions that actually exist so a
-- harmless legacy difference cannot abort this whole migration.
do $$
declare function_name text;
begin
  foreach function_name in array array[
    'public.request_admin_access(uuid)',
    'public.resolve_admin_request(uuid,boolean)',
    'public.transfer_household_ownership(uuid,uuid)',
    'public.remove_household_member(uuid,uuid)',
    'public.remove_household_member(uuid)',
    'public.archive_household(uuid)',
    'public.restore_household(uuid)',
    'public.permanently_delete_household(uuid)'
  ] loop
    if to_regprocedure(function_name) is not null then
      execute format('revoke execute on function %s from public, anon, authenticated', function_name);
    end if;
  end loop;
end;
$$;
grant execute on function public.create_household(text), public.create_household_invite(uuid), public.join_household(uuid), public.import_purchase(uuid, text, text, text, text, numeric, date, boolean, boolean, date), public.request_admin_access(uuid), public.resolve_admin_request(uuid, boolean), public.transfer_household_ownership(uuid, uuid), public.remove_household_member(uuid), public.archive_household(uuid), public.restore_household(uuid), public.permanently_delete_household(uuid) to authenticated;
grant execute on function private.household_role(uuid), private.is_household_active_member(uuid), private.is_household_manager(uuid), private.is_household_owner(uuid), private.member_balance(uuid, uuid), private.log_ledger_activity(uuid, text, uuid) to authenticated;

notify pgrst, 'reload schema';
