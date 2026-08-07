-- ONE read-only Possible buys eligibility report.
-- Run this entire file unchanged in Supabase SQL Editor. It returns one result
-- row per normalized reviewed item and never updates production data.
-- Raw PDFs, extracted receipt text, and item UUIDs are intentionally absent.

with reviewed_items as (
  select
    p.household_id,
    p.purchased_on,
    i.name,
    i.is_personal,
    i.is_tracked_for_restock,
    (i.name ~* '\m(fee|charges?)\M') as is_fee_or_charge,
    trim(regexp_replace(regexp_replace(lower(trim(i.name)), '[^[:alnum:]]+', ' ', 'g'), '\s+', ' ', 'g')) as normalized_name
  from public.purchase_items i
  join public.purchases p on p.id = i.purchase_id
  where p.archived_at is null
), candidates as (
  select
    household_id,
    normalized_name,
    min(name) as display_item,
    array_agg(distinct purchased_on order by purchased_on) as all_purchase_dates,
    coalesce(
      array_agg(distinct purchased_on order by purchased_on) filter (
        where not is_personal and not is_fee_or_charge and is_tracked_for_restock
      ), array[]::date[]
    ) as qualifying_dates,
    count(distinct purchased_on) filter (
      where not is_personal and not is_fee_or_charge and is_tracked_for_restock
    )::integer as distinct_qualifying_dates,
    bool_or(not is_personal and not is_fee_or_charge and is_tracked_for_restock) as has_tracked_appearance,
    bool_or(not is_personal and not is_fee_or_charge and not is_tracked_for_restock) as has_untracked_appearance,
    bool_and(is_personal) as all_appearances_personal,
    bool_and(is_fee_or_charge) as all_appearances_fee_or_charge,
    bool_or(is_personal or is_fee_or_charge) as has_excluded_appearance
  from reviewed_items
  where normalized_name <> ''
  group by household_id, normalized_name
)
select
  household_id,
  display_item,
  all_purchase_dates,
  qualifying_dates,
  distinct_qualifying_dates,
  case
    when all_appearances_personal then 'personal'
    when all_appearances_fee_or_charge then 'fee/charge'
    when has_tracked_appearance and has_untracked_appearance then 'mixed tracked and untracked'
    when has_tracked_appearance then 'tracked'
    when has_untracked_appearance then 'untracked'
    else 'excluded'
  end as tracking_status,
  case
    when all_appearances_personal then 'personal item excluded'
    when all_appearances_fee_or_charge then 'fee/charge excluded'
    when has_excluded_appearance then 'some appearances excluded'
    else 'none'
  end as personal_fee_exclusion,
  (distinct_qualifying_dates >= 2) as possible_buys_eligible,
  case
    when distinct_qualifying_dates >= 2 then 'eligible now'
    when distinct_qualifying_dates = 1 then 'needs a tracked purchase on another date'
    when has_untracked_appearance then 'untracked'
    when all_appearances_personal then 'personal item excluded'
    when all_appearances_fee_or_charge then 'fee/charge excluded'
    else 'no qualifying tracked purchase'
  end as eligibility_reason
from candidates
order by possible_buys_eligible desc, display_item, household_id;
