begin;
create extension if not exists pgtap with schema extensions;
select plan(80);

select has_column('public','purchase_items','item_kind','reviewed item kind is durable');
select has_column('public','purchase_items','include_in_total','reviewed total inclusion is durable');
select has_column('public','purchase_items','shared_line_total','signed shared allocation is durable');
select has_function('private','validate_reviewed_purchase_items',array['jsonb','boolean'],'one private reviewed-item validator exists');
select has_function('private','import_reviewed_purchase_core',array['uuid','uuid','text','text','boolean','text','text','numeric','date','boolean','jsonb'],'one private reviewed-import writer exists');
select has_function('public','import_reviewed_purchase',array['uuid','text','text','text','text','numeric','date','boolean','jsonb'],'original uploader-payer overload remains');
select has_function('public','import_reviewed_purchase',array['uuid','uuid','text','text','text','text','numeric','date','boolean','jsonb'],'selected-payer overload remains');
select has_function('public','import_reviewed_purchase',array['uuid','uuid','text','text','boolean','text','text','numeric','date','boolean','jsonb'],'reliability-aware overload remains');
select ok(not has_function_privilege('authenticated','private.validate_reviewed_purchase_items(jsonb,boolean)','execute'),'authenticated cannot invoke private validator');
select ok(not has_function_privilege('authenticated','private.import_reviewed_purchase_core(uuid,uuid,text,text,boolean,text,text,numeric,date,boolean,jsonb)','execute'),'authenticated cannot invoke private writer');
select ok(not has_function_privilege('anon','public.import_reviewed_purchase(uuid,text,text,text,text,numeric,date,boolean,jsonb)','execute'),'anon cannot invoke original overload');
select ok(not has_function_privilege('anon','public.import_reviewed_purchase(uuid,uuid,text,text,text,text,numeric,date,boolean,jsonb)','execute'),'anon cannot invoke selected-payer overload');
select ok(not has_function_privilege('anon','public.import_reviewed_purchase(uuid,uuid,text,text,boolean,text,text,numeric,date,boolean,jsonb)','execute'),'anon cannot invoke reliability-aware overload');
select ok(has_function_privilege('authenticated','public.import_reviewed_purchase(uuid,text,text,text,text,numeric,date,boolean,jsonb)','execute'),'authenticated retains original overload');
select ok(has_function_privilege('authenticated','public.import_reviewed_purchase(uuid,uuid,text,text,text,text,numeric,date,boolean,jsonb)','execute'),'authenticated retains selected-payer overload');
select ok(has_function_privilege('authenticated','public.import_reviewed_purchase(uuid,uuid,text,text,boolean,text,text,numeric,date,boolean,jsonb)','execute'),'authenticated retains reliability-aware overload');
select ok(not has_function_privilege('anon','public.update_reviewed_purchase(uuid,text,text,date,jsonb)','execute'),'anon cannot invoke atomic reviewed edit');
select ok(has_function_privilege('authenticated','public.update_reviewed_purchase(uuid,text,text,date,jsonb)','execute'),'authenticated retains atomic reviewed edit');
select ok((select proconfig @> array['search_path=""'] from pg_proc where oid='public.import_reviewed_purchase(uuid,text,text,text,text,numeric,date,boolean,jsonb)'::regprocedure),'original overload fixes its search path');
select ok((select proconfig @> array['search_path=""'] from pg_proc where oid='public.import_reviewed_purchase(uuid,uuid,text,text,text,text,numeric,date,boolean,jsonb)'::regprocedure),'selected-payer overload fixes its search path');
select ok((select proconfig @> array['search_path=""'] from pg_proc where oid='public.import_reviewed_purchase(uuid,uuid,text,text,boolean,text,text,numeric,date,boolean,jsonb)'::regprocedure),'reliability-aware overload fixes its search path');
select ok((select proconfig @> array['search_path=""'] from pg_proc where oid='public.update_reviewed_purchase(uuid,text,text,date,jsonb)'::regprocedure),'atomic reviewed edit fixes its search path');
select ok(pg_get_functiondef('private.import_reviewed_purchase_core(uuid,uuid,text,text,boolean,text,text,numeric,date,boolean,jsonb)'::regprocedure) like '%is_household_active_member%','private writer enforces active membership internally');
select ok(not (select prosecdef from pg_proc where oid='private.import_reviewed_purchase_core(uuid,uuid,text,text,boolean,text,text,numeric,date,boolean,jsonb)'::regprocedure),'private writer remains security invoker');

