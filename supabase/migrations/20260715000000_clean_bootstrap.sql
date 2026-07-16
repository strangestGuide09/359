-- Grocery Ledger clean bootstrap (2026-07-15).
-- Apply to a NEW Supabase project only. The older SQL files in supabase/ are
-- historical reference and are not prerequisites for this migration.
--
-- Privacy boundary: this schema stores reviewed ledger data and SHA-256
-- duplicate fingerprints. It has no column for PDF bytes, extracted receipt
-- text, addresses, or payment/card/bank/UPI details.

create extension if not exists pgcrypto;
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

create table public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 1 and 80),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  purge_after timestamptz,
  check ((archived_at is null and purge_after is null) or
         (archived_at is not null and purge_after > archived_at))
);

create table public.household_members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null check (char_length(trim(display_name)) between 1 and 80 and display_name !~ '[[:cntrl:]]'),
  role text not null default 'partner' check (role in ('owner', 'partner')),
  joined_at timestamptz not null default now(),
  primary key (household_id, user_id)
);

create unique index one_owner_per_household
  on public.household_members (household_id) where role = 'owner';

create table public.household_invites (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  invite_code uuid not null unique default gen_random_uuid(),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create unique index one_live_invite_per_household
  on public.household_invites (household_id) where revoked_at is null;

create table public.purchases (
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
  archived_at timestamptz,
  archived_by uuid references auth.users(id) on delete restrict,
  check (not is_personal or not is_tracked_for_restock)
);

-- Only user-reviewed item fields sync. display_order preserves the editable
-- local draft order without retaining OCR/PDF output.
create table public.purchase_items (
  id uuid primary key default gen_random_uuid(),
  purchase_id uuid not null references public.purchases(id) on delete cascade,
  display_order integer not null check (display_order >= 0),
  name text not null check (char_length(trim(name)) between 1 and 160),
  quantity numeric(10,3) check (quantity is null or quantity > 0),
  unit text check (unit is null or char_length(trim(unit)) between 1 and 30),
  unit_price numeric(12,2) check (unit_price is null or unit_price >= 0),
  line_total numeric(12,2) check (line_total is null or line_total >= 0),
  is_personal boolean not null default false,
  is_tracked_for_restock boolean not null default false,
  estimated_use_by date,
  created_at timestamptz not null default now(),
  unique (purchase_id, display_order),
  check (not is_personal or not is_tracked_for_restock)
);

create table public.settlements (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  payer uuid not null references auth.users(id) on delete restrict,
  receiver uuid not null references auth.users(id) on delete restrict,
  amount numeric(12,2) not null check (amount > 0),
  settled_on date not null,
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  archived_by uuid references auth.users(id) on delete restrict,
  check (payer <> receiver)
);

create table public.invoice_imports (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  exact_pdf_hash text not null check (exact_pdf_hash ~ '^[0-9a-f]{64}$'),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  imported_by uuid not null references auth.users(id) on delete restrict,
  imported_at timestamptz not null default now(),
  unique (household_id, exact_pdf_hash),
  unique (household_id, content_hash)
);

create table public.ledger_activity (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  actor_id uuid not null references auth.users(id) on delete restrict,
  action text not null check (char_length(action) between 1 and 80),
  subject_id uuid,
  created_at timestamptz not null default now()
);

create index purchases_household_date_idx on public.purchases (household_id, purchased_on desc);
create index settlements_household_date_idx on public.settlements (household_id, settled_on desc);
create index purchase_items_purchase_idx on public.purchase_items (purchase_id, display_order);

create function private.is_household_member(target_household uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.household_members
    where household_id = target_household and user_id = auth.uid())
$$;

create function private.household_role(target_household uuid)
returns text language sql stable security definer set search_path = '' as $$
  select role from public.household_members
  where household_id = target_household and user_id = auth.uid()
$$;

create function private.is_household_active_member(target_household uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.household_members m
    join public.households h on h.id = m.household_id
    where m.household_id = target_household and m.user_id = auth.uid()
      and h.archived_at is null)
$$;

create function private.is_household_owner(target_household uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(private.household_role(target_household) = 'owner', false)
$$;

-- The advisory lock makes concurrent joins serialize per household. A trigger,
-- not merely the join RPC, protects the invariant from every insertion path.
create function private.enforce_membership_limits()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(new.household_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 1));
  if (select count(*) from public.household_members
      where household_id = new.household_id) >= 2 then
    raise exception using errcode = '23514', message = 'A household can have at most two active members';
  end if;
  if exists (
    select 1 from public.household_members m
    join public.households h on h.id = m.household_id
    where m.user_id = new.user_id and h.archived_at is null
      and m.household_id <> new.household_id
  ) then
    raise exception using errcode = '23514', message = 'An account can belong to only one active household';
  end if;
  return new;
end;
$$;
create trigger enforce_membership_limits_before_insert before insert on public.household_members
for each row execute function private.enforce_membership_limits();

create function private.is_household_ready(target_household uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_household_active_member(target_household)
    and (select count(*) from public.household_members where household_id = target_household) = 2
$$;

create function private.validate_purchase_member()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not new.is_personal and not private.is_household_ready(new.household_id) then
    raise exception using errcode = '23514', message = 'A partner must join before adding shared expenses';
  end if;
  if not exists (select 1 from public.household_members
    where household_id = new.household_id and user_id = new.paid_by) then
    raise exception using errcode = '23514', message = 'Payer must be an active household member';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger validate_purchase_member_before_write before insert or update on public.purchases
for each row execute function private.validate_purchase_member();

create function private.validate_settlement_members()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_household_ready(new.household_id) then
    raise exception using errcode = '23514', message = 'A partner must join before recording settlements';
  end if;
  if (select count(*) from public.household_members where household_id = new.household_id
      and user_id in (new.payer, new.receiver)) <> 2 then
    raise exception using errcode = '23514', message = 'Settlement participants must be active household members';
  end if;
  return new;
end;
$$;
create trigger validate_settlement_members_before_write before insert or update on public.settlements
for each row execute function private.validate_settlement_members();

create function private.log_activity(target_household uuid, event_action text, event_subject uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.ledger_activity (household_id, actor_id, action, subject_id)
  values (target_household, auth.uid(), event_action, event_subject);
end;
$$;

create function public.create_household(household_name text, p_display_name text)
returns table(id uuid, invite_code uuid)
language plpgsql security definer set search_path = '' as $$
declare new_id uuid; new_code uuid;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if coalesce(char_length(trim(p_display_name)) not between 1 and 80 or p_display_name ~ '[[:cntrl:]]', true) then raise exception 'Display name must be 1 to 80 characters without control characters'; end if;
  insert into public.households (name, created_by) values (trim(household_name), auth.uid()) returning households.id into new_id;
  insert into public.household_members (household_id, user_id, display_name, role) values (new_id, auth.uid(), trim(p_display_name), 'owner');
  insert into public.household_invites (household_id, created_by) values (new_id, auth.uid()) returning household_invites.invite_code into new_code;
  return query select new_id, new_code;
end;
$$;

create function public.create_household(household_name text)
returns table(id uuid, invite_code uuid)
language sql security definer set search_path = '' as $$
  select * from public.create_household(household_name, 'Household owner')
$$;

create function public.create_household_invite(p_household_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare new_code uuid;
begin
  if not private.is_household_active_member(p_household_id) or not private.is_household_owner(p_household_id) then
    raise exception 'Only the household owner can invite a partner';
  end if;
  if (select count(*) from public.household_members where household_id = p_household_id) >= 2 then
    raise exception 'This household already has two active members';
  end if;
  update public.household_invites set revoked_at = now() where household_id = p_household_id and revoked_at is null;
  insert into public.household_invites (household_id, created_by) values (p_household_id, auth.uid()) returning invite_code into new_code;
  perform private.log_activity(p_household_id, 'invite_created');
  return new_code;
end;
$$;

create function public.join_household(code uuid, p_display_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare target_household uuid;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if coalesce(char_length(trim(p_display_name)) not between 1 and 80 or p_display_name ~ '[[:cntrl:]]', true) then raise exception 'Display name must be 1 to 80 characters without control characters'; end if;
  select i.household_id into target_household from public.household_invites i
  join public.households h on h.id = i.household_id
  where i.invite_code = code and i.revoked_at is null and h.archived_at is null;
  if target_household is null then raise exception 'Invalid or inactive household invite code'; end if;
  if exists (select 1 from public.household_members where household_id = target_household and user_id = auth.uid()) then
    return target_household;
  end if;
  insert into public.household_members (household_id, user_id, display_name, role) values (target_household, auth.uid(), trim(p_display_name), 'partner');
  update public.household_invites set revoked_at = now() where invite_code = code;
  perform private.log_activity(target_household, 'member_joined', auth.uid());
  return target_household;
end;
$$;

create function public.join_household(code uuid)
returns uuid language sql security definer set search_path = '' as $$
  select public.join_household(code, 'Household partner')
$$;

create function public.set_member_display_name(p_display_name text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if coalesce(char_length(trim(p_display_name)) not between 1 and 80 or p_display_name ~ '[[:cntrl:]]', true) then raise exception 'Display name must be 1 to 80 characters without control characters'; end if;
  update public.household_members m set display_name = trim(p_display_name)
  from public.households h
  where m.household_id = h.id and m.user_id = auth.uid() and h.archived_at is null;
  if not found then raise exception 'Active household membership is required'; end if;
end;
$$;

create function public.set_my_display_name(p_display_name text)
returns void language sql security definer set search_path = '' as $$
  select public.set_member_display_name(p_display_name)
$$;

-- Backward-compatible single-entry import used by docs/app.js. The fingerprint
-- and reviewed purchase commit atomically; no PDF or extracted text is accepted.
create function public.import_purchase(
  p_household_id uuid, p_exact_pdf_hash text, p_content_hash text, p_label text,
  p_category text, p_amount numeric, p_purchased_on date, p_is_personal boolean,
  p_is_tracked_for_restock boolean, p_estimated_use_by date
) returns uuid language plpgsql security definer set search_path = '' as $$
declare new_purchase_id uuid;
begin
  if auth.uid() is null or not private.is_household_active_member(p_household_id) then raise exception 'Active household membership is required'; end if;
  if not p_is_personal and not private.is_household_ready(p_household_id) then raise exception 'A partner must join before adding shared expenses'; end if;
  insert into public.invoice_imports (household_id, exact_pdf_hash, content_hash, imported_by)
  values (p_household_id, p_exact_pdf_hash, p_content_hash, auth.uid());
  insert into public.purchases (household_id, label, category, amount, paid_by, purchased_on, is_personal, is_tracked_for_restock, estimated_use_by)
  values (p_household_id, trim(p_label), p_category, p_amount, auth.uid(), p_purchased_on, p_is_personal, p_is_tracked_for_restock, p_estimated_use_by)
  returning id into new_purchase_id;
  return new_purchase_id;
exception when unique_violation then raise exception 'This bill was already imported';
end;
$$;

-- Itemized sync contract for clients after local review. p_items is an array of
-- objects containing only name, quantity, unit, unit_price, line_total,
-- is_personal, is_tracked_for_restock, estimated_use_by, and display_order.
create function public.import_reviewed_purchase(
  p_household_id uuid, p_paid_by uuid, p_exact_pdf_hash text, p_content_hash text, p_label text,
  p_category text, p_amount numeric, p_purchased_on date, p_is_personal boolean,
  p_items jsonb
) returns uuid language plpgsql security definer set search_path = '' as $$
declare new_purchase_id uuid; item jsonb; item_index integer := 0; has_shared_items boolean;
begin
  if auth.uid() is null or not private.is_household_active_member(p_household_id) then raise exception 'Active household membership is required'; end if;
  if not exists (select 1 from public.household_members where household_id=p_household_id and user_id=p_paid_by) then raise exception 'Selected payer must be an active household member'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'At least one reviewed item is required'; end if;
  select coalesce(bool_or(not coalesce((value->>'is_personal')::boolean, false)), false)
    into has_shared_items from jsonb_array_elements(p_items);
  if p_is_personal <> not has_shared_items then raise exception 'Purchase allocation must match its reviewed items'; end if;
  if has_shared_items and not private.is_household_ready(p_household_id) then raise exception 'A partner must join before adding shared expenses'; end if;
  insert into public.invoice_imports (household_id, exact_pdf_hash, content_hash, imported_by)
  values (p_household_id, p_exact_pdf_hash, p_content_hash, auth.uid());
  insert into public.purchases (household_id, label, category, amount, paid_by, purchased_on, is_personal)
  values (p_household_id, trim(p_label), p_category, p_amount, p_paid_by, p_purchased_on, p_is_personal)
  returning id into new_purchase_id;
  for item in select value from jsonb_array_elements(p_items) loop
    if item - array['name','quantity','unit','unit_price','line_total','is_personal','is_tracked_for_restock','estimated_use_by','display_order'] <> '{}'::jsonb then raise exception 'Reviewed item contains unsupported fields'; end if;
    insert into public.purchase_items (purchase_id, display_order, name, quantity, unit, unit_price, line_total, is_personal, is_tracked_for_restock, estimated_use_by)
    values (new_purchase_id, coalesce((item->>'display_order')::integer, item_index), trim(item->>'name'), (item->>'quantity')::numeric,
      nullif(trim(item->>'unit'), ''), (item->>'unit_price')::numeric, (item->>'line_total')::numeric,
      coalesce((item->>'is_personal')::boolean, false), coalesce((item->>'is_tracked_for_restock')::boolean, false), (item->>'estimated_use_by')::date);
    item_index := item_index + 1;
  end loop;
  return new_purchase_id;
exception when unique_violation then raise exception 'This bill was already imported';
end;
$$;

-- Compatibility overload: older clients attribute payment to the uploader.
create function public.import_reviewed_purchase(
  p_household_id uuid, p_exact_pdf_hash text, p_content_hash text, p_label text,
  p_category text, p_amount numeric, p_purchased_on date, p_is_personal boolean,
  p_items jsonb
) returns uuid language sql security definer set search_path = '' as $$
  select public.import_reviewed_purchase(p_household_id, auth.uid(), p_exact_pdf_hash, p_content_hash, p_label,
    p_category, p_amount, p_purchased_on, p_is_personal, p_items)
$$;

create function private.member_balance(target_household uuid, target_member uuid) returns numeric language sql stable security definer set search_path = '' as $$
  with purchase_shared as (
    select p.paid_by,
      case when exists (select 1 from public.purchase_items i where i.purchase_id=p.id)
        then coalesce((select sum(i.line_total) from public.purchase_items i where i.purchase_id=p.id and not i.is_personal),0)
        when not p.is_personal then p.amount else 0 end::numeric as shared_amount
    from public.purchases p where p.household_id=target_household and p.archived_at is null
  ), shared as (select coalesce(sum(shared_amount),0)::numeric total,
    coalesce(sum(shared_amount) filter (where paid_by=target_member),0)::numeric paid
    from purchase_shared),
  payments as (select coalesce(sum(case when payer=target_member then amount when receiver=target_member then -amount else 0 end),0)::numeric net
    from public.settlements where household_id=target_household and archived_at is null)
  select shared.paid - shared.total / nullif((select count(*) from public.household_members where household_id=target_household),0) + payments.net from shared,payments
$$;

create function public.remove_household_member(p_household_id uuid, p_member_id uuid) returns void language plpgsql security definer set search_path = '' as $$
declare member_role text;
begin
  if not private.is_household_owner(p_household_id) then raise exception 'Only the owner can remove the partner'; end if;
  select role into member_role from public.household_members where household_id=p_household_id and user_id=p_member_id;
  if member_role is null then raise exception 'Member not found'; end if;
  if member_role='owner' then raise exception 'Transfer ownership before removing the owner'; end if;
  if abs(private.member_balance(p_household_id,p_member_id)) > 0.005 then raise exception 'Settle this member''s balance before removing them'; end if;
  delete from public.household_members where household_id=p_household_id and user_id=p_member_id;
end;
$$;

create function public.archive_household(p_household_id uuid) returns timestamptz language plpgsql security definer set search_path = '' as $$
declare recover_until timestamptz := now()+interval '30 days';
begin
  if not private.is_household_owner(p_household_id) then raise exception 'Only the household owner can archive this household'; end if;
  if exists (select 1 from public.household_members where household_id=p_household_id and abs(private.member_balance(p_household_id,user_id)) > .005) then raise exception 'Settle every member''s balance before archiving this household'; end if;
  update public.households set archived_at=now(), purge_after=recover_until where id=p_household_id;
  return recover_until;
end;
$$;

create function public.restore_household(p_household_id uuid) returns void language plpgsql security definer set search_path = '' as $$
declare member_id uuid;
begin
  if not private.is_household_owner(p_household_id) then raise exception 'Only the household owner can restore this household'; end if;
  -- Serialize restoration against create/join membership writes for each account.
  for member_id in select user_id from public.household_members
    where household_id = p_household_id order by user_id
  loop
    perform pg_advisory_xact_lock(hashtextextended(member_id::text, 1));
  end loop;
  if exists (
    select 1 from public.household_members archived_member
    join public.household_members active_member on active_member.user_id = archived_member.user_id
    join public.households active_household on active_household.id = active_member.household_id
    where archived_member.household_id = p_household_id
      and active_member.household_id <> p_household_id
      and active_household.archived_at is null
  ) then raise exception 'A member already belongs to another active household'; end if;
  update public.households set archived_at=null,purge_after=null where id=p_household_id and archived_at is not null and purge_after>now();
  if not found then raise exception 'This household cannot be restored; its recovery period ended'; end if;
end;
$$;

create function public.permanently_delete_household(p_household_id uuid) returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_household_owner(p_household_id) then raise exception 'Only the household owner can permanently delete this household'; end if;
  delete from public.households where id=p_household_id and archived_at is not null and purge_after<=now();
  if not found then raise exception 'Archive the household and wait for its 30-day recovery period before permanent deletion'; end if;
end;
$$;

alter table public.households enable row level security;
alter table public.household_members enable row level security;
alter table public.household_invites enable row level security;
alter table public.purchases enable row level security;
alter table public.purchase_items enable row level security;
alter table public.settlements enable row level security;
alter table public.invoice_imports enable row level security;
alter table public.ledger_activity enable row level security;

create policy households_read on public.households for select using (private.is_household_member(id));
create policy members_read on public.household_members for select using (private.is_household_member(household_id));
create policy purchases_read on public.purchases for select using (private.is_household_member(household_id));
create policy purchases_insert on public.purchases for insert with check (private.is_household_active_member(household_id) and exists (select 1 from public.household_members m where m.household_id=purchases.household_id and m.user_id=purchases.paid_by));
create policy purchases_update on public.purchases for update using (private.is_household_active_member(household_id)) with check (private.is_household_active_member(household_id) and exists (select 1 from public.household_members m where m.household_id=purchases.household_id and m.user_id=purchases.paid_by));
create policy purchases_delete on public.purchases for delete using (private.is_household_active_member(household_id));
create policy purchase_items_read on public.purchase_items for select using (exists (select 1 from public.purchases p where p.id=purchase_id and private.is_household_member(p.household_id)));
create policy purchase_items_write on public.purchase_items for all using (exists (select 1 from public.purchases p where p.id=purchase_id and private.is_household_active_member(p.household_id))) with check (exists (select 1 from public.purchases p where p.id=purchase_id and private.is_household_active_member(p.household_id)));
create policy settlements_read on public.settlements for select using (private.is_household_member(household_id));
create policy settlements_insert on public.settlements for insert with check (private.is_household_active_member(household_id) and payer=auth.uid());
create policy settlements_update on public.settlements for update using (private.is_household_active_member(household_id) and (payer=auth.uid() or private.is_household_owner(household_id))) with check (private.is_household_active_member(household_id) and (payer=auth.uid() or private.is_household_owner(household_id)));
create policy settlements_delete on public.settlements for delete using (private.is_household_active_member(household_id) and (payer=auth.uid() or private.is_household_owner(household_id)));
create policy imports_read on public.invoice_imports for select using (private.is_household_member(household_id));
create policy activity_read on public.ledger_activity for select using (private.is_household_member(household_id));

grant usage on schema public to authenticated;
grant select on public.households,public.household_members,public.purchases,public.purchase_items,public.settlements,public.invoice_imports,public.ledger_activity to authenticated;
grant insert,update,delete on public.purchases,public.purchase_items,public.settlements to authenticated;
revoke execute on all functions in schema public from public,anon,authenticated;
revoke execute on all functions in schema private from public,anon,authenticated;
alter default privileges for role postgres in schema public revoke execute on functions from public,anon,authenticated;
grant execute on function private.is_household_member(uuid),private.household_role(uuid),private.is_household_active_member(uuid),private.is_household_ready(uuid),private.is_household_owner(uuid) to authenticated;
grant execute on function public.create_household(text),public.create_household(text,text),public.create_household_invite(uuid),public.join_household(uuid),public.join_household(uuid,text),public.set_member_display_name(text),public.set_my_display_name(text),public.import_purchase(uuid,text,text,text,text,numeric,date,boolean,boolean,date),public.import_reviewed_purchase(uuid,text,text,text,text,numeric,date,boolean,jsonb),public.import_reviewed_purchase(uuid,uuid,text,text,text,text,numeric,date,boolean,jsonb),public.remove_household_member(uuid,uuid),public.archive_household(uuid),public.restore_household(uuid),public.permanently_delete_household(uuid) to authenticated;

alter publication supabase_realtime add table public.purchases,public.purchase_items,public.settlements,public.household_members;
notify pgrst, 'reload schema';
