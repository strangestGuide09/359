-- Exact PDF hashes remain authoritative duplicate evidence. Content hashes are
-- used only when the client confirms that its local normalized derivative had
-- enough information to be reliable. No PDF or extracted text is persisted.
begin;

alter table public.invoice_imports
  add column if not exists content_hash_reliable boolean not null default true;

alter table public.invoice_imports
  drop constraint if exists invoice_imports_household_id_content_hash_key;
create unique index if not exists invoice_imports_reliable_content_hash_key
  on public.invoice_imports(household_id,content_hash)
  where content_hash_reliable;

create or replace function private.cleanup_unlinked_imports_after_last_purchase()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists(select 1 from public.purchases where household_id=old.household_id) then
    delete from public.invoice_imports
    where household_id=old.household_id and purchase_id is null;
  end if;
  return old;
end;
$$;

drop trigger if exists cleanup_unlinked_imports_after_last_purchase on public.purchases;
create trigger cleanup_unlinked_imports_after_last_purchase
after delete on public.purchases
for each row execute function private.cleanup_unlinked_imports_after_last_purchase();

create or replace function private.import_reviewed_purchase_core(
  p_household_id uuid, p_paid_by uuid, p_exact_pdf_hash text, p_content_hash text,
  p_content_hash_reliable boolean, p_label text, p_category text, p_amount numeric,
  p_purchased_on date, p_is_personal boolean, p_items jsonb
) returns uuid language plpgsql set search_path = '' as $$
declare new_purchase_id uuid; new_import_id uuid; item jsonb; item_index integer := 0; has_shared_items boolean;
begin
  if auth.uid() is null or not private.is_household_active_member(p_household_id) then raise exception 'Active household membership is required'; end if;
  if not private.is_household_owner(p_household_id) then raise exception 'Only the household owner can release an orphaned fingerprint'; end if;
  if not exists(select 1 from public.household_members where household_id=p_household_id and user_id=p_paid_by) then raise exception 'Selected payer must be an active household member'; end if;
  if p_content_hash_reliable is null then raise exception 'Content fingerprint reliability is required'; end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'At least one reviewed item is required'; end if;
  select coalesce(bool_or(not coalesce((value->>'is_personal')::boolean,false)),false)
    into has_shared_items from jsonb_array_elements(p_items);
  if p_is_personal<>not has_shared_items then raise exception 'Purchase allocation must match its reviewed items'; end if;
  if has_shared_items and not private.is_household_ready(p_household_id) then raise exception 'A partner must join before adding shared expenses'; end if;
  begin
    insert into public.invoice_imports(
      household_id,exact_pdf_hash,content_hash,content_hash_reliable,imported_by
    ) values(
      p_household_id,p_exact_pdf_hash,p_content_hash,p_content_hash_reliable,auth.uid()
    ) returning id into new_import_id;
  exception when unique_violation then
    raise exception 'This bill was already imported';
  end;
  insert into public.purchases(household_id,label,category,amount,paid_by,purchased_on,is_personal)
  values(p_household_id,trim(p_label),p_category,p_amount,p_paid_by,p_purchased_on,p_is_personal)
  returning id into new_purchase_id;
  for item in select value from jsonb_array_elements(p_items) loop
    if item-array['name','quantity','unit','unit_price','line_total','is_personal','is_tracked_for_restock','estimated_use_by','display_order']<>'{}'::jsonb then raise exception 'Reviewed item contains unsupported fields'; end if;
    insert into public.purchase_items(
      purchase_id,display_order,name,quantity,unit,unit_price,line_total,
      is_personal,is_tracked_for_restock,estimated_use_by
    ) values(
      new_purchase_id,coalesce((item->>'display_order')::integer,item_index),trim(item->>'name'),
      (item->>'quantity')::numeric,nullif(trim(item->>'unit'),''),(item->>'unit_price')::numeric,
      (item->>'line_total')::numeric,coalesce((item->>'is_personal')::boolean,false),
      coalesce((item->>'is_tracked_for_restock')::boolean,false),(item->>'estimated_use_by')::date
    );
    item_index := item_index+1;
  end loop;
  update public.invoice_imports set purchase_id=new_purchase_id where id=new_import_id;
  return new_purchase_id;
end;
$$;

create or replace function public.import_reviewed_purchase(
  p_household_id uuid, p_paid_by uuid, p_exact_pdf_hash text, p_content_hash text,
  p_label text, p_category text, p_amount numeric, p_purchased_on date,
  p_is_personal boolean, p_items jsonb
) returns uuid language sql security definer set search_path = '' as $$
  select private.import_reviewed_purchase_core(
    p_household_id,p_paid_by,p_exact_pdf_hash,p_content_hash,true,p_label,p_category,
    p_amount,p_purchased_on,p_is_personal,p_items
  )
$$;

