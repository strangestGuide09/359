-- Grocery Ledger local-only PDF import support — run ONCE after schema.sql.
-- Supabase stores only SHA-256 fingerprints for duplicate prevention; it never
-- receives the PDF, extracted text, recipient email, address, or payment data.

create table if not exists public.invoice_imports (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  exact_pdf_hash text not null check (exact_pdf_hash ~ '^[0-9a-f]{64}$'),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  imported_by uuid not null references auth.users(id) on delete restrict,
  imported_at timestamptz not null default now(),
  unique (household_id, exact_pdf_hash),
  unique (household_id, content_hash)
);

alter table public.invoice_imports enable row level security;
grant select on table public.invoice_imports to authenticated;
drop policy if exists "members read invoice imports" on public.invoice_imports;
create policy "members read invoice imports" on public.invoice_imports for select using (private.is_household_member(household_id));

create or replace function public.import_purchase(
  p_household_id uuid, p_exact_pdf_hash text, p_content_hash text, p_label text,
  p_category text, p_amount numeric, p_purchased_on date, p_is_personal boolean,
  p_is_tracked_for_restock boolean, p_estimated_use_by date
) returns uuid language plpgsql security definer set search_path = '' as $$
declare new_purchase_id uuid; new_import_id uuid;
begin
  if auth.uid() is null or not private.is_household_member(p_household_id) then raise exception 'Household membership is required'; end if;
  insert into public.invoice_imports (household_id, exact_pdf_hash, content_hash, imported_by)
  values (p_household_id, p_exact_pdf_hash, p_content_hash, auth.uid())
  on conflict do nothing returning id into new_import_id;
  if new_import_id is null then raise exception 'This bill was already imported'; end if;
  insert into public.purchases (household_id, label, category, amount, paid_by, purchased_on, is_personal, is_tracked_for_restock, estimated_use_by)
  values (p_household_id, trim(p_label), p_category, p_amount, auth.uid(), p_purchased_on, p_is_personal, p_is_tracked_for_restock, p_estimated_use_by)
  returning id into new_purchase_id;
  return new_purchase_id;
end;
$$;

revoke execute on function public.import_purchase(uuid, text, text, text, text, numeric, date, boolean, boolean, date) from public, anon, authenticated;
grant execute on function public.import_purchase(uuid, text, text, text, text, numeric, date, boolean, boolean, date) to authenticated;
notify pgrst, 'reload schema';
