-- Grocery Ledger: audited, reversible receipt deletion.
-- A receipt deletion removes the reviewed purchase from the active ledger only.
-- No PDF or extracted receipt text is stored by this schema.

begin;

create or replace function private.guard_purchase_receipt_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (
    new.archived_at is distinct from old.archived_at
    or new.archived_by is distinct from old.archived_by
  ) and current_setting('app.grocery_receipt_lifecycle', true) is distinct from 'allowed' then
    raise exception 'Use delete_purchase_receipt or restore_purchase_receipt.';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_purchase_receipt_lifecycle on public.purchases;
create trigger guard_purchase_receipt_lifecycle
before update on public.purchases
for each row execute function private.guard_purchase_receipt_lifecycle();

create or replace function public.delete_purchase_receipt(p_purchase_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.purchases%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Sign in required';
  end if;

  select * into target
  from public.purchases
  where id = p_purchase_id
  for update;

  if not found then
    raise exception 'Receipt not found';
  end if;
  if not private.is_household_active_member(target.household_id)
    or (auth.uid() <> target.paid_by and not private.is_household_owner(target.household_id)) then
    raise exception 'Only the payer or household owner can delete this receipt';
  end if;
  if target.archived_at is not null then
    raise exception 'Receipt is already deleted';
  end if;

  perform set_config('app.grocery_receipt_lifecycle', 'allowed', true);
  update public.purchases
  set archived_at = now(), archived_by = auth.uid()
  where id = target.id;
  perform private.log_activity(target.household_id, 'receipt_deleted', target.id);
end;
$$;

create or replace function public.restore_purchase_receipt(p_purchase_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.purchases%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Sign in required';
  end if;

  select * into target
  from public.purchases
  where id = p_purchase_id
  for update;

  if not found then
    raise exception 'Receipt not found';
  end if;
  if not private.is_household_active_member(target.household_id)
    or (auth.uid() <> target.paid_by and not private.is_household_owner(target.household_id)) then
    raise exception 'Only the payer or household owner can restore this receipt';
  end if;
  if target.archived_at is null then
    raise exception 'Receipt is not deleted';
  end if;

  perform set_config('app.grocery_receipt_lifecycle', 'allowed', true);
  update public.purchases
  set archived_at = null, archived_by = null
  where id = target.id;
  perform private.log_activity(target.household_id, 'receipt_restored', target.id);
end;
$$;

-- All receipt lifecycle changes must go through the guarded RPCs above.
drop policy if exists purchases_delete on public.purchases;
revoke delete on public.purchases from anon, authenticated;
revoke all on function public.delete_purchase_receipt(uuid) from public, anon, authenticated;
revoke all on function public.restore_purchase_receipt(uuid) from public, anon, authenticated;
grant execute on function public.delete_purchase_receipt(uuid) to authenticated;
grant execute on function public.restore_purchase_receipt(uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