insert into auth.users(id) values
  ('e1000000-0000-0000-0000-000000000001'),
  ('e1000000-0000-0000-0000-000000000002');
insert into public.households(id,name,created_by) values
  ('e2000000-0000-0000-0000-000000000001','Reviewed import hardening','e1000000-0000-0000-0000-000000000001');
insert into public.household_members(household_id,user_id,display_name,role) values
  ('e2000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000001','Owner','owner'),
  ('e2000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000002','Partner','partner');

set local role authenticated;
set local request.jwt.claim.sub='e1000000-0000-0000-0000-000000000001';

select lives_ok($$
  select public.import_reviewed_purchase(
    'e2000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000001',
    repeat('1',64),repeat('2',64),true,'Product receipt','Groceries',125.50,current_date,false,
    '[{"name":"Rice","quantity":2,"unit":"kg","unit_price":50,"line_total":100,"is_personal":false,"is_tracked_for_restock":true,"display_order":0},{"name":"Soap","quantity":1,"unit_price":25.50,"line_total":25.50,"is_personal":false,"is_tracked_for_restock":true,"display_order":1}]'
  )
$$,'valid product-only receipt imports');
select is((select amount from public.purchases where label='Product receipt'),125.50::numeric,'product receipt amount is derived from all reviewed rows');
select is((select is_personal from public.purchases where label='Product receipt'),false,'product receipt shared status is derived from rows');
select is((select count(*)::integer from public.purchase_items i join public.purchases p on p.id=i.purchase_id where p.label='Product receipt'),2,'all reviewed product rows persist');

select lives_ok($$
  select public.import_reviewed_purchase(
    'e2000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000001',
    repeat('3',64),repeat('4',64),true,'Payable fee receipt','Groceries',882.99,current_date,false,
    '[{"name":"Products","quantity":1,"unit_price":871,"line_total":871,"is_personal":false,"is_tracked_for_restock":true,"display_order":0},{"name":"Handling and delivery","quantity":1,"unit_price":11.99,"line_total":11.99,"is_personal":false,"is_tracked_for_restock":false,"display_order":1,"item_kind":"fee","include_in_total":true},{"name":"Duplicate annexure","quantity":1,"line_total":871,"is_personal":false,"is_tracked_for_restock":false,"display_order":2,"item_kind":"product","include_in_total":false}]'
  )
$$,'explicit included payable fee imports');
select is((select amount from public.purchases where label='Payable fee receipt'),882.99::numeric,'products 871 plus fees 11.99 derive 882.99 without annexure double-counting');
select is((select count(*)::integer from public.purchase_items i join public.purchases p on p.id=i.purchase_id where p.label='Payable fee receipt'),3,'included fee and excluded informational annexure are both retained');
select ok(
  (select not i.is_tracked_for_restock from public.purchase_items i join public.purchases p on p.id=i.purchase_id where p.label='Payable fee receipt' and i.item_kind='fee')
  and (select not i.include_in_total from public.purchase_items i join public.purchases p on p.id=i.purchase_id where p.label='Payable fee receipt' and i.name='Duplicate annexure'),
  'fees never restock and duplicate annexure remains explicitly excluded'
);

