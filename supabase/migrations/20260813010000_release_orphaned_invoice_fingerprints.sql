-- Allow a household to release legacy opaque duplicate reservations only when
-- the database proves that no reviewed purchase (active or archived) remains.
-- Linked live/archived receipts continue to fail closed and remain restorable.
begin;

create or replace function public.release_orphaned_invoice_fingerprints(
  p_household_id uuid,
  p_exact_pdf_hash text,
  p_content_hash text
) returns integer language plpgsql security definer set search_path = '' as $$
declare
  released_count integer;
begin
  if auth.uid() is null or not private.is_household_active_member(p_household_id) then
    raise exception 'Active household membership is required';
  end if;
  if p_exact_pdf_hash is null or p_exact_pdf_hash !~ '^[0-9a-f]{64}$'
    or p_content_hash is null or p_content_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid duplicate fingerprint';
  end if;

  -- Serialize release attempts with each other for this household. Existing
  -- unique constraints still make a following reviewed import atomic.
  perform pg_advisory_xact_lock(hashtextextended(p_household_id::text,7));

  if exists(
    select 1 from public.invoice_imports i
    where i.household_id=p_household_id
      and (i.exact_pdf_hash=p_exact_pdf_hash or i.content_hash=p_content_hash)
      and i.purchase_id is not null
  ) then
    raise exception 'A linked receipt fingerprint cannot be released';
  end if;

  -- An unlinked legacy row cannot be correlated safely to a particular old
  -- purchase. Release is therefore allowed only when there are no purchases
  -- at all, including archived receipts, in the household.
  if exists(select 1 from public.purchases where household_id=p_household_id) then
    raise exception 'Legacy fingerprint requires manual reconciliation while household receipts remain';
  end if;

  delete from public.invoice_imports i
  where i.household_id=p_household_id
    and i.purchase_id is null
    and (i.exact_pdf_hash=p_exact_pdf_hash or i.content_hash=p_content_hash);
  get diagnostics released_count = row_count;

  if released_count>0 then
    perform private.log_activity(p_household_id,'orphaned_import_fingerprint_released',null);
  end if;
  return released_count;
end;
$$;

revoke all on function public.release_orphaned_invoice_fingerprints(uuid,text,text)
  from public,anon,authenticated;
grant execute on function public.release_orphaned_invoice_fingerprints(uuid,text,text)
  to authenticated;

notify pgrst,'reload schema';
commit;
