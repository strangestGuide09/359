-- ONE read-only Possible buys eligibility report.
-- Run this entire file unchanged in Supabase SQL Editor. It returns one result
-- row per normalized reviewed item and never updates production data.
-- Raw PDFs, extracted receipt text, and item UUIDs are intentionally absent.

with reviewed_items as (
  select
    p.household_id,
    p.purchased_on,
    p.category,
    i.name,
    regexp_replace(trim(i.name), '^[[:space:]]*[0-9]{1,2}\.[[:space:]]+', '') as display_item,
    i.is_personal,
    i.is_tracked_for_restock,
    (
      i.name ~* '\m(delivery|handling|platform|convenience|packing|service)[[:space:]]*(fee|fees|charge|charges)?\M'
      or i.name ~* '\m(fee|fees|charges?|tax|gst|cgst|sgst|cess|subtotal|grand total|total payable|amount paid|discount|savings?)\M'
    ) as is_non_merchandise
  from public.purchase_items i
  join public.purchases p on p.id = i.purchase_id
  where p.archived_at is null
), normalized_items as (
  select *,
    trim(regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              regexp_replace(
                regexp_replace(
                  regexp_replace(
                    regexp_replace(
                      regexp_replace(
                        regexp_replace(
                          regexp_replace(
                            regexp_replace(lower(display_item), '^[0-9]{4,8}[[:space:]]+([a-z])', '\1'),
                            '([[:space:]]+-?[0-9]+(\.[0-9]+)?){2,}[[:space:]]*$', ''),
                          '\m(instamart|blinkit)\M', ' ', 'g'),
                        '\mmillilit(er|re)s?\M', 'ml', 'g'),
                      '\mlit(er|re)s?\M', 'l', 'g'),
                    '\mkilograms?\M', 'kg', 'g'),
                  '\mgrams?\M', 'g', 'g'),
                '\mpack[[:space:]]+of[[:space:]]+([0-9]+)\M', '\1 pack', 'g'),
              '([0-9])[[:space:]]*(ml|kg|g|l|pack)\M', '\1\2', 'g'),
            '\mpack\M', ' ', 'g'),
          '[^a-z0-9]+', ' ', 'g'),
        '[[:space:]]+', ' ', 'g'),
      '^(akshayakalpa|anveshan|amul|mother dairy|tata sampann|tata|fortune|aashirvaad|everyday)([[:space:]]+|$)', ''
    )) as branded_key
  from reviewed_items
), keyed_items as (
  select *, regexp_replace(branded_key, '^fresh[[:space:]]+', '') as normalized_name
  from normalized_items
), candidates as (
  select
    household_id,
    normalized_name,
    min(display_item) as display_item,
    array_agg(distinct purchased_on order by purchased_on) as all_purchase_dates,
    coalesce(
      array_agg(distinct purchased_on order by purchased_on) filter (
        where category = 'Groceries' and not is_personal and not is_non_merchandise and is_tracked_for_restock
      ), array[]::date[]
    ) as qualifying_dates,
    count(distinct purchased_on) filter (
      where category = 'Groceries' and not is_personal and not is_non_merchandise and is_tracked_for_restock
    )::integer as distinct_qualifying_dates,
    bool_or(category = 'Groceries' and not is_personal and not is_non_merchandise and is_tracked_for_restock) as has_tracked_appearance,
    bool_or(category = 'Groceries' and not is_personal and not is_non_merchandise and not is_tracked_for_restock) as has_untracked_appearance,
    bool_and(is_personal) as all_appearances_personal,
    bool_and(is_non_merchandise) as all_appearances_non_merchandise,
    bool_and(category <> 'Groceries') as all_appearances_non_grocery,
    bool_or(is_personal or is_non_merchandise or category <> 'Groceries') as has_excluded_appearance
  from keyed_items
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
    when all_appearances_non_merchandise then 'delivery/fee/tax'
    when all_appearances_non_grocery then 'non-grocery purchase'
    when has_tracked_appearance and has_untracked_appearance then 'mixed tracked and untracked'
    when has_tracked_appearance then 'tracked'
    when has_untracked_appearance then 'untracked'
    else 'excluded'
  end as tracking_status,
  case
    when all_appearances_personal then 'personal item excluded'
    when all_appearances_non_merchandise then 'delivery/fee/tax excluded'
    when all_appearances_non_grocery then 'non-grocery purchase excluded'
    when has_excluded_appearance then 'some appearances excluded'
    else 'none'
  end as personal_fee_exclusion,
  (distinct_qualifying_dates >= 2) as possible_buys_eligible,
  case
    when distinct_qualifying_dates >= 2 then 'eligible now'
    when distinct_qualifying_dates = 1 then 'needs a tracked purchase on another date'
    when has_untracked_appearance then 'untracked'
    when all_appearances_personal then 'personal item excluded'
    when all_appearances_non_merchandise then 'delivery/fee/tax excluded'
    when all_appearances_non_grocery then 'non-grocery purchase excluded'
    else 'no qualifying tracked purchase'
  end as eligibility_reason
from candidates
order by possible_buys_eligible desc, display_item, household_id;