select lives_ok($$
  select public.import_reviewed_purchase(
    'e2000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000001',
    repeat('4',64),repeat('5',64),true,'Fee example 433','Groceries',433,current_date,false,
    '[{"name":"Products","quantity":1,"line_total":421,"is_personal":false,"display_order":0},{"name":"Platform fee","quantity":1,"line_total":12,"is_personal":false,"is_tracked_for_restock":false,"display_order":1,"item_kind":"fee","include_in_total":true}]'
  )
$$,'products 421 plus included fee 12 import');
select is((select amount from public.purchases where label='Fee example 433'),433::numeric,'products 421 plus fee 12 derive 433');
select lives_ok($$
  select public.import_reviewed_purchase(
    'e2000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000001',
    repeat('8',64),repeat('9',64),true,'Fee example 229','Groceries',229,current_date,false,
    '[{"name":"Products","quantity":1,"line_total":216,"is_personal":false,"display_order":0},{"name":"Authoritative handling total","quantity":1,"line_total":13,"is_personal":false,"is_tracked_for_restock":false,"display_order":1,"item_kind":"fee","include_in_total":true},{"name":"Allocated charge 1","quantity":1,"line_total":2.59,"is_personal":false,"display_order":2,"item_kind":"informational","include_in_total":false},{"name":"Allocated charge 2","quantity":1,"line_total":2.60,"is_personal":false,"display_order":3,"item_kind":"informational","include_in_total":false},{"name":"Allocated charge 3","quantity":1,"line_total":2.60,"is_personal":false,"display_order":4,"item_kind":"informational","include_in_total":false},{"name":"Allocated charge 4","quantity":1,"line_total":2.60,"is_personal":false,"display_order":5,"item_kind":"informational","include_in_total":false},{"name":"Allocated charge 5","quantity":1,"line_total":2.60,"is_personal":false,"display_order":6,"item_kind":"informational","include_in_total":false}]'
  )
$$,'products 216 plus included fee 13 import');
select is((select amount from public.purchases where label='Fee example 229'),229::numeric,'products 216 plus fee 13 derive 229');

select lives_ok($$
  select public.import_reviewed_purchase(
    'e2000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000001',
    repeat('2',64),repeat('3',64),true,'Two seller totals','Groceries',895,current_date,false,
    '[{"name":"Seller invoice one","quantity":1,"line_total":292,"is_personal":false,"display_order":0},{"name":"Seller invoice two","quantity":1,"line_total":603,"is_personal":false,"display_order":1}]'
  )
$$,'distinct seller totals in one order are additive');
select is((select amount from public.purchases where label='Two seller totals'),895::numeric,'seller totals 292 plus 603 derive 895 without an invented fee');

select throws_ok($$
  select public.import_reviewed_purchase(
    'e2000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000001',
    repeat('5',64),repeat('7',64),true,'Implicit mixed discount','Groceries',120,current_date,false,
    '[{"name":"Shared products","quantity":1,"line_total":100,"is_personal":false,"display_order":0},{"name":"Personal products","quantity":1,"line_total":50,"is_personal":true,"display_order":1},{"name":"Order coupon","quantity":1,"line_total":-30,"is_personal":false,"display_order":2,"item_kind":"discount","include_in_total":true}]'
  )
$$,'P0001','Mixed personal and shared receipts require explicit adjustment allocation','mixed receipt discount cannot silently fall wholly on shared spend');
select is((select count(*)::integer from public.invoice_imports where exact_pdf_hash=repeat('5',64)),0,'ambiguous mixed discount leaves no fingerprint reservation');
select lives_ok($$
  select public.import_reviewed_purchase(
    'e2000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000001',
    repeat('c',64),repeat('d',64),true,'Allocated mixed discount','Groceries',120,current_date,false,
    '[{"name":"Shared products","quantity":1,"line_total":100,"is_personal":false,"display_order":0},{"name":"Personal products","quantity":1,"line_total":50,"is_personal":true,"display_order":1},{"name":"Order coupon","quantity":1,"line_total":-30,"shared_line_total":-20,"is_personal":false,"display_order":2,"item_kind":"discount","include_in_total":true}]'
  )
$$,'mixed receipt accepts an explicit bounded discount allocation');
select is((select amount from public.purchases where label='Allocated mixed discount'),120::numeric,'signed components derive the final customer obligation');
select is((select sum(i.shared_line_total) from public.purchase_items i join public.purchases p on p.id=i.purchase_id where p.label='Allocated mixed discount'),80::numeric,'explicit mixed discount derives shared net without trusting a header');
select throws_ok($$
  select public.import_reviewed_purchase(
    'e2000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000001',
    repeat('0',64),repeat('e',64),true,'Conflicting signed allocation','Groceries',90,current_date,false,
    '[{"name":"Shared products","quantity":1,"line_total":100,"is_personal":false,"display_order":0},{"name":"Order coupon","quantity":1,"line_total":-10,"shared_line_total":-5,"is_personal":true,"display_order":1,"item_kind":"discount","include_in_total":true}]'
  )
$$,'P0001','Signed component personal status conflicts with its shared allocation','signed component cannot forge conflicting personal and shared semantics');
select throws_ok($$
  select public.import_reviewed_purchase(
    'e2000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000001',
    repeat('d',64),repeat('e',64),true,'Tender row','Groceries',100,current_date,false,
    '[{"name":"Products","quantity":1,"line_total":120,"is_personal":false,"display_order":0},{"name":"Wallet paid","quantity":1,"line_total":-20,"is_personal":false,"display_order":1,"item_kind":"tender","include_in_total":true}]'
  )
$$,'P0001','Reviewed item kind is invalid','payment tender cannot reduce the ledger expense');
select throws_ok($$
  select public.import_reviewed_purchase(
    'e2000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000001',
    repeat('e',64),repeat('f',64),true,'Explanatory GST','Groceries',105,current_date,false,
    '[{"name":"Tax-inclusive products","quantity":1,"line_total":100,"is_personal":false,"display_order":0},{"name":"GST breakdown","quantity":1,"line_total":5,"is_personal":false,"display_order":1,"item_kind":"informational","include_in_total":true}]'
  )
$$,'P0001','Informational rows cannot be included in the receipt total','explanatory tax breakdown cannot be double-counted');

