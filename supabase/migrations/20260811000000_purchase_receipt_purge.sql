-- Irreversible purge for an already archived reviewed receipt.
-- Reviewed items and the linked opaque fingerprint reservation cascade from
-- purchases. Receipt-specific lifecycle audit rows are removed so they do not
-- retain an orphaned receipt UUID; one content-free purge event remains.
begin;

create or replace function public.purge_purchase_receipt(p_purchase_id uuid)
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
  where id=p_purchase_id
  for update;

  if not found then
    raise exception 'Receipt not found';
  end if;
  if not private.is_household_active_member(target.household_id)
    or not private.is_household_owner(target.household_id) then
    raise exception 'Only the active household owner can permanently delete this receipt';
  end if;
  if target.archived_at is null then
    raise exception 'Receipt must be deleted before permanent removal';
  end if;

  -- subject_id is intentionally not a foreign key. Remove every event tied to
  -- this receipt before deleting it so no orphaned receipt identifier remains.
  delete from public.ledger_activity
  where household_id=target.household_id and subject_id=target.id;

  -- purchase_items and linked invoice_imports use ON DELETE CASCADE.
  delete from public.purchases where id=target.id;
  perform private.log_activity(target.household_id,'receipt_purged',null);
end;
$$;

revoke all on function public.purge_purchase_receipt(uuid) from public,anon,authenticated;
grant execute on function public.purge_purchase_receipt(uuid) to authenticated;

-- Keep direct table deletion unavailable; permanent deletion is owner-only
-- through the SECURITY DEFINER RPC above.
revoke delete on public.purchases from anon,authenticated;

notify pgrst, 'reload schema';
commit;
