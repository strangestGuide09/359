-- Live additive migration: private household display names and selected payer.
-- Run once AFTER 20260715000000_clean_bootstrap.sql.
-- No email, PDF, extracted text, or payment credential is stored.

begin;

alter table public.household_members add column display_name text;
update public.household_members
set display_name = case role when 'owner' then 'Household owner' else 'Household partner' end;
alter table public.household_members
  alter column display_name set not null,
  add constraint household_members_display_name_check
    check (char_length(trim(display_name)) between 1 and 80 and display_name !~ '[[:cntrl:]]');

create or replace function public.create_household(household_name text, p_display_name text)
returns table(id uuid, invite_code uuid)
language plpgsql security definer set search_path = '' as $$
declare new_id uuid; new_code uuid;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if coalesce(char_length(trim(p_display_name)) not between 1 and 80 or p_display_name ~ '[[:cntrl:]]',true) then raise exception 'Display name must be 1 to 80 characters without control characters'; end if;
  insert into public.households (name, created_by) values (trim(household_name), auth.uid()) returning households.id into new_id;
  insert into public.household_members (household_id, user_id, display_name, role) values (new_id, auth.uid(), trim(p_display_name), 'owner');
  insert into public.household_invites (household_id, created_by) values (new_id, auth.uid()) returning household_invites.invite_code into new_code;
  return query select new_id, new_code;
end;
$$;

create or replace function public.create_household(household_name text)
returns table(id uuid, invite_code uuid)
language sql security definer set search_path = '' as $$
  select * from public.create_household(household_name, 'Household owner')
$$;