select lives_ok($$
  select public.update_reviewed_purchase(
    (select id from public.purchases where label='Fee example 433'),
    'Fee example 433','Groceries',current_date,
    '[{"name":"Products","quantity":1,"line_total":421,"is_personal":false,"display_order":0,"item_kind":"product","include_in_total":true},{"name":"Platform fee","quantity":1,"line_total":12,"is_personal":false,"is_tracked_for_restock":false,"display_order":1,"item_kind":"fee","include_in_total":true},{"name":"Duplicate annexure","quantity":1,"line_total":421,"is_personal":false,"display_order":2,"item_kind":"product","include_in_total":false}]'
  )
$$,'atomic edit uses the same included product and fee rules');
select is((select amount from public.purchases where label='Fee example 433'),433::numeric,'atomic edit excludes duplicate annexure from derived amount');
select throws_ok($$
  select public.update_reviewed_purchase(
    (select id from public.purchases where label='Fee example 433'),
    'Fee example 433','Groceries',current_date,
    '[{"name":"Products","quantity":0,"line_total":421,"is_personal":false,"display_order":0}]'
  )
$$,'P0001','Reviewed item quantity must be positive','atomic edit applies the same strict item validation');
select is((select amount from public.purchases where label='Fee example 433'),433::numeric,'failed atomic edit rolls the receipt back unchanged');

reset role;
set local role authenticated;
set local request.jwt.claim.sub='e1000000-0000-0000-0000-000000000002';
select lives_ok($$
  select public.record_receipt_backed_settlement(
    'e2000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000001',
    6,current_date,
    jsonb_build_array(jsonb_build_object(
      'purchase_id',(select id from public.purchases where label='Fee example 433'),
      'purchase_item_id',(select i.id from public.purchase_items i join public.purchases p on p.id=i.purchase_id where p.label='Fee example 433' and i.item_kind='fee'),
      'amount',6
    ))
  )
$$,'included shared fee has receipt-backed settlement capacity');
select throws_ok($$
  select public.record_receipt_backed_settlement(
    'e2000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000001',
    0.01,current_date,
    jsonb_build_array(jsonb_build_object(
      'purchase_id',(select id from public.purchases where label='Fee example 433'),
      'purchase_item_id',(select i.id from public.purchase_items i join public.purchases p on p.id=i.purchase_id where p.label='Fee example 433' and i.item_kind='fee'),
      'amount',0.01
    ))
  )
$$,'P0001','Item allocation exceeds the household share','shared fee allocation cannot exceed half its included line total');
reset role;
set local role authenticated;
set local request.jwt.claim.sub='e1000000-0000-0000-0000-000000000001';

