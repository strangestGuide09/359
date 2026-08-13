begin;
create extension if not exists pgtap with schema extensions;
select plan(53);

select has_table('public','settlement_allocations','receipt-backed allocation table exists');
select has_column('public','settlement_allocations','settlement_id','allocation links settlement');
select has_column('public','settlement_allocations','purchase_id','allocation links receipt');
select has_column('public','settlement_allocations','purchase_item_id','allocation may link reviewed item');
select has_column('public','settlement_allocations','amount','allocation stores settled amount');
select col_is_fk('public','settlement_allocations','settlement_id','settlement link cascades');
select col_is_fk('public','settlement_allocations','purchase_id','receipt link cascades');
select col_is_fk('public','settlement_allocations','purchase_item_id','item link cascades');
select has_function('public','record_receipt_backed_settlement',array['uuid','uuid','numeric','date','jsonb'],'atomic receipt-backed settlement RPC exists');
select has_view('public','receipt_backed_settlement_history','active allocation history view exists');
select ok(not has_function_privilege('anon','public.record_receipt_backed_settlement(uuid,uuid,numeric,date,jsonb)','execute'),'anonymous settlement RPC denied');
select ok(has_function_privilege('authenticated','public.record_receipt_backed_settlement(uuid,uuid,numeric,date,jsonb)','execute'),'authenticated settlement RPC granted');
select ok(not has_table_privilege('authenticated','public.settlement_allocations','insert'),'allocations cannot be inserted directly');
select ok(not has_table_privilege('authenticated','public.settlements','insert'),'free-standing settlements cannot be inserted directly');
select ok(not has_function_privilege('anon','private.validate_settlement_allocation()','execute'),'allocation guard is not app-callable');
select ok(not has_function_privilege('authenticated','private.remove_orphaned_receipt_settlement()','execute'),'orphan cleanup trigger is not app-callable');
select ok(not has_function_privilege('authenticated','private.guard_settlement_identity()','execute'),'identity guard is not app-callable');

insert into auth.users(id) values
  ('a1000000-0000-0000-0000-000000000001'),
  ('a1000000-0000-0000-0000-000000000002'),
  ('a1000000-0000-0000-0000-000000000003');
insert into public.households(id,name,created_by) values
  ('a2000000-0000-0000-0000-000000000001','Allocated payments','a1000000-0000-0000-0000-000000000001'),
  ('a2000000-0000-0000-0000-000000000002','Unrelated','a1000000-0000-0000-0000-000000000003');
insert into public.household_members(household_id,user_id,display_name,role) values
  ('a2000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000001','Owner','owner'),
  ('a2000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000002','Partner','partner'),
  ('a2000000-0000-0000-0000-000000000002','a1000000-0000-0000-0000-000000000003','Outsider','owner');
insert into public.purchases(id,household_id,label,category,amount,paid_by,purchased_on,is_personal) values
  ('a3000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000001','Earlier receipt','Groceries',100,'a1000000-0000-0000-0000-000000000001',current_date-2,false);
insert into public.purchase_items(id,purchase_id,display_order,name,quantity,line_total,is_personal) values
  ('a4000000-0000-0000-0000-000000000001','a3000000-0000-0000-0000-000000000001',0,'Rice',1,100,false);

-- A pre-migration free-standing row remains stored but is deliberately ignored.
insert into public.settlements(id,household_id,payer,receiver,amount,settled_on) values
  ('a5000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000002','a1000000-0000-0000-0000-000000000001',10,current_date-1);
select is(private.member_balance('a2000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000001'),50::numeric,'legacy unallocated payment does not affect balance');
select is((select count(*)::integer from public.receipt_backed_settlement_history),0,'legacy unallocated payment is absent from visible history');

set local role authenticated;
set local request.jwt.claim.sub='a1000000-0000-0000-0000-000000000002';
select lives_ok($$
  select public.record_receipt_backed_settlement(
    'a2000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000001',30,current_date-1,
    '[{"purchase_id":"a3000000-0000-0000-0000-000000000001","purchase_item_id":"a4000000-0000-0000-0000-000000000001","amount":30}]'::jsonb)
$$,'partner records an allocated payment to the receipt payer');
reset role;
select is(private.member_balance('a2000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000001'),20::numeric,'allocated payment reduces receiver balance');
select is(private.member_balance('a2000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000002'),-20::numeric,'allocated payment reduces payer debt');
select results_eq(
  $$select amount,allocation_count from public.receipt_backed_settlement_history$$,
  $$values (30::numeric,1)$$,'visible history derives amount from active allocations');
select results_eq(
  $$select purchase_ids,purchase_item_ids from public.receipt_backed_settlement_history$$,
  $$values (array['a3000000-0000-0000-0000-000000000001'::uuid],array['a4000000-0000-0000-0000-000000000001'::uuid])$$,
  'visible history identifies its exact supporting receipt and reviewed item');

set local role authenticated;
set local request.jwt.claim.sub='a1000000-0000-0000-0000-000000000003';
select is((select count(*)::integer from public.settlement_allocations),0,'unrelated household cannot read allocations');
select is((select count(*)::integer from public.receipt_backed_settlement_history),0,'unrelated household cannot read payment history');
reset role;