create or replace function public.import_reviewed_purchase(
  p_household_id uuid, p_paid_by uuid, p_exact_pdf_hash text, p_content_hash text,
  p_content_hash_reliable boolean, p_label text, p_category text, p_amount numeric,
  p_purchased_on date, p_is_personal boolean, p_items jsonb
) returns uuid language sql security definer set search_path = '' as $$
  select private.import_reviewed_purchase_core(
    p_household_id,p_paid_by,p_exact_pdf_hash,p_content_hash,p_content_hash_reliable,
    p_label,p_category,p_amount,p_purchased_on,p_is_personal,p_items
  )
$$;

create or replace function public.find_invoice_duplicate(
  p_household_id uuid,p_exact_pdf_hash text,p_content_hash text
) returns table(
  duplicate_status text,match_basis text,purchase_id uuid,
  purchase_archived boolean,can_restore boolean
) language plpgsql stable security definer set search_path = '' as $$
declare
  match_count integer;
  matched public.invoice_imports%rowtype;
  purchase public.purchases%rowtype;
begin
  if auth.uid() is null or not private.is_household_active_member(p_household_id) then raise exception 'Active household membership is required'; end if;
  if p_exact_pdf_hash is null or p_exact_pdf_hash !~ '^[0-9a-f]{64}$'
    or p_content_hash is null or p_content_hash !~ '^[0-9a-f]{64}$' then raise exception 'Invalid duplicate fingerprint'; end if;
  select count(*)::integer into match_count from public.invoice_imports i
  where i.household_id=p_household_id and (
    i.exact_pdf_hash=p_exact_pdf_hash
    or (i.content_hash_reliable and i.content_hash=p_content_hash)
  );
  if match_count=0 then return query select 'none'::text,null::text,null::uuid,false,false; return;
  elsif match_count>1 then return query select 'ambiguous'::text,'ambiguous'::text,null::uuid,false,false; return;
  end if;
  select * into matched from public.invoice_imports i
  where i.household_id=p_household_id and (
    i.exact_pdf_hash=p_exact_pdf_hash
    or (i.content_hash_reliable and i.content_hash=p_content_hash)
  );
  match_basis := case
    when matched.exact_pdf_hash=p_exact_pdf_hash and matched.content_hash_reliable and matched.content_hash=p_content_hash then 'exact_and_content'
    when matched.exact_pdf_hash=p_exact_pdf_hash then 'exact'
    else 'content'
  end;
  if matched.purchase_id is null then
    return query select 'legacy_unlinked'::text,match_basis,null::uuid,false,false; return;
  end if;
  select * into purchase from public.purchases p
  where p.id=matched.purchase_id and p.household_id=p_household_id;
  if not found then return query select 'legacy_unlinked'::text,match_basis,null::uuid,false,false; return; end if;
  purchase_id := purchase.id;
  purchase_archived := purchase.archived_at is not null;
  can_restore := purchase_archived and (purchase.paid_by=auth.uid() or private.is_household_owner(p_household_id));
  duplicate_status := case when not purchase_archived then 'linked_active'
    when can_restore then 'linked_archived_restorable'
    else 'linked_archived_not_authorized' end;
  return next;
end;
$$;

create or replace function public.release_orphaned_invoice_fingerprints(
  p_household_id uuid,p_exact_pdf_hash text,p_content_hash text
) returns integer language plpgsql security definer set search_path = '' as $$
declare released_count integer;
begin
  if auth.uid() is null or not private.is_household_active_member(p_household_id) then raise exception 'Active household membership is required'; end if;
  if p_exact_pdf_hash is null or p_exact_pdf_hash !~ '^[0-9a-f]{64}$'
    or p_content_hash is null or p_content_hash !~ '^[0-9a-f]{64}$' then raise exception 'Invalid duplicate fingerprint'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_household_id::text,7));
  if exists(select 1 from public.invoice_imports i where i.household_id=p_household_id
    and i.exact_pdf_hash=p_exact_pdf_hash and i.purchase_id is not null) then
    raise exception 'A linked receipt fingerprint cannot be released';
  end if;
  -- Exact-PDF confirmation targets only the orphan row selected by the owner.
  -- Never delete a different PDF's reservation merely because a content hash
  -- happened to match.
  delete from public.invoice_imports i where i.household_id=p_household_id
    and i.purchase_id is null and i.exact_pdf_hash=p_exact_pdf_hash;
  get diagnostics released_count=row_count;
  if released_count>0 then perform private.log_activity(p_household_id,'orphaned_import_fingerprint_released',null); end if;
  return released_count;
end;
$$;

revoke all on function private.import_reviewed_purchase_core(uuid,uuid,text,text,boolean,text,text,numeric,date,boolean,jsonb)
  from public,anon,authenticated;
revoke all on function private.cleanup_unlinked_imports_after_last_purchase()
  from public,anon,authenticated;
revoke all on function public.import_reviewed_purchase(uuid,uuid,text,text,boolean,text,text,numeric,date,boolean,jsonb)
  from public,anon,authenticated;
grant execute on function public.import_reviewed_purchase(uuid,uuid,text,text,boolean,text,text,numeric,date,boolean,jsonb)
  to authenticated;

notify pgrst,'reload schema';
commit;
