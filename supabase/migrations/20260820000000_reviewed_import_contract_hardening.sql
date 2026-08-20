-- Harden every reviewed-receipt import overload around one validation and write
-- path. Existing clients may omit item_kind/include_in_total; such rows retain
-- their historical product/included meaning. Explicit fee and excluded
-- informational rows are persisted as reviewed facts, while only included rows
-- contribute to receipt totals, shared balance, or settlement capacity.
begin;

alter table public.purchase_items
  add column if not exists item_kind text not null default 'product',
  add column if not exists include_in_total boolean not null default true,
  add column if not exists shared_line_total numeric(12,2);
update public.purchase_items
set shared_line_total=case when is_personal then 0 else coalesce(line_total,0) end
where shared_line_total is null;
alter table public.purchase_items alter column shared_line_total set default 0;
alter table public.purchase_items alter column shared_line_total set not null;
alter table public.purchase_items
  drop constraint if exists purchase_items_item_kind_check;
alter table public.purchase_items
  add constraint purchase_items_item_kind_check check(item_kind in (
    'product','fee','tax','discount','credit','rounding','informational'
  ));
alter table public.purchase_items
  drop constraint if exists purchase_items_line_total_check;
alter table public.purchase_items
  add constraint purchase_items_line_total_check check(
    line_total is not null and line_total between -9999999999.99 and 9999999999.99
  ) not valid;
alter table public.purchase_items
  drop constraint if exists purchase_items_fee_restock_check;
alter table public.purchase_items
  add constraint purchase_items_fee_restock_check
  check((item_kind='product' and include_in_total) or not is_tracked_for_restock);
alter table public.purchase_items
  drop constraint if exists purchase_items_component_inclusion_check;
alter table public.purchase_items
  add constraint purchase_items_component_inclusion_check check(
    (include_in_total or shared_line_total=0)
    and (
      (line_total>=0 and shared_line_total between 0 and line_total)
      or (line_total<0 and shared_line_total between line_total and 0)
    )
  );

create or replace function private.validate_reviewed_purchase_items(
  p_items jsonb,
  p_allow_ids boolean
)
returns table(
  normalized_items jsonb,
  derived_amount numeric,
  derived_is_personal boolean,
  has_shared_items boolean,
  derived_shared_amount numeric
) language plpgsql set search_path = '' as $$
declare
  item jsonb;
  item_id uuid;
  item_name text;
  item_unit text;
  item_kind text;
  item_quantity numeric;
  item_unit_price numeric;
  item_line_total numeric;
  item_is_personal boolean;
  item_is_restock boolean;
  item_include_in_total boolean;
  item_shared_line_total numeric;
  shared_allocation_provided boolean;
  item_use_by date;
  item_order integer;
  submitted_orders integer[] := array[]::integer[];
  submitted_ids uuid[] := array[]::uuid[];
  has_personal_positive boolean := false;
  has_shared_positive boolean := false;
  has_implicit_signed_allocation boolean := false;
