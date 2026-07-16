begin;
create extension if not exists pgtap with schema extensions;
select plan(26);

select has_table('public','households','households exists');
select has_column('public','household_members','display_name','safe member display names exist');
select col_not_null('public','household_members','display_name','member display names are required');
select has_table('public','purchase_items','reviewed purchase items exist');
select has_column('public','purchase_items','is_personal','reviewed items carry personal/shared allocation');
select has_column('public','purchase_items','display_order','reviewed item display order is synced');
select has_table('public','invoice_imports','opaque duplicate fingerprints exist');
select has_function('public','join_household',array['uuid'],'join RPC exists');
select has_function('public','join_household',array['uuid','text'],'named join RPC exists');
select has_function('public','set_my_display_name',array['text'],'self-service display-name RPC exists');
select has_function('public','set_member_display_name',array['text'],'one-time member display-name RPC exists');
select has_function('public','import_reviewed_purchase',array['uuid','text','text','text','text','numeric','date','boolean','jsonb'],'itemized import RPC exists');
select has_function('public','import_reviewed_purchase',array['uuid','uuid','text','text','text','text','numeric','date','boolean','jsonb'],'selected-payer import RPC exists');
select is((select count(*)::integer from information_schema.columns where table_schema='public' and column_name in ('raw_pdf','pdf_bytes','extracted_text','ocr_text','receipt_text','address','payment_method','card_number','upi_id')),0,'forbidden persistence columns are absent');
select ok((select relrowsecurity from pg_class where oid='public.purchases'::regclass),'purchases RLS enabled');
select ok((select relrowsecurity from pg_class where oid='public.purchase_items'::regclass),'purchase items RLS enabled');
select ok(exists(select 1 from pg_trigger where tgrelid='public.household_members'::regclass and tgname='enforce_membership_limits_before_insert' and not tgisinternal),'membership limits trigger installed');
select ok(exists(select 1 from pg_indexes where schemaname='public' and indexname='one_owner_per_household'),'single-owner invariant installed');
select ok(not has_function_privilege('anon','public.import_reviewed_purchase(uuid,text,text,text,text,numeric,date,boolean,jsonb)','EXECUTE'),'anonymous itemized imports denied');
select ok(has_function_privilege('authenticated','public.import_reviewed_purchase(uuid,text,text,text,text,numeric,date,boolean,jsonb)','EXECUTE'),'authenticated itemized imports allowed');

insert into auth.users (id) values
  ('10000000-0000-0000-0000-000000000001'),
  ('10000000-0000-0000-0000-000000000002'),
  ('10000000-0000-0000-0000-000000000003'),
  ('10000000-0000-0000-0000-000000000004');
insert into public.households (id,name,created_by) values
  ('20000000-0000-0000-0000-000000000001','Two-person household','10000000-0000-0000-0000-000000000001'),
  ('20000000-0000-0000-0000-000000000002','Single-person household','10000000-0000-0000-0000-000000000003'),
  ('20000000-0000-0000-0000-000000000003','Other household','10000000-0000-0000-0000-000000000004');
insert into public.household_members (household_id,user_id,display_name,role) values
  ('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','Ritesh','owner'),
  ('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000002','Ekta','partner'),
  ('20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000003','Single user','owner'),
  ('20000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000004','Other user','owner');
select throws_ok(
  $$insert into public.household_members (household_id,user_id,display_name) values ('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000003','Third user')$$,
  '23514','A household can have at most two active members','third member is rejected at the database boundary'
);
select is((select count(*)::integer from public.household_members where household_id='20000000-0000-0000-0000-000000000001'),2,'failed third join leaves exactly two members');
select throws_ok(
  $$insert into public.household_members (household_id,user_id,display_name,role) values ('20000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000003','Single user','partner')$$,
  '23514','An account can belong to only one active household','an account cannot join a second active household'
);
select throws_ok(
  $$insert into public.purchases (household_id,label,category,amount,paid_by,purchased_on) values ('20000000-0000-0000-0000-000000000002','Shared food','Food',100,'10000000-0000-0000-0000-000000000003',current_date)$$,
  '23514','A partner must join before adding shared expenses','shared expenses wait for the partner'
);
select lives_ok(
  $$insert into public.purchases (household_id,label,category,amount,paid_by,purchased_on,is_personal) values ('20000000-0000-0000-0000-000000000002','Personal food','Food',100,'10000000-0000-0000-0000-000000000003',current_date,true)$$,
  'personal expenses may be recorded before the partner joins'
);
select throws_ok(
  $$insert into public.settlements (household_id,payer,receiver,amount,settled_on) values ('20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000004',100,current_date)$$,
  '23514','A partner must join before recording settlements','settlements wait for the partner'
);

select * from finish();
rollback;