create or replace function public.join_household(code uuid, p_display_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare target_household uuid;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if coalesce(char_length(trim(p_display_name)) not between 1 and 80 or p_display_name ~ '[[:cntrl:]]',true) then raise exception 'Display name must be 1 to 80 characters without control characters'; end if;
  select i.household_id into target_household from public.household_invites i
  join public.households h on h.id = i.household_id
  where i.invite_code = code and i.revoked_at is null and h.archived_at is null;
  if target_household is null then raise exception 'Invalid or inactive household invite code'; end if;
  if exists (select 1 from public.household_members where household_id=target_household and user_id=auth.uid()) then return target_household; end if;
  insert into public.household_members (household_id,user_id,display_name,role)
  values (target_household,auth.uid(),trim(p_display_name),'partner');
  update public.household_invites set revoked_at=now() where invite_code=code;
  perform private.log_activity(target_household,'member_joined',auth.uid());
  return target_household;
end;
$$;

create or replace function public.join_household(code uuid)
returns uuid language sql security definer set search_path = '' as $$
  select public.join_household(code, 'Household partner')
$$;

create or replace function public.set_member_display_name(p_display_name text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if coalesce(char_length(trim(p_display_name)) not between 1 and 80 or p_display_name ~ '[[:cntrl:]]',true) then raise exception 'Display name must be 1 to 80 characters without control characters'; end if;
  update public.household_members m set display_name=trim(p_display_name)
  from public.households h
  where m.household_id=h.id and m.user_id=auth.uid() and h.archived_at is null;
  if not found then raise exception 'Active household membership is required'; end if;
end;
$$;

create or replace function public.set_my_display_name(p_display_name text)
returns void language sql security definer set search_path = '' as $$
  select public.set_member_display_name(p_display_name)
$$;

create or replace function public.import_reviewed_purchase(
  p_household_id uuid, p_paid_by uuid, p_exact_pdf_hash text, p_content_hash text, p_label text,
  p_category text, p_amount numeric, p_purchased_on date, p_is_personal boolean, p_items jsonb
) returns uuid language plpgsql security definer set search_path = '' as $$
declare new_purchase_id uuid; item jsonb; item_index integer := 0; has_shared_items boolean;
begin
  if auth.uid() is null or not private.is_household_active_member(p_household_id) then raise exception 'Active household membership is required'; end if;
  if not exists (select 1 from public.household_members where household_id=p_household_id and user_id=p_paid_by) then raise exception 'Selected payer must be an active household member'; end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'At least one reviewed item is required'; end if;
  select coalesce(bool_or(not coalesce((value->>'is_personal')::boolean,false)),false) into has_shared_items from jsonb_array_elements(p_items);
  if p_is_personal <> not has_shared_items then raise exception 'Purchase allocation must match its reviewed items'; end if;
  if has_shared_items and not private.is_household_ready(p_household_id) then raise exception 'A partner must join before adding shared expenses'; end if;
  insert into public.invoice_imports (household_id,exact_pdf_hash,content_hash,imported_by)
  values (p_household_id,p_exact_pdf_hash,p_content_hash,auth.uid());
  insert into public.purchases (household_id,label,category,amount,paid_by,purchased_on,is_personal)
  values (p_household_id,trim(p_label),p_category,p_amount,p_paid_by,p_purchased_on,p_is_personal)
  returning id into new_purchase_id;
  for item in select value from jsonb_array_elements(p_items) loop
    if item-array['name','quantity','unit','unit_price','line_total','is_personal','is_tracked_for_restock','estimated_use_by','display_order']<>'{}'::jsonb then raise exception 'Reviewed item contains unsupported fields'; end if;
    insert into public.purchase_items (purchase_id,display_order,name,quantity,unit,unit_price,line_total,is_personal,is_tracked_for_restock,estimated_use_by)
    values (new_purchase_id,coalesce((item->>'display_order')::integer,item_index),trim(item->>'name'),(item->>'quantity')::numeric,
      nullif(trim(item->>'unit'),''),(item->>'unit_price')::numeric,(item->>'line_total')::numeric,
      coalesce((item->>'is_personal')::boolean,false),coalesce((item->>'is_tracked_for_restock')::boolean,false),(item->>'estimated_use_by')::date);
    item_index := item_index+1;
  end loop;
  return new_purchase_id;
exception when unique_violation then raise exception 'This bill was already imported';
end;
$$;

create or replace function public.import_reviewed_purchase(
  p_household_id uuid, p_exact_pdf_hash text, p_content_hash text, p_label text,
  p_category text, p_amount numeric, p_purchased_on date, p_is_personal boolean, p_items jsonb
) returns uuid language sql security definer set search_path = '' as $$
  select public.import_reviewed_purchase(p_household_id,auth.uid(),p_exact_pdf_hash,p_content_hash,p_label,
    p_category,p_amount,p_purchased_on,p_is_personal,p_items)
$$;

drop policy purchases_insert on public.purchases;
drop policy purchases_update on public.purchases;
drop policy purchases_delete on public.purchases;
drop policy purchase_items_write on public.purchase_items;
create policy purchases_insert on public.purchases for insert with check (
  private.is_household_active_member(household_id) and
  exists (select 1 from public.household_members m where m.household_id=purchases.household_id and m.user_id=purchases.paid_by));
create policy purchases_update on public.purchases for update
  using (private.is_household_active_member(household_id))
  with check (private.is_household_active_member(household_id) and
    exists (select 1 from public.household_members m where m.household_id=purchases.household_id and m.user_id=purchases.paid_by));
create policy purchases_delete on public.purchases for delete using (private.is_household_active_member(household_id));
create policy purchase_items_write on public.purchase_items for all
  using (exists (select 1 from public.purchases p where p.id=purchase_id and private.is_household_active_member(p.household_id)))
  with check (exists (select 1 from public.purchases p where p.id=purchase_id and private.is_household_active_member(p.household_id)));

revoke execute on function public.create_household(text,text),public.join_household(uuid,text),
  public.set_member_display_name(text),public.set_my_display_name(text),
  public.import_reviewed_purchase(uuid,uuid,text,text,text,text,numeric,date,boolean,jsonb)
  from public,anon,authenticated;
grant execute on function public.create_household(text),public.create_household(text,text),
  public.join_household(uuid),public.join_household(uuid,text),public.set_my_display_name(text),
  public.set_member_display_name(text),
  public.import_reviewed_purchase(uuid,text,text,text,text,numeric,date,boolean,jsonb),
  public.import_reviewed_purchase(uuid,uuid,text,text,text,text,numeric,date,boolean,jsonb)
  to authenticated;

notify pgrst, 'reload schema';
commit;
