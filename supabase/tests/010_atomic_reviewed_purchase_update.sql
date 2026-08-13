begin;
create extension if not exists pgtap with schema extensions;
select plan(37);

select has_function('public','update_reviewed_purchase',array['uuid','text','text','date','jsonb'],'atomic reviewed receipt update RPC exists');
select ok(not has_function_privilege('anon','public.update_reviewed_purchase(uuid,text,text,date,jsonb)','execute'),'anonymous update is denied');
select ok(has_function_privilege('authenticated','public.update_reviewed_purchase(uuid,text,text,date,jsonb)','execute'),'authenticated update is granted');
select ok(not has_table_privilege('authenticated','public.purchase_items','update'),'item rows cannot be updated separately');
select ok(not has_table_privilege('authenticated','public.purchase_items','delete'),'item rows cannot be deleted separately');
select ok(not has_table_privilege('authenticated','public.purchase_items','insert'),'item rows cannot be inserted separately');
select has_trigger('public','purchases','guard_reviewed_purchase_header_update','itemized receipt header has atomic update guard');
select has_trigger('public','purchase_items','guard_purchase_item_link','reviewed item linkage is immutable');

insert into auth.users(id) values
  ('c1000000-0000-0000-0000-000000000001'),
  ('c1000000-0000-0000-0000-000000000002'),
  ('c1000000-0000-0000-0000-000000000003');
insert into public.households(id,name,created_by) values
  ('c2000000-0000-0000-0000-000000000001','Receipt editors','c1000000-0000-0000-0000-000000000001'),
  ('c2000000-0000-0000-0000-000000000002','Other household','c1000000-0000-0000-0000-000000000003');
insert into public.household_members(household_id,user_id,display_name,role) values
  ('c2000000-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000001','Owner','owner'),
  ('c2000000-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000002','Partner','partner'),
  ('c2000000-0000-0000-0000-000000000002','c1000000-0000-0000-0000-000000000003','Outsider','owner');
insert into public.purchases(id,household_id,label,category,amount,paid_by,purchased_on,is_personal) values
  ('c3000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001','Original receipt','Groceries',100,'c1000000-0000-0000-0000-000000000001',current_date-2,false),
  ('c3000000-0000-0000-0000-000000000002','c2000000-0000-0000-0000-000000000001','Archived receipt','Groceries',10,'c1000000-0000-0000-0000-000000000001',current_date-2,false),
  ('c3000000-0000-0000-0000-000000000003','c2000000-0000-0000-0000-000000000001','Partner receipt','Groceries',30,'c1000000-0000-0000-0000-000000000002',current_date-2,false);
insert into public.purchase_items(id,purchase_id,display_order,name,quantity,line_total,is_personal,is_tracked_for_restock) values
  ('c4000000-0000-0000-0000-000000000001','c3000000-0000-0000-0000-000000000001',0,'Rice',1,80,false,true),
  ('c4000000-0000-0000-0000-000000000002','c3000000-0000-0000-0000-000000000001',1,'Chocolate',1,20,true,false),
  ('c4000000-0000-0000-0000-000000000003','c3000000-0000-0000-0000-000000000002',0,'Soap',1,10,false,true),
  ('c4000000-0000-0000-0000-000000000004','c3000000-0000-0000-0000-000000000003',0,'Flour',1,30,false,true);

set local role authenticated;
set local request.jwt.claim.sub='c1000000-0000-0000-0000-000000000002';
select throws_ok($$
  select public.update_reviewed_purchase('c3000000-0000-0000-0000-000000000001','No access','Groceries',current_date,
    '[{"id":"c4000000-0000-0000-0000-000000000001","name":"Rice","quantity":1,"line_total":80,"is_personal":false,"is_tracked_for_restock":true,"display_order":0}]')
$$,'P0001','Only the receipt payer or household owner can edit this receipt','non-owner partner cannot edit another payer receipt');
reset role;

set local role authenticated;
set local request.jwt.claim.sub='c1000000-0000-0000-0000-000000000003';
select throws_ok($$
  select public.update_reviewed_purchase('c3000000-0000-0000-0000-000000000001','No access','Groceries',current_date,'[]')
$$,'P0001','Active household membership is required','unrelated user cannot edit receipt');
reset role;

