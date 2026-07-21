-- OPTIONAL MANUAL backfill for individually confirmed legacy items only.
-- Do not run until restock_history_audit.sql has been reviewed and each UUID
-- below has been confirmed with the user. This never selects by date alone.

begin;

create temporary table confirmed_restock_items (
  household_id uuid not null,
  item_id uuid primary key
) on commit drop;

-- Replace these examples with exact confirmed purchase_items.id values, then
-- uncomment the INSERT. Never paste purchase IDs or select every old row.
-- insert into confirmed_restock_items(household_id,item_id) values
--   ('00000000-0000-0000-0000-000000000000','00000000-0000-0000-0000-000000000001'),
--   ('00000000-0000-0000-0000-000000000000','00000000-0000-0000-0000-000000000002');

do $$
begin
  if not exists (select 1 from confirmed_restock_items) then
    raise exception 'No item UUIDs were confirmed; no restock flags were changed';
  end if;
end;
$$;

-- Every confirmed UUID must resolve to a non-personal reviewed item in the
-- explicitly confirmed household.
do $$
begin
  if exists (
    select 1 from confirmed_restock_items confirmed
    left join public.purchase_items i on i.id = confirmed.item_id and not i.is_personal
    left join public.purchases p on p.id = i.purchase_id and p.household_id = confirmed.household_id
    where i.id is null or p.id is null
  ) then
    raise exception 'A confirmed UUID is missing, personal, or in another household; transaction rolled back';
  end if;
end;
$$;

-- The predicates protect personal rows and make repeated execution idempotent.
update public.purchase_items i
set is_tracked_for_restock = true
from confirmed_restock_items confirmed, public.purchases p
where i.id = confirmed.item_id
  and p.id = i.purchase_id
  and p.household_id = confirmed.household_id
  and not i.is_personal
  and not i.is_tracked_for_restock
returning i.id, i.purchase_id, i.name, i.is_tracked_for_restock;

commit;
