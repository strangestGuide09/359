begin;
create extension if not exists pgtap with schema extensions;
select plan(21);

select has_function('public','purge_purchase_receipt',array['uuid'],'receipt purge RPC exists');
select ok(not has_function_privilege('anon','public.purge_purchase_receipt(uuid)','execute'),'anonymous purge is denied');
select ok(has_function_privilege('authenticated','public.purge_purchase_receipt(uuid)','execute'),'authenticated role may call the guarded RPC');
select ok(not has_table_privilege('authenticated','public.purchases','delete'),'authenticated clients retain no broad purchase delete privilege');

insert into auth.users(id) values
  ('91000000-0000-0000-0000-000000000001'),
  ('91000000-0000-0000-0000-000000000002'),
  ('91000000-0000-0000-0000-000000000003');
insert into public.households(id,name,created_by) values
  ('92000000-0000-0000-0000-000000000001','Purge household','91000000-0000-0000-0000-000000000001'),
  ('92000000-0000-0000-0000-000000000002','Other household','91000000-0000-0000-0000-000000000003');
insert into public.household_members(household_id,user_id,display_name,role) values
  ('92000000-0000-0000-0000-000000000001','91000000-0000-0000-0000-000000000001','Owner','owner'),
  ('92000000-0000-0000-0000-000000000001','91000000-0000-0000-0000-000000000002','Partner','partner'),
  ('92000000-0000-0000-0000-000000000002','91000000-0000-0000-0000-000000000003','Other owner','owner');
insert into public.purchases(id,household_id,label,category,amount,paid_by,purchased_on,is_personal) values
  ('93000000-0000-0000-0000-000000000001','92000000-0000-0000-0000-000000000001','Keep receipt','Groceries',40,'91000000-0000-0000-0000-000000000001',current_date,false),
  ('93000000-0000-0000-0000-000000000002','92000000-0000-0000-0000-000000000001','Purge receipt','Groceries',60,'91000000-0000-0000-0000-000000000002',current_date,false);
insert into public.purchase_items(id,purchase_id,display_order,name,quantity,line_total) values
  ('94000000-0000-0000-0000-000000000001','93000000-0000-0000-0000-000000000001',0,'Keep item',1,40),
  ('94000000-0000-0000-0000-000000000002','93000000-0000-0000-0000-000000000002',0,'Purge item',1,60);
insert into public.invoice_imports(id,household_id,exact_pdf_hash,content_hash,imported_by,purchase_id) values
  ('95000000-0000-0000-0000-000000000001','92000000-0000-0000-0000-000000000001',repeat('a',64),repeat('b',64),'91000000-0000-0000-0000-000000000001','93000000-0000-0000-0000-000000000001'),
  ('95000000-0000-0000-0000-000000000002','92000000-0000-0000-0000-000000000001',repeat('c',64),repeat('d',64),'91000000-0000-0000-0000-000000000001','93000000-0000-0000-0000-000000000002');

set local role authenticated;
set local request.jwt.claim.sub='91000000-0000-0000-0000-000000000001';
select throws_ok(
  $$select public.purge_purchase_receipt('93000000-0000-0000-0000-000000000001')$$,
  'P0001','Receipt must be deleted before permanent removal','active receipt cannot be purged');
select lives_ok(
  $$select public.delete_purchase_receipt('93000000-0000-0000-0000-000000000002')$$,
  'existing soft-delete archives the purge target');
select lives_ok(
  $$select public.restore_purchase_receipt('93000000-0000-0000-0000-000000000002')$$,
  'soft-deleted purge target remains restorable before purge');
select lives_ok(
  $$select public.delete_purchase_receipt('93000000-0000-0000-0000-000000000002')$$,
  'restored target can be archived again before irreversible purge');
reset role;

set local role authenticated;
set local request.jwt.claim.sub='91000000-0000-0000-0000-000000000002';
select throws_ok(
  $$select public.purge_purchase_receipt('93000000-0000-0000-0000-000000000002')$$,
  'P0001','Only the active household owner can permanently delete this receipt','payer partner cannot purge');
reset role;

set local role authenticated;
set local request.jwt.claim.sub='91000000-0000-0000-0000-000000000003';
select throws_ok(
  $$select public.purge_purchase_receipt('93000000-0000-0000-0000-000000000002')$$,
  'P0001','Only the active household owner can permanently delete this receipt','unrelated owner cannot purge');
reset role;

set local role authenticated;
set local request.jwt.claim.sub='91000000-0000-0000-0000-000000000001';
select lives_ok(
  $$select public.purge_purchase_receipt('93000000-0000-0000-0000-000000000002')$$,
  'active household owner purges an archived receipt');
reset role;

select is((select count(*)::integer from public.purchases where id='93000000-0000-0000-0000-000000000002'),0,'purchase is permanently removed');
select is((select count(*)::integer from public.purchase_items where purchase_id='93000000-0000-0000-0000-000000000002'),0,'reviewed items cascade away');
select is((select count(*)::integer from public.invoice_imports where purchase_id='93000000-0000-0000-0000-000000000002'),0,'linked duplicate fingerprints cascade away');
select is((select count(*)::integer from public.ledger_activity where subject_id='93000000-0000-0000-0000-000000000002'),0,'receipt-specific audit identifiers are removed');
select is((select count(*)::integer from public.ledger_activity where household_id='92000000-0000-0000-0000-000000000001' and action='receipt_purged' and subject_id is null),1,'one content-free purge audit event remains');
select is((select count(*)::integer from public.purchases where id='93000000-0000-0000-0000-000000000001'),1,'unrelated active receipt remains');

set local role authenticated;
set local request.jwt.claim.sub='91000000-0000-0000-0000-000000000001';
select throws_ok(
  $$select public.restore_purchase_receipt('93000000-0000-0000-0000-000000000002')$$,
  'P0001','Receipt not found','purged receipt cannot be restored');
select lives_ok(
  $$select public.delete_purchase_receipt('93000000-0000-0000-0000-000000000001')$$,
  'existing soft-delete still works for another receipt');
select lives_ok(
  $$select public.restore_purchase_receipt('93000000-0000-0000-0000-000000000001')$$,
  'existing restore still works for another receipt');
reset role;

select is((select archived_at is null from public.purchases where id='93000000-0000-0000-0000-000000000001'),true,'restored receipt returns to active ledger');

select * from finish();
rollback;
