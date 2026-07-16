begin;
create extension if not exists pgtap with schema extensions;
select plan(16);

select has_column('public','household_members','display_name','display name column exists');
select col_not_null('public','household_members','display_name','display name is required');
select has_function('public','set_my_display_name',array['text'],'member can set own display name');
select has_function('public','set_member_display_name',array['text'],'one-time name repair RPC exists');
select has_function('public','import_reviewed_purchase',array['uuid','uuid','text','text','text','text','numeric','date','boolean','jsonb'],'selected-payer RPC exists');
select ok(not has_function_privilege('anon','public.import_reviewed_purchase(uuid,uuid,text,text,text,text,numeric,date,boolean,jsonb)','execute'),'anonymous selected-payer import denied');
select ok(has_function_privilege('authenticated','public.import_reviewed_purchase(uuid,uuid,text,text,text,text,numeric,date,boolean,jsonb)','execute'),'authenticated selected-payer import allowed');

insert into auth.users(id) values
  ('30000000-0000-0000-0000-000000000001'),
  ('30000000-0000-0000-0000-000000000002'),
  ('30000000-0000-0000-0000-000000000003');
insert into public.households(id,name,created_by) values
  ('40000000-0000-0000-0000-000000000001','Ritesh and Ekta','30000000-0000-0000-0000-000000000001'),
  ('40000000-0000-0000-0000-000000000002','Unrelated','30000000-0000-0000-0000-000000000003');
insert into public.household_members(household_id,user_id,display_name,role) values
  ('40000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','Ritesh','owner'),
  ('40000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000002','Ekta','partner'),
  ('40000000-0000-0000-0000-000000000002','30000000-0000-0000-0000-000000000003','Unrelated user','owner');

set local role authenticated;
set local request.jwt.claim.sub='30000000-0000-0000-0000-000000000001';
select lives_ok($$
  select public.import_reviewed_purchase(
    '40000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000002',
    repeat('a',64),repeat('b',64),'Reviewed receipt','Groceries',100,current_date,false,
    '[{"name":"Rice","quantity":1,"unit":"bag","unit_price":100,"line_total":100,"is_personal":false,"is_tracked_for_restock":true,"estimated_use_by":null,"display_order":0}]'::jsonb)
$$,'uploader can select the partner as payer');
select throws_ok($$
  select public.import_reviewed_purchase(
    '40000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000003',
    repeat('c',64),repeat('d',64),'Invalid payer','Groceries',100,current_date,false,
    '[{"name":"Rice","quantity":1,"unit":"bag","unit_price":100,"line_total":100,"is_personal":false,"is_tracked_for_restock":false,"estimated_use_by":null,"display_order":0}]'::jsonb)
$$,'P0001','Selected payer must be an active household member','unrelated payer is rejected');
select throws_ok(
  $$select public.set_member_display_name(E'Unsafe\nname')$$,
  'P0001','Display name must be 1 to 80 characters without control characters','control characters are rejected from display names');
select results_eq('select display_name from public.household_members order by display_name',array['Ekta','Ritesh'],'household member sees only household display names');
select lives_ok($$select public.set_member_display_name('  Ritesh Kumar  ')$$,'member can repair their own placeholder name');
select is((select display_name from public.household_members where user_id='30000000-0000-0000-0000-000000000001'),'Ritesh Kumar','display name is trimmed before storage');
reset role;

select is((select p.paid_by from public.purchases p where p.label='Reviewed receipt'),'30000000-0000-0000-0000-000000000002'::uuid,'selected partner is stored as payer');
select is((select i.imported_by from public.invoice_imports i where i.exact_pdf_hash=repeat('a',64)),'30000000-0000-0000-0000-000000000001'::uuid,'uploader remains the import identity');

set local role authenticated;
set local request.jwt.claim.sub='30000000-0000-0000-0000-000000000003';
select is((select count(*)::integer from public.household_members where household_id='40000000-0000-0000-0000-000000000001'),0,'unrelated member cannot read display names');
reset role;

select * from finish();
rollback;