select throws_ok($$
  select public.import_reviewed_purchase(
    'e2000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000001',
    repeat('5',64),repeat('6',64),true,'Mismatch','Groceries',99,current_date,false,
    '[{"name":"Milk","quantity":1,"line_total":100,"is_personal":false,"display_order":0}]'
  )
$$,'P0001','Receipt amount must match reviewed included item totals','header and item total mismatch fails closed');
select is((select count(*)::integer from public.invoice_imports where exact_pdf_hash=repeat('5',64)),0,'mismatch rejection leaves no fingerprint reservation');

select throws_ok($$
  select public.import_reviewed_purchase(
    'e2000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000001',
    repeat('7',64),repeat('8',64),true,'Missing quantity','Groceries',20,current_date,false,
    '[{"name":"Tea","line_total":20,"is_personal":false,"display_order":0}]'
  )
$$,'P0001','Reviewed item quantity must be positive','missing required item quantity fails closed');
select is((select count(*)::integer from public.invoice_imports where exact_pdf_hash=repeat('7',64)),0,'malformed item rejection leaves no fingerprint reservation');
select throws_ok($$
  select public.import_reviewed_purchase(
    'e2000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000001',
    repeat('9',64),repeat('a',64),true,'Bad kind','Groceries',20,current_date,false,
    '[{"name":"Tea","quantity":1,"line_total":20,"is_personal":false,"display_order":0,"item_kind":"summary","include_in_total":true}]'
  )
$$,'P0001','Reviewed item kind is invalid','unknown item kind fails closed');
select throws_ok($$
  select public.import_reviewed_purchase(
    'e2000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000001',
    repeat('b',64),repeat('c',64),true,'Restock fee','Groceries',20,current_date,false,
    '[{"name":"Tea","quantity":1,"line_total":10,"is_personal":false,"display_order":0},{"name":"Delivery fee","quantity":1,"line_total":10,"is_personal":false,"is_tracked_for_restock":true,"display_order":1,"item_kind":"fee","include_in_total":true}]'
  )
$$,'P0001','Only included merchandise products can be tracked for restock','restockable fee fails closed');
select throws_ok($$
  select public.import_reviewed_purchase(
    'e2000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000001',
    repeat('d',64),repeat('e',64),true,'Bad allocation','Groceries',20,current_date,true,
    '[{"name":"Tea","quantity":1,"line_total":20,"is_personal":false,"display_order":0}]'
  )
$$,'P0001','Purchase allocation must match its reviewed items','header personal status cannot contradict rows');

select lives_ok($$
  select public.import_reviewed_purchase(
    'e2000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000001',
    repeat('f',64),repeat('0',64),true,'Retry receipt','Groceries',30,current_date,false,
    '[{"name":"Eggs","quantity":1,"line_total":30,"is_personal":false,"display_order":0}]'
  )
$$,'first idempotency-keyed import succeeds');
select throws_ok($$
  select public.import_reviewed_purchase(
    'e2000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000001',
    repeat('f',64),repeat('0',64),true,'Retry receipt','Groceries',30,current_date,false,
    '[{"name":"Eggs","quantity":1,"line_total":30,"is_personal":false,"display_order":0}]'
  )
$$,'P0001','This bill was already imported','retry is atomically rejected as an existing import');
select is((select count(*)::integer from public.purchases where label='Retry receipt'),1,'retry creates no second purchase');
select is((select count(*)::integer from public.invoice_imports where exact_pdf_hash=repeat('f',64)),1,'retry creates no second fingerprint');

