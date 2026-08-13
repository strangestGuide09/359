begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

select has_function('public','release_orphaned_invoice_fingerprints',array['uuid','text','text'],'safe stale fingerprint release RPC exists');
select ok(not has_function_privilege('anon','public.release_orphaned_invoice_fingerprints(uuid,text,text)','execute'),'anonymous release is denied');
select ok(has_function_privilege('authenticated','public.release_orphaned_invoice_fingerprints(uuid,text,text)','execute'),'authenticated release is granted');

insert into auth.users(id) values
  ('b1000000-0000-0000-0000-000000000001'),
  ('b1000000-0000-0000-0000-000000000002');
insert into public.households(id,name,created_by) values
  ('b2000000-0000-0000-0000-000000000001','Stale fingerprint','b1000000-0000-0000-0000-000000000001'),
  ('b2000000-0000-0000-0000-000000000002','Unrelated','b1000000-0000-0000-0000-000000000002');
insert into public.household_members(household_id,user_id,display_name,role) values
  ('b2000000-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000001','Owner','owner'),
  ('b2000000-0000-0000-0000-000000000002','b1000000-0000-0000-0000-000000000002','Outsider','owner');
insert into public.purchases(id,household_id,label,category,amount,paid_by,purchased_on,is_personal) values
  ('b3000000-0000-0000-0000-000000000001','b2000000-0000-0000-0000-000000000001','Archived receipt','Groceries',10,'b1000000-0000-0000-0000-000000000001',current_date,false);
insert into public.invoice_imports(id,household_id,exact_pdf_hash,content_hash,imported_by,purchase_id) values
  ('b4000000-0000-0000-0000-000000000001','b2000000-0000-0000-0000-000000000001',repeat('a',64),repeat('b',64),'b1000000-0000-0000-0000-000000000001','b3000000-0000-0000-0000-000000000001');
insert into public.invoice_imports(id,household_id,exact_pdf_hash,content_hash,imported_by) values
  ('b4000000-0000-0000-0000-000000000002','b2000000-0000-0000-0000-000000000001',repeat('c',64),repeat('d',64),'b1000000-0000-0000-0000-000000000001'),
  ('b4000000-0000-0000-0000-000000000003','b2000000-0000-0000-0000-000000000001',repeat('e',64),repeat('f',64),'b1000000-0000-0000-0000-000000000001');

set local role authenticated;
set local request.jwt.claim.sub='b1000000-0000-0000-0000-000000000001';
select throws_ok(
  $$select public.release_orphaned_invoice_fingerprints('b2000000-0000-0000-0000-000000000001',repeat('a',64),repeat('b',64))$$,
  'P0001','A linked receipt fingerprint cannot be released','linked receipt remains protected');
select throws_ok(
  $$select public.release_orphaned_invoice_fingerprints('b2000000-0000-0000-0000-000000000001',repeat('c',64),repeat('d',64))$$,
  'P0001','Legacy fingerprint requires manual reconciliation while household receipts remain','unlinked legacy row fails closed while any receipt remains');
reset role;

-- Complete the real owner-only archive/purge path. The linked fingerprint
-- cascades; historical unlinked rows remain because they had no purchase link.
set local role authenticated;
set local request.jwt.claim.sub='b1000000-0000-0000-0000-000000000001';
select lives_ok(
  $$select public.delete_purchase_receipt('b3000000-0000-0000-0000-000000000001')$$,
  'receipt is archived before permanent purge');
select lives_ok(
  $$select public.purge_purchase_receipt('b3000000-0000-0000-0000-000000000001')$$,
  'owner purge completes');
reset role;
select is((select count(*)::integer from public.invoice_imports where exact_pdf_hash=repeat('a',64)),0,'linked fingerprint cascades with purged receipt');

set local role authenticated;
set local request.jwt.claim.sub='b1000000-0000-0000-0000-000000000001';
select is(
  public.release_orphaned_invoice_fingerprints('b2000000-0000-0000-0000-000000000001',repeat('c',64),repeat('f',64)),
  2,'all matching unlinked reservations are released when no receipt survives');
select is(
  public.release_orphaned_invoice_fingerprints('b2000000-0000-0000-0000-000000000001',repeat('c',64),repeat('f',64)),
  0,'release is idempotent');
reset role;

select is((select count(*)::integer from public.invoice_imports where household_id='b2000000-0000-0000-0000-000000000001'),0,'stale reservations no longer block reimport');
select is((select count(*)::integer from public.ledger_activity where action='orphaned_import_fingerprint_released'),1,'release records one content-free audit event');

set local role authenticated;
set local request.jwt.claim.sub='b1000000-0000-0000-0000-000000000002';
select throws_ok(
  $$select public.release_orphaned_invoice_fingerprints('b2000000-0000-0000-0000-000000000001',repeat('c',64),repeat('d',64))$$,
  'P0001','Active household membership is required','unrelated user cannot release household fingerprints');
select throws_ok(
  $$select public.release_orphaned_invoice_fingerprints('b2000000-0000-0000-0000-000000000002','bad',repeat('d',64))$$,
  'P0001','Invalid duplicate fingerprint','invalid fingerprints are rejected');
reset role;

select * from finish();
rollback;
