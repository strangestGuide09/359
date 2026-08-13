begin;
create extension if not exists pgtap with schema extensions;
select plan(32);

select has_column('public','invoice_imports','content_hash_reliable','content fingerprint reliability is explicit');
select has_function('public','import_reviewed_purchase',array['uuid','uuid','text','text','boolean','text','text','numeric','date','boolean','jsonb'],'reviewed import accepts content reliability');
select ok(not has_function_privilege('anon','public.import_reviewed_purchase(uuid,uuid,text,text,boolean,text,text,numeric,date,boolean,jsonb)','execute'),'anonymous reliability-aware import denied');
select ok(has_function_privilege('authenticated','public.import_reviewed_purchase(uuid,uuid,text,text,boolean,text,text,numeric,date,boolean,jsonb)','execute'),'authenticated reliability-aware import granted');
select has_trigger('public','purchases','cleanup_unlinked_imports_after_last_purchase','last permanent receipt purge cleans legacy reservations');

insert into auth.users(id) values
  ('d1000000-0000-0000-0000-000000000001'),
  ('d1000000-0000-0000-0000-000000000002');
insert into public.households(id,name,created_by) values
  ('d2000000-0000-0000-0000-000000000001','Fingerprint lifecycle','d1000000-0000-0000-0000-000000000001');
insert into public.household_members(household_id,user_id,display_name,role) values
  ('d2000000-0000-0000-0000-000000000001','d1000000-0000-0000-0000-000000000001','Owner','owner'),
  ('d2000000-0000-0000-0000-000000000001','d1000000-0000-0000-0000-000000000002','Partner','partner');

set local role authenticated;
set local request.jwt.claim.sub='d1000000-0000-0000-0000-000000000001';
select lives_ok($$
  select public.import_reviewed_purchase(
    'd2000000-0000-0000-0000-000000000001','d1000000-0000-0000-0000-000000000001',
    repeat('a',64),repeat('b',64),true,'Reliable receipt','Groceries',20,current_date,false,
    '[{"name":"Rice","quantity":1,"line_total":20,"is_personal":false,"is_tracked_for_restock":true,"display_order":0}]')
$$,'reliable reviewed receipt imports');
select is((select duplicate_status from public.find_invoice_duplicate('d2000000-0000-0000-0000-000000000001',repeat('9',64),repeat('b',64))),'linked_active','reliable content-only duplicate remains protected');
select throws_ok($$
  select public.import_reviewed_purchase(
    'd2000000-0000-0000-0000-000000000001','d1000000-0000-0000-0000-000000000001',
    repeat('9',64),repeat('b',64),true,'Semantic duplicate','Groceries',20,current_date,false,
    '[{"name":"Rice","quantity":1,"line_total":20,"is_personal":false,"display_order":0}]')
$$,'P0001','This bill was already imported','reliable semantic duplicate remains atomically blocked');
select lives_ok($$select public.delete_purchase_receipt((select purchase_id from public.invoice_imports where exact_pdf_hash=repeat('a',64)))$$,'linked receipt archives');
select is((select duplicate_status from public.find_invoice_duplicate('d2000000-0000-0000-0000-000000000001',repeat('a',64),repeat('b',64))),'linked_archived_restorable','archived exact duplicate remains restorable');
select is((select duplicate_status from public.find_invoice_duplicate('d2000000-0000-0000-0000-000000000001',repeat('9',64),repeat('b',64))),'linked_archived_restorable','archived reliable content duplicate remains restorable');
select lives_ok($$select public.purge_purchase_receipt((select purchase_id from public.invoice_imports where exact_pdf_hash=repeat('a',64)))$$,'owner permanently purges linked receipt');
select is((select duplicate_status from public.find_invoice_duplicate('d2000000-0000-0000-0000-000000000001',repeat('a',64),repeat('b',64))),'none','permanent purge leaves no exact duplicate match');
select is((select duplicate_status from public.find_invoice_duplicate('d2000000-0000-0000-0000-000000000001',repeat('9',64),repeat('b',64))),'none','permanent purge leaves no content duplicate match');
select is((select count(*)::integer from public.invoice_imports),0,'permanent purge removes linked fingerprint row');

