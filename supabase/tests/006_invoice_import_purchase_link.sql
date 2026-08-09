begin;
create extension if not exists pgtap with schema extensions;
select plan(19);

select has_column('public','invoice_imports','purchase_id','invoice import links its created purchase');
select col_is_fk('public','invoice_imports','purchase_id','purchase link is a foreign key');
select has_trigger('public','invoice_imports','guard_invoice_import_purchase_link','purchase link has a household and immutability guard');
select has_function('public','find_invoice_duplicate',array['uuid','text','text'],'deterministic duplicate lookup RPC exists');
select ok(not has_function_privilege('anon','public.find_invoice_duplicate(uuid,text,text)','execute'),'anonymous duplicate lookup is denied');
select ok(has_function_privilege('authenticated','public.find_invoice_duplicate(uuid,text,text)','execute'),'authenticated duplicate lookup is allowed');

insert into auth.users(id) values
  ('81000000-0000-0000-0000-000000000001'),
  ('81000000-0000-0000-0000-000000000002'),
  ('81000000-0000-0000-0000-000000000003');
insert into public.households(id,name,created_by) values
  ('82000000-0000-0000-0000-000000000001','Linked imports','81000000-0000-0000-0000-000000000001'),
  ('82000000-0000-0000-0000-000000000002','Unrelated','81000000-0000-0000-0000-000000000003');
insert into public.household_members(household_id,user_id,display_name,role) values
  ('82000000-0000-0000-0000-000000000001','81000000-0000-0000-0000-000000000001','Owner','owner'),
  ('82000000-0000-0000-0000-000000000001','81000000-0000-0000-0000-000000000002','Partner','partner'),
  ('82000000-0000-0000-0000-000000000002','81000000-0000-0000-0000-000000000003','Outsider','owner');

set local role authenticated;
set local request.jwt.claim.sub='81000000-0000-0000-0000-000000000001';
select lives_ok($$
  select public.import_reviewed_purchase(
    '82000000-0000-0000-0000-000000000001','81000000-0000-0000-0000-000000000001',
    repeat('a',64),repeat('b',64),'Linked receipt','Groceries',100,current_date,false,
    '[{"name":"Rice","quantity":1,"unit":"bag","unit_price":100,"line_total":100,"is_personal":false,"is_tracked_for_restock":true,"estimated_use_by":null,"display_order":0}]'::jsonb)
$$,'reviewed import succeeds');
select ok((select purchase_id is not null from public.invoice_imports where exact_pdf_hash=repeat('a',64)),'new import stores its purchase link');
select is((select duplicate_status from public.find_invoice_duplicate('82000000-0000-0000-0000-000000000001',repeat('a',64),repeat('b',64))),'linked_active','active linked duplicate is explicit');
select is((select match_basis from public.find_invoice_duplicate('82000000-0000-0000-0000-000000000001',repeat('a',64),repeat('b',64))),'exact_and_content','both fingerprints are reported');
select lives_ok($$select public.delete_purchase_receipt((select purchase_id from public.invoice_imports where exact_pdf_hash=repeat('a',64)))$$,'payer archives linked receipt');
select results_eq(
  $$select duplicate_status,purchase_archived,can_restore from public.find_invoice_duplicate('82000000-0000-0000-0000-000000000001',repeat('a',64),repeat('b',64))$$,
  $$values ('linked_archived_restorable'::text,true,true)$$,
  'payer deterministically discovers a restorable archived receipt');
reset role;

set local role authenticated;
set local request.jwt.claim.sub='81000000-0000-0000-0000-000000000002';
select results_eq(
  $$select duplicate_status,purchase_archived,can_restore from public.find_invoice_duplicate('82000000-0000-0000-0000-000000000001',repeat('a',64),repeat('b',64))$$,
  $$values ('linked_archived_not_authorized'::text,true,false)$$,
  'non-payer partner cannot be offered restoration');
reset role;

insert into public.invoice_imports(household_id,exact_pdf_hash,content_hash,imported_by) values
  ('82000000-0000-0000-0000-000000000001',repeat('c',64),repeat('d',64),'81000000-0000-0000-0000-000000000001'),
  ('82000000-0000-0000-0000-000000000001',repeat('e',64),repeat('f',64),'81000000-0000-0000-0000-000000000001');

set local role authenticated;
set local request.jwt.claim.sub='81000000-0000-0000-0000-000000000001';
select results_eq(
  $$select duplicate_status,purchase_id,can_restore from public.find_invoice_duplicate('82000000-0000-0000-0000-000000000001',repeat('c',64),repeat('d',64))$$,
  $$values ('legacy_unlinked'::text,null::uuid,false)$$,
  'legacy unlinked fingerprint fails closed without guessing');
select results_eq(
  $$select duplicate_status,purchase_id,can_restore from public.find_invoice_duplicate('82000000-0000-0000-0000-000000000001',repeat('c',64),repeat('f',64))$$,
  $$values ('ambiguous'::text,null::uuid,false)$$,
  'cross-row fingerprint match fails closed as ambiguous');
select throws_ok($$
  select public.import_reviewed_purchase(
    '82000000-0000-0000-0000-000000000001','81000000-0000-0000-0000-000000000001',
    repeat('a',64),repeat('9',64),'Duplicate receipt','Groceries',100,current_date,false,
    '[{"name":"Rice","quantity":1,"line_total":100,"is_personal":false,"is_tracked_for_restock":true,"display_order":0}]'::jsonb)
$$,'P0001','This bill was already imported','duplicate reservation remains atomic');
reset role;

select is((select count(*)::integer from public.purchases where household_id='82000000-0000-0000-0000-000000000001'),1,'failed duplicate creates no purchase');
select is((select count(*)::integer from public.invoice_imports where household_id='82000000-0000-0000-0000-000000000001'),3,'failed duplicate creates no fingerprint row');

set local role authenticated;
set local request.jwt.claim.sub='81000000-0000-0000-0000-000000000003';
select throws_ok(
  $$select * from public.find_invoice_duplicate('82000000-0000-0000-0000-000000000001',repeat('a',64),repeat('b',64))$$,
  'P0001','Active household membership is required','unrelated account cannot probe fingerprints');
reset role;

select * from finish();
rollback;
