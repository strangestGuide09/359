-- Receipt-backed settlement accounting.
-- Legacy free-standing settlements remain stored for compatibility, but only
-- allocations to active reviewed receipts affect balance and payment history.
begin;

create table public.settlement_allocations (
  id uuid primary key default gen_random_uuid(),
  settlement_id uuid not null references public.settlements(id) on delete cascade,
  purchase_id uuid not null references public.purchases(id) on delete cascade,
  purchase_item_id uuid references public.purchase_items(id) on delete cascade,
  amount numeric(12,2) not null check (amount > 0),
  created_at timestamptz not null default now()
);
create unique index settlement_allocations_target_key
  on public.settlement_allocations (settlement_id,purchase_id,purchase_item_id) nulls not distinct;
create index settlement_allocations_purchase_idx on public.settlement_allocations(purchase_id);
create index settlement_allocations_item_idx on public.settlement_allocations(purchase_item_id) where purchase_item_id is not null;

create or replace function private.validate_settlement_allocation()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  payment public.settlements%rowtype;
  receipt public.purchases%rowtype;
  item public.purchase_items%rowtype;
  shared_total numeric;
  allocated_total numeric;
  item_allocated_total numeric;
begin
  select * into payment from public.settlements where id=new.settlement_id for update;
  if not found then raise exception 'Settlement not found'; end if;
  select * into receipt from public.purchases where id=new.purchase_id for update;
  if not found then raise exception 'Receipt not found'; end if;
  if receipt.household_id<>payment.household_id then raise exception 'Settlement and receipt must belong to the same household'; end if;
  if receipt.archived_at is not null then raise exception 'Settlement allocations require an active receipt'; end if;
  if receipt.purchased_on>payment.settled_on then raise exception 'A payment cannot settle a later receipt'; end if;
  if receipt.paid_by<>payment.receiver then raise exception 'Settlement receiver must be the receipt payer'; end if;

  if new.purchase_item_id is not null then
    select * into item from public.purchase_items where id=new.purchase_item_id;
    if not found or item.purchase_id<>receipt.id then raise exception 'Allocated item must belong to the selected receipt'; end if;
    if item.is_personal or item.line_total is null or item.line_total<=0 then raise exception 'Only shared reviewed items can be settled'; end if;
    select coalesce(sum(a.amount),0) into item_allocated_total
    from public.settlement_allocations a where a.purchase_item_id=item.id and a.id<>new.id;
    if item_allocated_total+new.amount>round(item.line_total/2,2) then raise exception 'Item allocation exceeds the household share'; end if;
  end if;

  if exists(select 1 from public.purchase_items where purchase_id=receipt.id) then
    select coalesce(sum(line_total) filter(where not is_personal),0) into shared_total
    from public.purchase_items where purchase_id=receipt.id;
  else
    shared_total := case when receipt.is_personal then 0 else receipt.amount end;
  end if;
  if shared_total<=0 then raise exception 'Only shared receipts can be settled'; end if;
  select coalesce(sum(a.amount),0) into allocated_total
  from public.settlement_allocations a where a.purchase_id=receipt.id and a.id<>new.id;
  if allocated_total+new.amount>round(shared_total/2,2) then raise exception 'Receipt allocation exceeds the household share'; end if;
  return new;
end;
$$;
create trigger validate_settlement_allocation_before_write
before insert or update on public.settlement_allocations
for each row execute function private.validate_settlement_allocation();

create or replace function private.remove_orphaned_receipt_settlement()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists(select 1 from public.settlements where id=old.settlement_id)
    and not exists(select 1 from public.settlement_allocations where settlement_id=old.settlement_id) then
    delete from public.ledger_activity where subject_id=old.settlement_id;
    delete from public.settlements where id=old.settlement_id;
  end if;
  return old;
end;
$$;
create trigger remove_orphaned_receipt_settlement_after_delete
after delete on public.settlement_allocations
for each row execute function private.remove_orphaned_receipt_settlement();

create or replace function private.guard_settlement_identity()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists(select 1 from public.settlement_allocations where settlement_id=old.id)
    and (new.household_id is distinct from old.household_id
    or new.payer is distinct from old.payer
    or new.receiver is distinct from old.receiver
    or new.amount is distinct from old.amount
    or new.settled_on is distinct from old.settled_on) then
    raise exception 'Receipt-backed settlement identity is immutable';
  end if;
  return new;
end;
$$;
create trigger guard_settlement_identity_before_update
before update on public.settlements
for each row execute function private.guard_settlement_identity();

revoke all on function private.validate_settlement_allocation(),
  private.remove_orphaned_receipt_settlement(),
  private.guard_settlement_identity()
from public,anon,authenticated;