select set_config('app.grocery_receipt_lifecycle','allowed',true);
update public.purchases set archived_at=now(),archived_by='c1000000-0000-0000-0000-000000000001'
where id='c3000000-0000-0000-0000-000000000002';
select set_config('app.grocery_receipt_lifecycle','',true);
set local role authenticated;
set local request.jwt.claim.sub='c1000000-0000-0000-0000-000000000001';
select throws_ok($$
  select public.update_reviewed_purchase('c3000000-0000-0000-0000-000000000002','Archived','Groceries',current_date,
    '[{"id":"c4000000-0000-0000-0000-000000000003","name":"Soap","quantity":1,"line_total":10,"display_order":0}]')
$$,'P0001','Restore the receipt before editing it','archived receipt cannot be edited');
select throws_ok($$
  select public.update_reviewed_purchase('c3000000-0000-0000-0000-000000000001','Original','Groceries',current_date,
    '[{"name":"Rice","quantity":1,"line_total":10,"display_order":0,"raw_text":"forbidden"}]')
$$,'P0001','Reviewed item contains unsupported fields','unapproved receipt text field is rejected');
select throws_ok($$
  select public.update_reviewed_purchase('c3000000-0000-0000-0000-000000000001','Original','Groceries',current_date,
    '[{"name":" ","quantity":1,"line_total":10,"display_order":0}]')
$$,'P0001','Reviewed item name must be 1 to 160 characters without control characters','blank item name is rejected');
select throws_ok($$
  select public.update_reviewed_purchase('c3000000-0000-0000-0000-000000000001','Original','Groceries',current_date,
    '[{"name":"Rice","quantity":0,"line_total":10,"display_order":0}]')
$$,'P0001','Reviewed item quantity must be positive','invalid quantity is rejected');
select throws_ok($$
  select public.update_reviewed_purchase('c3000000-0000-0000-0000-000000000001','Original','Groceries',current_date,
    '[{"name":"Rice","quantity":1,"line_total":-1,"display_order":0}]')
$$,'P0001','Reviewed item line total is invalid','negative line total is rejected');
select throws_ok($$
  select public.update_reviewed_purchase('c3000000-0000-0000-0000-000000000001','Original','Groceries',current_date,
    '[{"name":"Rice","quantity":1,"line_total":10,"display_order":0},{"name":"Milk","quantity":1,"line_total":10,"display_order":0}]')
$$,'P0001','Reviewed item display order must be unique','duplicate display order is rejected');
select throws_ok($$
  select public.update_reviewed_purchase('c3000000-0000-0000-0000-000000000001','Original','Groceries',current_date,
    '[{"name":"Chocolate","quantity":1,"line_total":20,"is_personal":true,"is_tracked_for_restock":true,"display_order":0}]')
$$,'P0001','Personal items cannot be tracked for household restock','personal restock combination is rejected');

select lives_ok($$
  select public.update_reviewed_purchase('c3000000-0000-0000-0000-000000000001','Updated receipt','Food',current_date-1,
    '[{"id":"c4000000-0000-0000-0000-000000000002","name":"Chocolate bar","quantity":2,"unit":"bar","unit_price":10,"line_total":20,"is_personal":false,"is_tracked_for_restock":true,"estimated_use_by":null,"display_order":0},{"name":"Milk","quantity":2,"unit":"L","unit_price":30,"line_total":60,"is_personal":true,"is_tracked_for_restock":false,"estimated_use_by":"2026-08-20","display_order":1}]')
$$,'owner atomically replaces and edits complete reviewed item list');
select lives_ok($$
  select public.update_reviewed_purchase('c3000000-0000-0000-0000-000000000003','Owner reviewed partner receipt','Groceries',current_date-1,
    '[{"id":"c4000000-0000-0000-0000-000000000004","name":"Flour","quantity":2,"line_total":40,"is_personal":false,"is_tracked_for_restock":true,"display_order":0}]')
$$,'household owner may edit the partner payer receipt');
reset role;