select lives_ok($$
  select public.import_reviewed_purchase(
    'd2000000-0000-0000-0000-000000000001','d1000000-0000-0000-0000-000000000001',
    repeat('c',64),repeat('0',64),false,'Sparse one','Groceries',10,current_date,false,
    '[{"name":"Milk","quantity":1,"line_total":10,"is_personal":false,"is_tracked_for_restock":true,"display_order":0}]')
$$,'first sparse-content PDF imports');
select lives_ok($$
  select public.import_reviewed_purchase(
    'd2000000-0000-0000-0000-000000000001','d1000000-0000-0000-0000-000000000001',
    repeat('d',64),repeat('0',64),false,'Sparse two','Groceries',12,current_date,false,
    '[{"name":"Bread","quantity":1,"line_total":12,"is_personal":false,"is_tracked_for_restock":true,"display_order":0}]')
$$,'different PDF with same sparse content hash imports');
select is((select duplicate_status from public.find_invoice_duplicate('d2000000-0000-0000-0000-000000000001',repeat('e',64),repeat('0',64))),'none','unreliable content-only collision is not a duplicate');
select is((select duplicate_status from public.find_invoice_duplicate('d2000000-0000-0000-0000-000000000001',repeat('c',64),repeat('f',64))),'linked_active','exact PDF remains protected despite unreliable content');
select throws_ok($$
  select public.import_reviewed_purchase(
    'd2000000-0000-0000-0000-000000000001','d1000000-0000-0000-0000-000000000001',
    repeat('c',64),repeat('1',64),false,'Exact duplicate','Groceries',10,current_date,false,
    '[{"name":"Milk","quantity":1,"line_total":10,"is_personal":false,"display_order":0}]')
$$,'P0001','This bill was already imported','exact duplicate remains atomically blocked');
reset role;

-- Simulate a pre-link reservation: exact evidence remains protected, while its
-- unverified content hash cannot falsely match another PDF.
insert into public.invoice_imports(household_id,exact_pdf_hash,content_hash,content_hash_reliable,imported_by)
values
  ('d2000000-0000-0000-0000-000000000001',repeat('7',64),repeat('8',64),false,'d1000000-0000-0000-0000-000000000001'),
  ('d2000000-0000-0000-0000-000000000001',repeat('4',64),repeat('3',64),true,'d1000000-0000-0000-0000-000000000001');
set local role authenticated;
set local request.jwt.claim.sub='d1000000-0000-0000-0000-000000000001';
select is((select duplicate_status from public.find_invoice_duplicate('d2000000-0000-0000-0000-000000000001',repeat('7',64),repeat('6',64))),'legacy_unlinked','legacy exact hash remains explicit');
select is((select match_basis from public.find_invoice_duplicate('d2000000-0000-0000-0000-000000000001',repeat('7',64),repeat('6',64))),'exact','legacy match basis identifies exact PDF');
select is((select duplicate_status from public.find_invoice_duplicate('d2000000-0000-0000-0000-000000000001',repeat('5',64),repeat('8',64))),'none','different PDF does not match sparse legacy content');
select is(public.release_orphaned_invoice_fingerprints('d2000000-0000-0000-0000-000000000001',repeat('5',64),repeat('8',64)),0,'content-only collision cannot remove a different exact reservation');
select is(public.release_orphaned_invoice_fingerprints('d2000000-0000-0000-0000-000000000001',repeat('4',64),repeat('2',64)),1,'owner can release one exact orphan reservation without touching active receipts');
select lives_ok($$select public.delete_purchase_receipt((select purchase_id from public.invoice_imports where exact_pdf_hash=repeat('c',64)))$$,'first sparse receipt archives');
select lives_ok($$select public.purge_purchase_receipt((select purchase_id from public.invoice_imports where exact_pdf_hash=repeat('c',64)))$$,'first sparse receipt permanently purges');
select is((select duplicate_status from public.find_invoice_duplicate('d2000000-0000-0000-0000-000000000001',repeat('7',64),repeat('6',64))),'legacy_unlinked','legacy exact reservation remains while another recoverable receipt exists');
select lives_ok($$select public.delete_purchase_receipt((select purchase_id from public.invoice_imports where exact_pdf_hash=repeat('d',64)))$$,'last sparse receipt archives');
select lives_ok($$select public.purge_purchase_receipt((select purchase_id from public.invoice_imports where exact_pdf_hash=repeat('d',64)))$$,'last sparse receipt permanently purges');
select is((select duplicate_status from public.find_invoice_duplicate('d2000000-0000-0000-0000-000000000001',repeat('7',64),repeat('8',64))),'none','last permanent purge removes legacy exact reservation');
select is((select count(*)::integer from public.invoice_imports),0,'no duplicate fingerprint trace remains after all receipts are permanently deleted');
reset role;

select * from finish();
rollback;