create or replace function public.record_receipt_backed_settlement(
  p_household_id uuid,
  p_receiver uuid,
  p_amount numeric,
  p_settled_on date,
  p_allocations jsonb
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  settlement_id uuid;
  allocation jsonb;
  allocation_total numeric;
begin
  if auth.uid() is null or not private.is_household_active_member(p_household_id) then raise exception 'Active household membership is required'; end if;
  if not private.is_household_ready(p_household_id) then raise exception 'A partner must join before recording settlements'; end if;
  if p_receiver=auth.uid() or not exists(
    select 1 from public.household_members where household_id=p_household_id and user_id=p_receiver
  ) then raise exception 'Settlement receiver must be the other active household member'; end if;
  if p_amount is null or p_amount<=0 then raise exception 'Settlement amount must be positive'; end if;
  if p_settled_on is null then raise exception 'Settlement date is required'; end if;
  if jsonb_typeof(p_allocations)<>'array' or jsonb_array_length(p_allocations)=0 or jsonb_array_length(p_allocations)>100 then
    raise exception 'At least one and at most 100 receipt allocations are required';
  end if;
  if exists(
    select 1 from jsonb_array_elements(p_allocations) value
    where value-array['purchase_id','purchase_item_id','amount']<>'{}'::jsonb
  ) then raise exception 'Settlement allocation contains unsupported fields'; end if;
  select sum((value->>'amount')::numeric) into allocation_total from jsonb_array_elements(p_allocations);
  if allocation_total is null or allocation_total<>p_amount then raise exception 'Settlement allocations must equal the payment amount'; end if;

  insert into public.settlements(household_id,payer,receiver,amount,settled_on)
  values(p_household_id,auth.uid(),p_receiver,p_amount,p_settled_on)
  returning id into settlement_id;
  for allocation in select value from jsonb_array_elements(p_allocations) loop
    insert into public.settlement_allocations(settlement_id,purchase_id,purchase_item_id,amount)
    values(settlement_id,(allocation->>'purchase_id')::uuid,
      nullif(allocation->>'purchase_item_id','')::uuid,(allocation->>'amount')::numeric);
  end loop;
  perform private.log_activity(p_household_id,'settlement_recorded',settlement_id);
  return settlement_id;
end;
$$;

create or replace function private.member_balance(target_household uuid,target_member uuid)
returns numeric language sql stable security definer set search_path = '' as $$
  with purchase_shared as (
    select p.paid_by,
      case when exists(select 1 from public.purchase_items i where i.purchase_id=p.id)
        then coalesce((select sum(i.line_total) from public.purchase_items i where i.purchase_id=p.id and not i.is_personal),0)
        when not p.is_personal then p.amount else 0 end::numeric as shared_amount
    from public.purchases p where p.household_id=target_household and p.archived_at is null
  ), shared as (
    select coalesce(sum(shared_amount),0)::numeric total,
      coalesce(sum(shared_amount) filter(where paid_by=target_member),0)::numeric paid
    from purchase_shared
  ), payments as (
    select coalesce(sum(case when s.payer=target_member then a.amount when s.receiver=target_member then -a.amount else 0 end),0)::numeric net
    from public.settlement_allocations a
    join public.settlements s on s.id=a.settlement_id and s.archived_at is null
    join public.purchases p on p.id=a.purchase_id and p.archived_at is null
    where s.household_id=target_household
  )
  select shared.paid-shared.total/nullif((select count(*) from public.household_members where household_id=target_household),0)+payments.net
  from shared,payments
$$;

create or replace view public.receipt_backed_settlement_history
with (security_invoker=true) as
select s.id,s.household_id,s.payer,s.receiver,s.settled_on,s.created_at,
  sum(a.amount)::numeric(12,2) amount,count(*)::integer allocation_count,
  array_agg(distinct a.purchase_id order by a.purchase_id) purchase_ids,
  coalesce(
    array_agg(distinct a.purchase_item_id order by a.purchase_item_id)
      filter(where a.purchase_item_id is not null),
    array[]::uuid[]
  ) purchase_item_ids
from public.settlements s
join public.settlement_allocations a on a.settlement_id=s.id
join public.purchases p on p.id=a.purchase_id
where s.archived_at is null and p.archived_at is null
group by s.id,s.household_id,s.payer,s.receiver,s.settled_on,s.created_at;

alter table public.settlement_allocations enable row level security;
create policy settlement_allocations_read on public.settlement_allocations for select using (
  exists(select 1 from public.settlements s where s.id=settlement_id and private.is_household_member(s.household_id))
);
grant select on public.settlement_allocations,public.receipt_backed_settlement_history to authenticated;
revoke insert,update,delete on public.settlement_allocations from anon,authenticated;
revoke insert,delete on public.settlements from anon,authenticated;
revoke all on function public.record_receipt_backed_settlement(uuid,uuid,numeric,date,jsonb) from public,anon,authenticated;
grant execute on function public.record_receipt_backed_settlement(uuid,uuid,numeric,date,jsonb) to authenticated;

notify pgrst,'reload schema';
commit;
