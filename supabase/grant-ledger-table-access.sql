-- Grocery Ledger data API grant repair — run ONCE after schema.sql.
-- RLS policies restrict rows; these grants merely allow authenticated browser
-- requests to reach the tables so the policies can be evaluated.

grant select on table public.households, public.household_members, public.purchases, public.settlements to authenticated;
grant insert, update, delete on table public.purchases to authenticated;
grant insert, delete on table public.settlements to authenticated;
