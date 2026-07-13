-- Grocery Ledger security hardening migration — run ONCE after schema.sql.
-- Removes the default public EXECUTE grants reported by Supabase Security Advisor.
-- No receipt, address, payment, card, bank, UPI, or payment-reference data is added.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

create or replace function private.is_household_member(target_household uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.household_members
    where household_id = target_household and user_id = auth.uid()
  );
$$;

-- Point every existing membership policy at the private helper.
alter policy "members read households" on public.households using (private.is_household_member(id));
alter policy "members read memberships" on public.household_members using (private.is_household_member(household_id));
alter policy "members read purchases" on public.purchases using (private.is_household_member(household_id));
alter policy "members create purchases" on public.purchases with check (private.is_household_member(household_id) and paid_by = auth.uid());
alter policy "members update purchases" on public.purchases using (private.is_household_member(household_id)) with check (private.is_household_member(household_id));
alter policy "members delete purchases" on public.purchases using (private.is_household_member(household_id));
alter policy "members read settlements" on public.settlements using (private.is_household_member(household_id));
alter policy "members create settlements" on public.settlements with check (private.is_household_member(household_id) and payer = auth.uid());
alter policy "members delete settlements" on public.settlements using (private.is_household_member(household_id));

-- Existing functions, including Supabase's rls_auto_enable helper, are no
-- longer callable by public, anonymous, or ordinary signed-in clients.
revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;

-- Prevent new public functions from inheriting broad execute permissions.
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;

-- The only browser-callable functions are authenticated create/join actions.
grant execute on function public.create_household(text) to authenticated;
grant execute on function public.join_household(uuid) to authenticated;

-- The helper is not exposed through the Data API; this grant is required for
-- membership policies to evaluate for authenticated queries.
grant execute on function private.is_household_member(uuid) to authenticated;

-- Retire the former public helper after policies no longer depend on it.
revoke execute on function public.is_household_member(uuid) from public, anon, authenticated;
