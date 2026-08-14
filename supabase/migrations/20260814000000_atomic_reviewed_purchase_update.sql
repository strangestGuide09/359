-- Atomic editing for a saved itemized reviewed receipt. Only reviewed fields
-- cross this boundary; no PDF bytes, extracted text, or provider output enter
-- the database. Existing item IDs preserve receipt-backed allocation links.
begin;

create or replace function private.guard_reviewed_purchase_header_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists(select 1 from public.purchase_items where purchase_id=old.id)
    and current_setting('app.grocery_reviewed_purchase_update',true) is distinct from 'allowed'
    and (new.household_id is distinct from old.household_id
      or new.paid_by is distinct from old.paid_by
      or new.label is distinct from old.label
      or new.category is distinct from old.category
      or new.amount is distinct from old.amount
      or new.purchased_on is distinct from old.purchased_on
      or new.is_personal is distinct from old.is_personal) then
    raise exception 'Use update_reviewed_purchase for itemized receipts';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_reviewed_purchase_header_update on public.purchases;
create trigger guard_reviewed_purchase_header_update
before update on public.purchases
for each row execute function private.guard_reviewed_purchase_header_update();

create or replace function private.guard_purchase_item_link()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.purchase_id is distinct from old.purchase_id then
    raise exception 'Reviewed item purchase link is immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_purchase_item_link on public.purchase_items;
create trigger guard_purchase_item_link
before update of purchase_id on public.purchase_items
for each row execute function private.guard_purchase_item_link();