select is((select label from public.purchases where id='c3000000-0000-0000-0000-000000000001'),'Updated receipt','receipt label updates');
select is((select category from public.purchases where id='c3000000-0000-0000-0000-000000000001'),'Food','receipt category updates');
select is((select amount from public.purchases where id='c3000000-0000-0000-0000-000000000001'),80::numeric,'receipt amount is recomputed from line totals');
select is((select is_personal from public.purchases where id='c3000000-0000-0000-0000-000000000001'),false,'mixed receipt derives shared allocation');
select is((select paid_by from public.purchases where id='c3000000-0000-0000-0000-000000000001'),'c1000000-0000-0000-0000-000000000001'::uuid,'receipt payer remains immutable');
select is((select household_id from public.purchases where id='c3000000-0000-0000-0000-000000000001'),'c2000000-0000-0000-0000-000000000001'::uuid,'receipt household remains immutable');
select is((select count(*)::integer from public.purchase_items where purchase_id='c3000000-0000-0000-0000-000000000001'),2,'submitted list fully replaces old reviewed list');
select ok((select is_tracked_for_restock and not is_personal from public.purchase_items where id='c4000000-0000-0000-0000-000000000002'),'existing item id and restock edit are preserved');
select ok((select is_personal and not is_tracked_for_restock from public.purchase_items where purchase_id='c3000000-0000-0000-0000-000000000001' and name='Milk'),'new personal item flags persist');
select is((select count(*)::integer from public.ledger_activity where action='receipt_review_updated'),2,'content-free receipt update audits are recorded');
select is((select amount from public.purchases where id='c3000000-0000-0000-0000-000000000003'),40::numeric,'owner edit recomputes partner receipt total');

insert into public.settlements(id,household_id,payer,receiver,amount,settled_on) values
  ('c5000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000002','c1000000-0000-0000-0000-000000000001',10,current_date);
insert into public.settlement_allocations(settlement_id,purchase_id,purchase_item_id,amount) values
  ('c5000000-0000-0000-0000-000000000001','c3000000-0000-0000-0000-000000000001','c4000000-0000-0000-0000-000000000002',10);

set local role authenticated;
set local request.jwt.claim.sub='c1000000-0000-0000-0000-000000000001';
select throws_ok($$
  select public.update_reviewed_purchase('c3000000-0000-0000-0000-000000000001','Too small','Food',current_date,
    '[{"id":"c4000000-0000-0000-0000-000000000002","name":"Chocolate bar","quantity":1,"line_total":10,"is_personal":false,"is_tracked_for_restock":true,"display_order":0},{"name":"Milk","quantity":1,"line_total":60,"is_personal":true,"display_order":1}]')
$$,'P0001','Reviewed item change would exceed its receipt-backed settlement allocation','allocated item cannot be reduced below settled share');
select throws_ok($$
  select public.update_reviewed_purchase('c3000000-0000-0000-0000-000000000001','Personalized','Food',current_date,
    '[{"id":"c4000000-0000-0000-0000-000000000002","name":"Chocolate bar","quantity":2,"line_total":20,"is_personal":true,"display_order":0},{"name":"Milk","quantity":1,"line_total":60,"is_personal":true,"display_order":1}]')
$$,'P0001','Reviewed item change would exceed its receipt-backed settlement allocation','allocated shared item cannot become personal');
select throws_ok($$
  select public.update_reviewed_purchase('c3000000-0000-0000-0000-000000000001','Removed allocation','Food',current_date,
    '[{"name":"Milk","quantity":1,"line_total":60,"is_personal":false,"display_order":0}]')
$$,'P0001','An allocated reviewed item cannot be removed','allocated item cannot be omitted from submitted list');
select throws_ok($$
  select public.update_reviewed_purchase('c3000000-0000-0000-0000-000000000001','Moved after payment','Food',current_date+1,
    '[{"id":"c4000000-0000-0000-0000-000000000002","name":"Chocolate bar","quantity":2,"line_total":20,"is_personal":false,"is_tracked_for_restock":true,"display_order":0},{"name":"Milk","quantity":1,"line_total":60,"is_personal":true,"display_order":1}]')
$$,'P0001','A receipt cannot be moved after its allocated payment date','allocated receipt cannot move after historic payment');
reset role;
select is((select amount from public.purchases where id='c3000000-0000-0000-0000-000000000001'),80::numeric,'rejected allocation-conflicting edits remain atomic');
select is((select amount from public.settlement_allocations where settlement_id='c5000000-0000-0000-0000-000000000001'),10::numeric,'settlement allocation remains unchanged');

select throws_ok($$
  update public.purchase_items set purchase_id='c3000000-0000-0000-0000-000000000002'
  where id='c4000000-0000-0000-0000-000000000002'
$$,'P0001','Reviewed item purchase link is immutable','item cannot move between receipts');

select * from finish();
rollback;
