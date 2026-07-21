-- Read-only, idempotent restock-history audit.
-- Safe to run repeatedly in Supabase SQL Editor after the clean bootstrap.
-- Returns reviewed structured fields only; it never reads receipt/PDF content.

-- 1. Per-purchase allocation and restock-state counts.
select
  p.household_id,
  p.id as purchase_id,
  p.purchased_on,
  p.created_at as purchase_created_at,
  p.label as reviewed_purchase_label,
  count(i.id)::integer as reviewed_item_count,
  count(i.id) filter (where i.is_personal)::integer as personal_item_count,
  count(i.id) filter (where not i.is_personal)::integer as shared_item_count,
  count(i.id) filter (where not i.is_personal and i.is_tracked_for_restock)::integer as shared_tracked_count,
  count(i.id) filter (where not i.is_personal and not i.is_tracked_for_restock)::integer as shared_untracked_count
from public.purchases p
left join public.purchase_items i on i.purchase_id = p.id
group by p.household_id, p.id, p.purchased_on, p.created_at, p.label
order by p.purchased_on, p.created_at, p.id;

-- 2. Normalized shared item names seen on two or more DISTINCT purchase dates.
-- Same-day Blinkit receipts count as one date and cannot establish an interval.
with normalized_items as (
  select
    p.household_id,
    p.purchased_on,
    i.id as item_id,
    i.name,
    i.is_tracked_for_restock,
    trim(regexp_replace(regexp_replace(lower(trim(i.name)), '[^[:alnum:]]+', ' ', 'g'), '\s+', ' ', 'g')) as normalized_name
  from public.purchase_items i
  join public.purchases p on p.id = i.purchase_id
  where p.archived_at is null and not p.is_personal and not i.is_personal
)
select
  household_id,
  normalized_name,
  min(name) as example_reviewed_name,
  count(*)::integer as reviewed_item_count,
  count(distinct purchased_on)::integer as distinct_purchase_dates,
  array_agg(distinct purchased_on order by purchased_on) as purchase_dates,
  count(*) filter (where is_tracked_for_restock)::integer as tracked_count,
  count(*) filter (where not is_tracked_for_restock)::integer as untracked_count
from normalized_items
where normalized_name <> ''
group by household_id, normalized_name
having count(distinct purchased_on) >= 2
order by household_id, normalized_name;

-- 3. Manual-review candidates. No update is performed.
-- Confirm each item in the product UI before placing its item_id into the
-- separate manual_restock_backfill.sql file. created_at alone is NOT proof
-- that false came from the former default rather than an explicit opt-out.
with all_shared_history as (
  select
    p.household_id,
    p.purchased_on,
    trim(regexp_replace(regexp_replace(lower(trim(i.name)), '[^[:alnum:]]+', ' ', 'g'), '\s+', ' ', 'g')) as normalized_name
  from public.purchase_items i
  join public.purchases p on p.id = i.purchase_id
  where p.archived_at is null and not p.is_personal and not i.is_personal
), normalized_items as (
  select
    p.household_id,
    p.id as purchase_id,
    p.label as reviewed_purchase_label,
    p.purchased_on,
    p.created_at as purchase_created_at,
    i.id as item_id,
    i.name as reviewed_item_name,
    i.created_at as item_created_at,
    trim(regexp_replace(regexp_replace(lower(trim(i.name)), '[^[:alnum:]]+', ' ', 'g'), '\s+', ' ', 'g')) as normalized_name
  from public.purchase_items i
  join public.purchases p on p.id = i.purchase_id
  where p.archived_at is null and not p.is_personal
    and not i.is_personal and not i.is_tracked_for_restock
), name_history as (
  select household_id, normalized_name, count(distinct purchased_on)::integer as distinct_purchase_dates
  from all_shared_history
  where normalized_name <> ''
  group by household_id, normalized_name
)
select n.*, h.distinct_purchase_dates
from normalized_items n
join name_history h using (household_id, normalized_name)
order by n.purchased_on, n.purchase_id, n.item_id;