begin
  if p_items is null or jsonb_typeof(p_items)<>'array'
    or jsonb_array_length(p_items)<1 or jsonb_array_length(p_items)>100 then
    raise exception 'At least one and at most 100 reviewed items are required';
  end if;

  normalized_items := '[]'::jsonb;
  derived_amount := 0;
  derived_shared_amount := 0;
  has_shared_items := false;

  for item in select value from jsonb_array_elements(p_items) loop
    if item is null or jsonb_typeof(item)<>'object'
      or (item - array[
        'name','quantity','unit','unit_price','line_total','is_personal',
        'is_tracked_for_restock','estimated_use_by','display_order',
        'item_kind','include_in_total','shared_line_total','id'
      ]::text[]) <> '{}'::jsonb then
      raise exception 'Reviewed item contains unsupported fields';
    end if;

    if not p_allow_ids and item ? 'id' then
      raise exception 'Reviewed item id is not accepted during import';
    end if;

    begin
      item_id := nullif(item->>'id','')::uuid;
      item_quantity := (item->>'quantity')::numeric;
      item_unit_price := nullif(item->>'unit_price','')::numeric;
      item_line_total := (item->>'line_total')::numeric;
      item_is_personal := coalesce((item->>'is_personal')::boolean,false);
      item_is_restock := coalesce((item->>'is_tracked_for_restock')::boolean,false);
      item_use_by := nullif(item->>'estimated_use_by','')::date;
      item_order := (item->>'display_order')::integer;
      item_include_in_total := coalesce((item->>'include_in_total')::boolean,true);
      shared_allocation_provided := item ? 'shared_line_total';
      item_shared_line_total := nullif(item->>'shared_line_total','')::numeric;
    exception
      when invalid_text_representation or invalid_datetime_format
        or numeric_value_out_of_range or datetime_field_overflow then
      raise exception 'Reviewed item has an invalid typed value';
    end;

    item_name := trim(item->>'name');
    item_unit := nullif(trim(item->>'unit'),'');
    item_kind := coalesce(nullif(trim(item->>'item_kind'),''),'product');
    item_unit_price := round(item_unit_price,2);
    item_line_total := round(item_line_total,2);

    if item_kind not in ('product','fee','tax','discount','credit','rounding','informational') then
      raise exception 'Reviewed item kind is invalid';
    end if;
    if coalesce(char_length(item_name) not between 1 and 160
      or item_name ~ '[[:cntrl:]]',true) then
      raise exception 'Reviewed item name must be 1 to 160 characters without control characters';
    end if;
    if item_quantity is null or item_quantity<=0 or item_quantity>9999999.999 then
      raise exception 'Reviewed item quantity must be positive';
    end if;
    if item_unit is not null and (char_length(item_unit)>30 or item_unit ~ '[[:cntrl:]]') then
      raise exception 'Reviewed item unit must be at most 30 characters without control characters';
    end if;
    if item_unit_price is not null
      and (item_unit_price<0 or item_unit_price>9999999999.99) then
      raise exception 'Reviewed item unit price is invalid';
    end if;
    if item_line_total is null or item_line_total < -9999999999.99
      or item_line_total>9999999999.99 then
      raise exception 'Reviewed item line total is invalid';
    end if;
    if item_order is null or item_order<0 or item_order>=jsonb_array_length(p_items)
      or item_order=any(submitted_orders) then
      raise exception 'Reviewed item display order is invalid';
    end if;
    submitted_orders := array_append(submitted_orders,item_order);
    if item_is_personal and item_is_restock then
      raise exception 'Personal items cannot be tracked for household restock';
    end if;
    if item_is_restock and (item_kind<>'product' or not item_include_in_total) then
      raise exception 'Only included merchandise products can be tracked for restock';
    end if;
    if item_kind in ('product','fee','tax') and item_line_total<=0 then
      raise exception 'Positive receipt component has an invalid signed total';
    end if;
    if item_kind in ('discount','credit') and item_line_total>=0 then
      raise exception 'Discount or credit must have a negative signed total';
    end if;
    if item_kind='rounding' and (item_line_total=0 or abs(item_line_total)>1) then
      raise exception 'Rounding adjustment must be nonzero and at most one rupee';
    end if;
    if item_kind='informational' and item_include_in_total then
      raise exception 'Informational rows cannot be included in the receipt total';
    end if;
    if item_kind in ('discount','credit','rounding','informational')
      and item_unit_price is not null then
      raise exception 'Adjustment components cannot have a unit price';
    end if;

    if not item_include_in_total then
      item_shared_line_total := 0;
    elsif item_kind in ('product','fee','tax') then
      if shared_allocation_provided and item_shared_line_total is distinct from
        (case when item_is_personal then 0::numeric else item_line_total end) then
        raise exception 'Positive component shared allocation conflicts with its personal status';
      end if;
      item_shared_line_total := case when item_is_personal then 0 else item_line_total end;
    else
      if item_shared_line_total is null then
        item_shared_line_total := case when item_is_personal then 0 else item_line_total end;
        has_implicit_signed_allocation := true;
      end if;
    end if;
    item_shared_line_total := round(item_shared_line_total,2);
    if (item_line_total>=0 and (item_shared_line_total<0 or item_shared_line_total>item_line_total))
      or (item_line_total<0 and (item_shared_line_total<item_line_total or item_shared_line_total>0)) then
      raise exception 'Reviewed component shared allocation is invalid';
    end if;
    if item_include_in_total and item_line_total<0
      and item_is_personal is distinct from (item_shared_line_total=0) then
      raise exception 'Signed component personal status conflicts with its shared allocation';
    end if;
    if item_id is not null then
      if item_id=any(submitted_ids) then raise exception 'Reviewed item id must be unique'; end if;
      submitted_ids := array_append(submitted_ids,item_id);
    end if;

    normalized_items := normalized_items || jsonb_build_array(jsonb_build_object(
      'id',item_id,
      'name',item_name,
      'quantity',item_quantity,
      'unit',item_unit,
      'unit_price',item_unit_price,
      'line_total',item_line_total,
      'is_personal',item_is_personal,
      'is_tracked_for_restock',item_is_restock,
      'estimated_use_by',item_use_by,
      'display_order',item_order,
      'item_kind',item_kind,
      'include_in_total',item_include_in_total,
      'shared_line_total',item_shared_line_total
    ));
    if item_include_in_total then
      derived_amount := derived_amount+item_line_total;
      if item_line_total>0 and item_shared_line_total=0 then has_personal_positive := true; end if;
      if item_line_total>0 and item_shared_line_total>0 then has_shared_positive := true; end if;
      if item_shared_line_total<>0 then
        has_shared_items := true;
      end if;
      derived_shared_amount := derived_shared_amount+item_shared_line_total;
    end if;
  end loop;

  if has_personal_positive and has_shared_positive and has_implicit_signed_allocation then
    raise exception 'Mixed personal and shared receipts require explicit adjustment allocation';
  end if;

  derived_amount := round(derived_amount,2);
  derived_shared_amount := round(derived_shared_amount,2);
  if derived_amount<=0 or derived_amount>9999999999.99 then
    raise exception 'Reviewed receipt total must be positive';
  end if;
  derived_is_personal := not has_shared_items;
  return next;
