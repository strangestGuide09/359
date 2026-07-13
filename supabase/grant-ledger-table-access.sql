-- Grocery Ledger Data API access repair — safe to run again.
-- RLS policies still restrict rows. These grants only let authenticated browser
-- requests reach the tables so those policies can be evaluated.

grant usage on schema public to authenticated;
grant select on table public.households, public.household_members, public.purchases, public.settlements to authenticated;
grant insert, update, delete on table public.purchases to authenticated;
grant insert, delete on table public.settlements to authenticated;

-- Tell PostgREST (the Supabase Data API) to reload its schema/privileges now.
notify pgrst, 'reload schema';

-- Expected result: all four values are true.
select
  has_schema_privilege('authenticated', 'public', 'usage') as public_schema_usage,
  has_table_privilege('authenticated', 'public.household_members', 'select') as membership_read,
  has_table_privilege('authenticated', 'public.purchases', 'select,insert,update,delete') as purchase_access,
  has_table_privilege('authenticated', 'public.settlements', 'select,insert,delete') as settlement_access;