create or replace function public.update_reviewed_purchase(
  p_purchase_id uuid,
  p_label text,
  p_category text,
  p_purchased_on date,
  p_items jsonb
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  target public.purchases%rowtype;
  item jsonb;
  item_id uuid;
  item_name text;
  item_unit text;
  item_quantity numeric;
  item_unit_price numeric;
  item_line_total numeric;
  item_is_personal boolean;
  item_is_restock boolean;
  item_use_by date;
  item_order integer;
  submitted_ids uuid[] := array[]::uuid[];
  submitted_orders integer[] := array[]::integer[];
  receipt_total numeric := 0;
  shared_total numeric := 0;
  has_shared_items boolean := false;
  allocated_total numeric;
  allocated_item_total numeric;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  select * into target from public.purchases where id=p_purchase_id for update;
  if not found then raise exception 'Receipt not found'; end if;
  if target.archived_at is not null then raise exception 'Restore the receipt before editing it'; end if;
  if not private.is_household_active_member(target.household_id) then raise exception 'Active household membership is required'; end if;
  if auth.uid()<>target.paid_by and not private.is_household_owner(target.household_id) then
    raise exception 'Only the receipt payer or household owner can edit this receipt';
  end if;
  if coalesce(char_length(trim(p_label)) not between 1 and 160 or p_label ~ '[[:cntrl:]]',true) then
    raise exception 'Receipt label must be 1 to 160 characters without control characters';
  end if;
  if p_category is null or p_category not in ('Groceries','Food','Wi-Fi','Water','Household','Other') then raise exception 'Invalid receipt category'; end if;
  if p_purchased_on is null then raise exception 'Purchase date is required'; end if;
  if exists(
    select 1 from public.settlement_allocations a
    join public.settlements s on s.id=a.settlement_id
    where a.purchase_id=target.id and p_purchased_on>s.settled_on
  ) then raise exception 'A receipt cannot be moved after its allocated payment date'; end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 or jsonb_array_length(p_items)>100 then
    raise exception 'At least one and at most 100 reviewed items are required';
  end if;

  for item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(item)<>'object' or (item - array[
      'id','name','quantity','unit','unit_price','line_total','is_personal',
      'is_tracked_for_restock','estimated_use_by','display_order'
    ]::text[]) <> '{}'::jsonb then raise exception 'Reviewed item contains unsupported fields'; end if;

    begin
      item_id := nullif(item->>'id','')::uuid;
      item_quantity := (item->>'quantity')::numeric;
      item_unit_price := nullif(item->>'unit_price','')::numeric;
      item_line_total := (item->>'line_total')::numeric;
      item_is_personal := coalesce((item->>'is_personal')::boolean,false);
      item_is_restock := coalesce((item->>'is_tracked_for_restock')::boolean,false);
      item_use_by := nullif(item->>'estimated_use_by','')::date;
      item_order := (item->>'display_order')::integer;
    exception when invalid_text_representation or invalid_datetime_format or numeric_value_out_of_range or datetime_field_overflow then
      raise exception 'Reviewed item has an invalid typed value';
    end;
    item_name := trim(item->>'name');
    item_unit := nullif(trim(item->>'unit'),'');
    item_unit_price := round(item_unit_price,2);
    item_line_total := round(item_line_total,2);

    if coalesce(char_length(item_name) not between 1 and 160 or item_name ~ '[[:cntrl:]]',true) then raise exception 'Reviewed item name must be 1 to 160 characters without control characters'; end if;
    if item_quantity is null or item_quantity<=0 or item_quantity>9999999.999 then raise exception 'Reviewed item quantity must be positive'; end if;
    if item_unit is not null and (char_length(item_unit)>30 or item_unit ~ '[[:cntrl:]]') then raise exception 'Reviewed item unit must be at most 30 characters without control characters'; end if;
    if item_unit_price is not null and (item_unit_price<0 or item_unit_price>9999999999.99) then raise exception 'Reviewed item unit price is invalid'; end if;
    if item_line_total is null or item_line_total<0 or item_line_total>9999999999.99 then raise exception 'Reviewed item line total is invalid'; end if;
    if item_order is null or item_order<0 or item_order>=jsonb_array_length(p_items) then raise exception 'Reviewed item display order is invalid'; end if;
    if item_order = any (submitted_orders) then raise exception 'Reviewed item display order must be unique'; end if;
    submitted_orders := array_append(submitted_orders,item_order);
    if item_is_personal and item_is_restock then raise exception 'Personal items cannot be tracked for household restock'; end if;

    if item_id is not null then
      if item_id = any (submitted_ids) then raise exception 'Reviewed item id must be unique'; end if;
      if not exists(select 1 from public.purchase_items where id=item_id and purchase_id=target.id) then
        raise exception 'Reviewed item does not belong to this receipt';
      end if;
      submitted_ids := array_append(submitted_ids,item_id);
      select coalesce(sum(amount),0) into allocated_item_total
      from public.settlement_allocations where purchase_item_id=item_id;
      if allocated_item_total > (
        case
          when item_is_personal then 0::numeric
          else round(item_line_total / 2, 2)
        end
      ) then
        raise exception 'Reviewed item change would exceed its receipt-backed settlement allocation';
      end if;
    end if;
    receipt_total := receipt_total+item_line_total;
    if not item_is_personal then
      has_shared_items := true;
      shared_total := shared_total+item_line_total;
    end if;
  end loop;

  if receipt_total<=0 or receipt_total>9999999999.99 then raise exception 'Reviewed receipt total must be positive'; end if;
  if has_shared_items and not private.is_household_ready(target.household_id) then
    raise exception 'A partner must join before saving shared reviewed items';
  end if;
  if exists(
    select 1 from public.settlement_allocations a
    where a.purchase_id=target.id and a.purchase_item_id is not null
      and not (a.purchase_item_id = any (submitted_ids))
  ) then raise exception 'An allocated reviewed item cannot be removed'; end if;
  select coalesce(sum(amount),0) into allocated_total
  from public.settlement_allocations where purchase_id=target.id;
  if allocated_total>round(shared_total/2,2) then
    raise exception 'Receipt change would exceed its receipt-backed settlement allocation';
  end if;

  perform set_config('app.grocery_reviewed_purchase_update','allowed',true);
  -- Move old order values out of the submitted range so swaps remain atomic.
  update public.purchase_items set display_order=display_order+1000 where purchase_id=target.id;

  for item in select value from jsonb_array_elements(p_items) loop
    item_id := nullif(item->>'id','')::uuid;
    item_name := trim(item->>'name');
    item_unit := nullif(trim(item->>'unit'),'');
    item_quantity := (item->>'quantity')::numeric;
    item_unit_price := nullif(item->>'unit_price','')::numeric;
    item_line_total := round((item->>'line_total')::numeric,2);
    item_unit_price := round(item_unit_price,2);
    item_is_personal := coalesce((item->>'is_personal')::boolean,false);
    item_is_restock := coalesce((item->>'is_tracked_for_restock')::boolean,false);
    item_use_by := nullif(item->>'estimated_use_by','')::date;
    item_order := (item->>'display_order')::integer;
    if item_id is null then
      insert into public.purchase_items(
        purchase_id,display_order,name,quantity,unit,unit_price,line_total,
        is_personal,is_tracked_for_restock,estimated_use_by
      ) values(
        target.id,item_order,item_name,item_quantity,item_unit,item_unit_price,item_line_total,
        item_is_personal,item_is_restock,item_use_by
      ) returning id into item_id;
      submitted_ids := array_append(submitted_ids,item_id);
    else
      update public.purchase_items set
        display_order=item_order,name=item_name,quantity=item_quantity,unit=item_unit,
        unit_price=item_unit_price,line_total=item_line_total,is_personal=item_is_personal,
        is_tracked_for_restock=item_is_restock,estimated_use_by=item_use_by
      where id=item_id and purchase_id=target.id;
    end if;
  end loop;
  delete from public.purchase_items
  where purchase_id=target.id and not (id = any (submitted_ids));

  update public.purchases set
    label=trim(p_label),category=p_category,purchased_on=p_purchased_on,
    amount=receipt_total,is_personal=not has_shared_items,
    is_tracked_for_restock=false,estimated_use_by=null,updated_at=now()
  where id=target.id;
  perform private.log_activity(target.household_id,'receipt_review_updated',target.id);
  return target.id;
end;
$$;

revoke all on function private.guard_reviewed_purchase_header_update(),
  private.guard_purchase_item_link() from public,anon,authenticated;
revoke all on function public.update_reviewed_purchase(uuid,text,text,date,jsonb)
  from public,anon,authenticated;
grant execute on function public.update_reviewed_purchase(uuid,text,text,date,jsonb)
  to authenticated;

-- Itemized receipt changes must use the atomic RPC. Imports and this RPC are
-- SECURITY DEFINER and continue to write after these client-table revocations.
revoke insert,update,delete on public.purchase_items from anon,authenticated;

notify pgrst,'reload schema';
commit;