end;
$$;

create or replace function private.import_reviewed_purchase_core(
  p_household_id uuid, p_paid_by uuid, p_exact_pdf_hash text, p_content_hash text,
  p_content_hash_reliable boolean, p_label text, p_category text, p_amount numeric,
  p_purchased_on date, p_is_personal boolean, p_items jsonb
) returns uuid language plpgsql set search_path = '' as $$
declare
  new_purchase_id uuid;
  new_import_id uuid;
  item jsonb;
  validated_items jsonb;
  validated_amount numeric;
  validated_is_personal boolean;
  validated_has_shared boolean;
begin
  if auth.uid() is null or not private.is_household_active_member(p_household_id) then
    raise exception 'Active household membership is required';
  end if;
  if not exists(
    select 1 from public.household_members
    where household_id=p_household_id and user_id=p_paid_by
  ) then
    raise exception 'Selected payer must be an active household member';
  end if;
  if p_exact_pdf_hash is null or p_exact_pdf_hash !~ '^[0-9a-f]{64}$'
    or p_content_hash is null or p_content_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid duplicate fingerprint';
  end if;
  if p_content_hash_reliable is null then
    raise exception 'Content fingerprint reliability is required';
  end if;
  if coalesce(char_length(trim(p_label)) not between 1 and 160
    or p_label ~ '[[:cntrl:]]',true) then
    raise exception 'Receipt label must be 1 to 160 characters without control characters';
  end if;
  if p_category is null
    or p_category not in ('Groceries','Food','Wi-Fi','Water','Household','Other') then
    raise exception 'Invalid receipt category';
  end if;
  if p_purchased_on is null then raise exception 'Purchase date is required'; end if;

  select v.normalized_items,v.derived_amount,v.derived_is_personal,v.has_shared_items
  into validated_items,validated_amount,validated_is_personal,validated_has_shared
  from private.validate_reviewed_purchase_items(p_items,false) v;

  if p_amount is null or p_amount<0 or p_amount>9999999999.99
    or round(p_amount,2)<>validated_amount then
    raise exception 'Receipt amount must match reviewed included item totals';
  end if;
  if p_is_personal is null or p_is_personal<>validated_is_personal then
    raise exception 'Purchase allocation must match its reviewed items';
  end if;
  if validated_has_shared and not private.is_household_ready(p_household_id) then
    raise exception 'A partner must join before adding shared expenses';
  end if;

  begin
    insert into public.invoice_imports(
      household_id,exact_pdf_hash,content_hash,content_hash_reliable,imported_by
    ) values(
      p_household_id,p_exact_pdf_hash,p_content_hash,p_content_hash_reliable,auth.uid()
    ) returning id into new_import_id;
  exception when unique_violation then
    raise exception 'This bill was already imported';
  end;

  insert into public.purchases(
    household_id,label,category,amount,paid_by,purchased_on,is_personal
  ) values(
    p_household_id,trim(p_label),p_category,validated_amount,p_paid_by,
    p_purchased_on,validated_is_personal
  ) returning id into new_purchase_id;

  for item in select value from jsonb_array_elements(validated_items) loop
    insert into public.purchase_items(
      purchase_id,display_order,name,quantity,unit,unit_price,line_total,
      is_personal,is_tracked_for_restock,estimated_use_by,item_kind,include_in_total,
      shared_line_total
    ) values(
      new_purchase_id,(item->>'display_order')::integer,item->>'name',
      (item->>'quantity')::numeric,nullif(item->>'unit',''),
      nullif(item->>'unit_price','')::numeric,(item->>'line_total')::numeric,
      (item->>'is_personal')::boolean,
      (item->>'is_tracked_for_restock')::boolean,
      nullif(item->>'estimated_use_by','')::date,
      item->>'item_kind',(item->>'include_in_total')::boolean,
      (item->>'shared_line_total')::numeric
    );
  end loop;

  update public.invoice_imports set purchase_id=new_purchase_id where id=new_import_id;
  return new_purchase_id;