set local role authenticated;
set local request.jwt.claim.sub='a1000000-0000-0000-0000-000000000002';
select throws_ok($$
  select public.record_receipt_backed_settlement(
    'a2000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000001',10,current_date-1,
    '[{"purchase_id":"a3000000-0000-0000-0000-000000000001","amount":9}]'::jsonb)
$$,'P0001','Settlement allocations must equal the payment amount','allocation sum must equal settlement amount');
reset role;

insert into public.purchases(id,household_id,label,category,amount,paid_by,purchased_on,is_personal) values
  ('a3000000-0000-0000-0000-000000000002','a2000000-0000-0000-0000-000000000001','Later receipt','Groceries',40,'a1000000-0000-0000-0000-000000000001',current_date,false);
insert into public.purchase_items(id,purchase_id,display_order,name,quantity,line_total,is_personal) values
  ('a4000000-0000-0000-0000-000000000002','a3000000-0000-0000-0000-000000000002',0,'Milk',1,40,false);

set local role authenticated;
set local request.jwt.claim.sub='a1000000-0000-0000-0000-000000000002';
select throws_ok($$
  select public.record_receipt_backed_settlement(
    'a2000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000001',10,current_date-1,
    '[{"purchase_id":"a3000000-0000-0000-0000-000000000002","amount":10}]'::jsonb)
$$,'P0001','A payment cannot settle a later receipt','historic payment cannot be attached to a later invoice');
select throws_ok($$
  select public.record_receipt_backed_settlement(
    'a2000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000001',25,current_date,
    '[{"purchase_id":"a3000000-0000-0000-0000-000000000001","amount":25}]'::jsonb)
$$,'P0001','Receipt allocation exceeds the household share','receipt cannot be over-settled');
reset role;
select is(private.member_balance('a2000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000001'),40::numeric,'later invoice adds balance without consuming historic payment');

set local role authenticated;
set local request.jwt.claim.sub='a1000000-0000-0000-0000-000000000001';
select lives_ok($$select public.delete_purchase_receipt('a3000000-0000-0000-0000-000000000001')$$,'receipt archive preserves but deactivates allocations');
reset role;
select is((select count(*)::integer from public.receipt_backed_settlement_history),0,'archived receipt hides its payment history');
select is((select count(*)::integer from public.settlement_allocations),1,'receipt archive preserves its allocation for restoration');
select is(private.member_balance('a2000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000001'),20::numeric,'archived receipt and its allocations leave only later invoice balance');

set local role authenticated;
set local request.jwt.claim.sub='a1000000-0000-0000-0000-000000000001';
select lives_ok($$select public.restore_purchase_receipt('a3000000-0000-0000-0000-000000000001')$$,'receipt restore reactivates existing allocations');
reset role;
select is((select count(*)::integer from public.receipt_backed_settlement_history),1,'restored receipt restores payment history');
select is(private.member_balance('a2000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000001'),40::numeric,'restored receipt restores its allocated accounting effect');

set local role authenticated;
set local request.jwt.claim.sub='a1000000-0000-0000-0000-000000000002';
select lives_ok($$
  update public.settlements set archived_at=now(),archived_by=auth.uid()
  where id<>'a5000000-0000-0000-0000-000000000001'
$$,'existing settlement archive remains compatible');
reset role;
select is((select count(*)::integer from public.receipt_backed_settlement_history),0,'archived settlement is absent from active payment history');
select is(private.member_balance('a2000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000001'),70::numeric,'archived settlement no longer affects balance');

set local role authenticated;
set local request.jwt.claim.sub='a1000000-0000-0000-0000-000000000002';
select lives_ok($$
  update public.settlements set archived_at=null,archived_by=null
  where id<>'a5000000-0000-0000-0000-000000000001'
$$,'existing settlement restore remains compatible');
select throws_ok($$
  update public.settlements set amount=31
  where id<>'a5000000-0000-0000-0000-000000000001'
$$,'P0001','Receipt-backed settlement identity is immutable','supporting payment identity cannot be rewritten');
reset role;
select is((select count(*)::integer from public.receipt_backed_settlement_history),1,'restored settlement returns to active payment history');
select is(private.member_balance('a2000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000001'),40::numeric,'restored settlement returns to active balance');

set local role authenticated;
set local request.jwt.claim.sub='a1000000-0000-0000-0000-000000000001';
select lives_ok($$select public.delete_purchase_receipt('a3000000-0000-0000-0000-000000000001')$$,'receipt is archived again before purge');
select lives_ok($$select public.purge_purchase_receipt('a3000000-0000-0000-0000-000000000001')$$,'owner purges archived receipt');
reset role;
select is((select count(*)::integer from public.settlement_allocations),0,'receipt purge cascades its allocations');
select is((select count(*)::integer from public.settlements where id<>'a5000000-0000-0000-0000-000000000001'),0,'purge removes newly orphaned settlement');
select is((select count(*)::integer from public.settlements where id='a5000000-0000-0000-0000-000000000001'),1,'legacy settlement remains stored but inactive');
select is((select count(*)::integer from public.ledger_activity where action='settlement_recorded'),0,'orphan settlement audit identifier is removed');
select is((select count(*)::integer from public.receipt_backed_settlement_history),0,'purged allocation cannot appear in payment history');
select is((select count(*)::integer from public.purchases where id='a3000000-0000-0000-0000-000000000002'),1,'later receipt remains intact');
select is(private.member_balance('a2000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000001'),20::numeric,'purge leaves only the later invoice balance');

select * from finish();
rollback;