select lives_ok($$
  select public.import_reviewed_purchase(
    'e2000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000001',
    repeat('a',64),repeat('1',64),'Legacy selected payer','Groceries',41,current_date,false,
    '[{"name":"Dal","quantity":1,"line_total":41,"is_personal":false,"display_order":0}]'
  )
$$,'legacy selected-payer overload delegates to hardened core');
select is((select amount from public.purchases where label='Legacy selected payer'),41::numeric,'legacy selected-payer amount is derived');
select throws_ok($$
  select public.import_reviewed_purchase(
    'e2000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000001',
    repeat('a',64),repeat('a',64),'Legacy selected mismatch','Groceries',40,current_date,false,
    '[{"name":"Dal","quantity":1,"line_total":41,"is_personal":false,"display_order":0}]'
  )
$$,'P0001','Receipt amount must match reviewed included item totals','legacy selected-payer overload rejects mismatch');
select is((select count(*)::integer from public.invoice_imports where content_hash=repeat('a',64)),0,'legacy selected-payer rejection leaves no fingerprint');

select lives_ok($$
  select public.import_reviewed_purchase(
    'e2000000-0000-0000-0000-000000000001',repeat('b',64),repeat('6',64),
    'Legacy uploader payer','Groceries',52,current_date,false,
    '[{"name":"Oil","quantity":1,"line_total":52,"is_personal":false,"display_order":0}]'
  )
$$,'original legacy overload delegates to hardened core');
select is((select amount from public.purchases where label='Legacy uploader payer'),52::numeric,'original legacy amount is derived');
select throws_ok($$
  select public.import_reviewed_purchase(
    'e2000000-0000-0000-0000-000000000001',repeat('c',64),repeat('7',64),
    'Legacy uploader mismatch','Groceries',51,current_date,false,
    '[{"name":"Oil","quantity":1,"line_total":52,"is_personal":false,"display_order":0}]'
  )
$$,'P0001','Receipt amount must match reviewed included item totals','original legacy overload rejects mismatch');
select is((select count(*)::integer from public.invoice_imports where content_hash=repeat('7',64)),0,'original legacy rejection leaves no fingerprint');

select lives_ok($$select public.delete_purchase_receipt((select purchase_id from public.invoice_imports where exact_pdf_hash=repeat('f',64)))$$,'ordinary receipt archive remains available');
select is((select duplicate_status from public.find_invoice_duplicate('e2000000-0000-0000-0000-000000000001',repeat('f',64),repeat('0',64))),'linked_archived_restorable','archived reviewed import remains duplicate-protected and restorable');
select lives_ok($$select public.purge_purchase_receipt((select purchase_id from public.invoice_imports where exact_pdf_hash=repeat('f',64)))$$,'owner may permanently purge the archived receipt');
select is((select duplicate_status from public.find_invoice_duplicate('e2000000-0000-0000-0000-000000000001',repeat('f',64),repeat('0',64))),'none','purge removes the reviewed import duplicate match');
select lives_ok($$
  select public.import_reviewed_purchase(
    'e2000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000001',
    repeat('f',64),repeat('0',64),true,'Reimport after purge','Groceries',30,current_date,false,
    '[{"name":"Eggs","quantity":1,"line_total":30,"is_personal":false,"display_order":0}]'
  )
$$,'same reviewed receipt may import after permanent purge');
select is((select count(*)::integer from public.invoice_imports where exact_pdf_hash=repeat('f',64)),1,'reimport after purge has exactly one current fingerprint');

select lives_ok($$
  select public.import_reviewed_purchase(
    'e2000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000001',
    repeat('6',64),repeat('8',64),false,'Sparse derivative one','Groceries',10,current_date,false,
    '[{"name":"Salt","quantity":1,"line_total":10,"is_personal":false,"display_order":0}]'
  )
$$,'first unreliable-content receipt imports');
select lives_ok($$
  select public.import_reviewed_purchase(
    'e2000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000001',
    repeat('7',64),repeat('8',64),false,'Sparse derivative two','Groceries',11,current_date,false,
    '[{"name":"Sugar","quantity":1,"line_total":11,"is_personal":false,"display_order":0}]'
  )
$$,'different exact PDF may share an unreliable content hash');
select is((select count(*)::integer from public.invoice_imports where content_hash=repeat('8',64) and not content_hash_reliable),2,'unreliable content collision retains two exact reservations');

reset role;
select * from finish();
rollback;