end;
$$;

-- Recreate all three public compatibility signatures so each delegates to the
-- same hardened core. The two older signatures retain reliable-content=true.
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

create or replace function public.import_reviewed_purchase(
  p_household_id uuid, p_exact_pdf_hash text, p_content_hash text, p_label text,
  p_category text, p_amount numeric, p_purchased_on date,
  p_is_personal boolean, p_items jsonb
) returns uuid language sql security definer set search_path = '' as $$
  select private.import_reviewed_purchase_core(
    p_household_id,auth.uid(),p_exact_pdf_hash,p_content_hash,true,p_label,p_category,
    p_amount,p_purchased_on,p_is_personal,p_items
  )
$$;

-- Settlement capacity follows the same included/shared definition. Shared fees
-- are eligible; excluded informational rows and personal rows have zero capacity.
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
    if not item.include_in_total or item.shared_line_total<=0 then
      raise exception 'Only included shared reviewed items can be settled';
    end if;
    select coalesce(sum(a.amount),0) into item_allocated_total
    from public.settlement_allocations a where a.purchase_item_id=item.id and a.id<>new.id;
    if item_allocated_total+new.amount>round(item.shared_line_total/2,2) then raise exception 'Item allocation exceeds the household share'; end if;
  end if;

  if exists(select 1 from public.purchase_items where purchase_id=receipt.id) then
    select coalesce(sum(shared_line_total) filter(where include_in_total),0)
    into shared_total from public.purchase_items where purchase_id=receipt.id;
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

create or replace function private.member_balance(target_household uuid,target_member uuid)
returns numeric language sql stable security definer set search_path = '' as $$
  with purchase_shared as (
    select p.paid_by,
      case when exists(select 1 from public.purchase_items i where i.purchase_id=p.id)
        then coalesce((select sum(i.shared_line_total) from public.purchase_items i
          where i.purchase_id=p.id and i.include_in_total),0)
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
  validated_items jsonb;
  receipt_total numeric;
  derived_is_personal boolean;
  has_shared_items boolean;
  shared_total numeric;
  submitted_ids uuid[] := array[]::uuid[];
  allocated_total numeric;
  allocated_item_total numeric;
  item_available numeric;
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

  select v.normalized_items,v.derived_amount,v.derived_is_personal,
    v.has_shared_items,v.derived_shared_amount
  into validated_items,receipt_total,derived_is_personal,has_shared_items,shared_total
  from private.validate_reviewed_purchase_items(p_items,true) v;
  if has_shared_items and not private.is_household_ready(target.household_id) then
    raise exception 'A partner must join before saving shared reviewed items';
  end if;

  for item in select value from jsonb_array_elements(validated_items) loop
    item_id := nullif(item->>'id','')::uuid;
    if item_id is not null then
      if not exists(select 1 from public.purchase_items where id=item_id and purchase_id=target.id) then
        raise exception 'Reviewed item does not belong to this receipt';
      end if;
      submitted_ids := array_append(submitted_ids,item_id);
      select coalesce(sum(amount),0) into allocated_item_total
      from public.settlement_allocations where purchase_item_id=item_id;
      item_available := case
        when (item->>'include_in_total')::boolean and (item->>'shared_line_total')::numeric>0
          then round((item->>'shared_line_total')::numeric/2,2)
        else 0::numeric
      end;
      if allocated_item_total>item_available then
        raise exception 'Reviewed item change would exceed its receipt-backed settlement allocation';
      end if;
    end if;
  end loop;
  if exists(
    select 1 from public.settlement_allocations a
    where a.purchase_id=target.id and a.purchase_item_id is not null
      and not (a.purchase_item_id=any(submitted_ids))
  ) then raise exception 'An allocated reviewed item cannot be removed'; end if;
  select coalesce(sum(amount),0) into allocated_total
  from public.settlement_allocations where purchase_id=target.id;
  if allocated_total>round(shared_total/2,2) then
    raise exception 'Receipt change would exceed its receipt-backed settlement allocation';
  end if;

  perform set_config('app.grocery_reviewed_purchase_update','allowed',true);
  update public.purchase_items set display_order=display_order+1000 where purchase_id=target.id;
  for item in select value from jsonb_array_elements(validated_items) loop
    item_id := nullif(item->>'id','')::uuid;
    if item_id is null then
      insert into public.purchase_items(
        purchase_id,display_order,name,quantity,unit,unit_price,line_total,
        is_personal,is_tracked_for_restock,estimated_use_by,item_kind,include_in_total,
        shared_line_total
      ) values(
        target.id,(item->>'display_order')::integer,item->>'name',(item->>'quantity')::numeric,
        nullif(item->>'unit',''),nullif(item->>'unit_price','')::numeric,
        (item->>'line_total')::numeric,(item->>'is_personal')::boolean,
        (item->>'is_tracked_for_restock')::boolean,nullif(item->>'estimated_use_by','')::date,
        item->>'item_kind',(item->>'include_in_total')::boolean,
        (item->>'shared_line_total')::numeric
      ) returning id into item_id;
      submitted_ids := array_append(submitted_ids,item_id);
    else
      update public.purchase_items set
        display_order=(item->>'display_order')::integer,name=item->>'name',
        quantity=(item->>'quantity')::numeric,unit=nullif(item->>'unit',''),
        unit_price=nullif(item->>'unit_price','')::numeric,line_total=(item->>'line_total')::numeric,
        is_personal=(item->>'is_personal')::boolean,
        is_tracked_for_restock=(item->>'is_tracked_for_restock')::boolean,
        estimated_use_by=nullif(item->>'estimated_use_by','')::date,
        item_kind=item->>'item_kind',include_in_total=(item->>'include_in_total')::boolean,
        shared_line_total=(item->>'shared_line_total')::numeric
      where id=item_id and purchase_id=target.id;
    end if;
  end loop;
  delete from public.purchase_items where purchase_id=target.id and not (id=any(submitted_ids));
  update public.purchases set label=trim(p_label),category=p_category,purchased_on=p_purchased_on,
    amount=receipt_total,is_personal=derived_is_personal,
    is_tracked_for_restock=false,estimated_use_by=null,updated_at=now()
  where id=target.id;
  perform private.log_activity(target.household_id,'receipt_review_updated',target.id);
  return target.id;
end;
$$;

revoke all on function private.validate_reviewed_purchase_items(jsonb,boolean)
  from public,anon,authenticated;
revoke all on function private.import_reviewed_purchase_core(
  uuid,uuid,text,text,boolean,text,text,numeric,date,boolean,jsonb
) from public,anon,authenticated;
revoke all on function private.validate_settlement_allocation(),
  private.member_balance(uuid,uuid) from public,anon,authenticated;
revoke all on function public.import_reviewed_purchase(
  uuid,text,text,text,text,numeric,date,boolean,jsonb
) from public,anon,authenticated;
revoke all on function public.import_reviewed_purchase(
  uuid,uuid,text,text,text,text,numeric,date,boolean,jsonb
) from public,anon,authenticated;
revoke all on function public.import_reviewed_purchase(
  uuid,uuid,text,text,boolean,text,text,numeric,date,boolean,jsonb
) from public,anon,authenticated;
revoke all on function public.update_reviewed_purchase(uuid,text,text,date,jsonb)
  from public,anon,authenticated;
grant execute on function public.import_reviewed_purchase(
  uuid,text,text,text,text,numeric,date,boolean,jsonb
) to authenticated;
grant execute on function public.import_reviewed_purchase(
  uuid,uuid,text,text,text,text,numeric,date,boolean,jsonb
) to authenticated;
grant execute on function public.import_reviewed_purchase(
  uuid,uuid,text,text,boolean,text,text,numeric,date,boolean,jsonb
) to authenticated;
grant execute on function public.update_reviewed_purchase(uuid,text,text,date,jsonb)
  to authenticated;

notify pgrst,'reload schema';
commit;
