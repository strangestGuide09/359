-- Additive control plane for sanitized-derivative AI receipt parsing.
-- Keep provider access disabled by default and this ledger content-free.
-- This migration does not enable a provider and stores no document content.
begin;

create table private.ai_processing_config (
  singleton boolean primary key default true check (singleton),
  provider_enabled boolean not null default false,
  hourly_user_limit integer not null default 3 check (hourly_user_limit between 1 and 20),
  monthly_household_page_cap integer not null default 100 check (monthly_household_page_cap between 1 and 10000),
  max_derivative_bytes integer not null default 4194304 check (max_derivative_bytes between 1024 and 10485760),
  max_derivative_pages integer not null default 5 check (max_derivative_pages between 1 and 10),
  updated_at timestamptz not null default now()
);
insert into private.ai_processing_config default values;

create table private.ai_parse_jobs (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  requested_by uuid not null references auth.users(id) on delete cascade,
  idempotency_key uuid not null,
  sanitizer_version text not null check (sanitizer_version ~ '^[A-Za-z0-9._-]{1,40}$'),
  derivative_mime text not null check (derivative_mime = 'application/pdf'),
  derivative_bytes integer not null check (derivative_bytes > 0),
  page_count integer not null check (page_count > 0),
  state text not null default 'reserved' check (state in ('reserved','started','completed','failed','cancelled')),
  provider_job_id text check (provider_job_id is null or char_length(provider_job_id) between 1 and 160),
  fixed_error_code text check (fixed_error_code is null or fixed_error_code ~ '^[a-z0-9_]{1,60}$'),
  charged_units integer not null default 0 check (charged_units >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '6 hours'),
  unique (requested_by,idempotency_key)
);
create index ai_parse_jobs_user_window_idx on private.ai_parse_jobs(requested_by,created_at desc);
create index ai_parse_jobs_household_month_idx on private.ai_parse_jobs(household_id,created_at desc);

revoke all on private.ai_processing_config,private.ai_parse_jobs from public,anon,authenticated;

create function public.reserve_ai_parse(
  p_household_id uuid,
  p_idempotency_key uuid,
  p_sanitizer_version text,
  p_derivative_mime text,
  p_derivative_bytes integer,
  p_page_count integer
) returns table(job_id uuid,is_new boolean) language plpgsql security definer set search_path = '' as $$
declare config private.ai_processing_config%rowtype; existing_id uuid; new_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if not private.is_household_active_member(p_household_id) then raise exception 'Active household membership is required'; end if;
  if p_idempotency_key is null then raise exception 'Idempotency key is required'; end if;
  if coalesce(p_sanitizer_version !~ '^[A-Za-z0-9._-]{1,40}$',true) then raise exception 'Invalid sanitizer version'; end if;
  select * into config from private.ai_processing_config where singleton;
  if not config.provider_enabled then raise exception 'AI processing is disabled'; end if;
  if p_derivative_mime <> 'application/pdf' then raise exception 'Unsupported sanitized derivative type'; end if;
  if p_derivative_bytes not between 1 and config.max_derivative_bytes then raise exception 'Sanitized derivative is too large'; end if;
  if p_page_count not between 1 and config.max_derivative_pages then raise exception 'Sanitized derivative page count is invalid'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,0));
  select id into existing_id from private.ai_parse_jobs where requested_by=auth.uid() and idempotency_key=p_idempotency_key;
  if existing_id is not null then return query select existing_id,false; return; end if;
  if (select count(*) from private.ai_parse_jobs where requested_by=auth.uid() and created_at>now()-interval '1 hour') >= config.hourly_user_limit then
    raise exception 'AI parse hourly limit reached';
  end if;
  if coalesce((select sum(page_count) from private.ai_parse_jobs where household_id=p_household_id and created_at>=date_trunc('month',now())),0)+p_page_count > config.monthly_household_page_cap then
    raise exception 'AI parse monthly household cap reached';
  end if;
  insert into private.ai_parse_jobs(household_id,requested_by,idempotency_key,sanitizer_version,derivative_mime,derivative_bytes,page_count)
  values(p_household_id,auth.uid(),p_idempotency_key,p_sanitizer_version,p_derivative_mime,p_derivative_bytes,p_page_count)
  returning id into new_id;
  return query select new_id,true;
end;
$$;

create function public.mark_ai_parse_started(p_job_id uuid,p_provider_job_id text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() <> 'service_role' then raise exception 'Server role required'; end if;
  if coalesce(p_provider_job_id !~ '^[A-Za-z0-9._:-]{1,160}$',true) then raise exception 'Invalid provider job id'; end if;
  update private.ai_parse_jobs set state='started',provider_job_id=p_provider_job_id,updated_at=now()
  where id=p_job_id and state='reserved' and expires_at>now();
  if not found then raise exception 'Active AI parse reservation not found'; end if;
end;
$$;

create function public.mark_ai_parse_finished(p_job_id uuid,p_state text,p_fixed_error_code text default null,p_charged_units integer default 0)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() <> 'service_role' then raise exception 'Server role required'; end if;
  if p_state not in ('completed','failed','cancelled') then raise exception 'Invalid terminal AI parse state'; end if;
  if p_fixed_error_code is not null and p_fixed_error_code !~ '^[a-z0-9_]{1,60}$' then raise exception 'Invalid fixed error code'; end if;
  if p_charged_units < 0 then raise exception 'Invalid charged units'; end if;
  update private.ai_parse_jobs set state=p_state,fixed_error_code=p_fixed_error_code,charged_units=p_charged_units,updated_at=now(),expires_at=least(expires_at,now()+interval '1 hour')
  where id=p_job_id and state in ('reserved','started') and p_charged_units<=page_count;
  if not found then raise exception 'Active AI parse reservation not found'; end if;
end;
$$;

revoke execute on function public.reserve_ai_parse(uuid,uuid,text,text,integer,integer),public.mark_ai_parse_started(uuid,text),public.mark_ai_parse_finished(uuid,text,text,integer) from public,anon,authenticated;
grant execute on function public.reserve_ai_parse(uuid,uuid,text,text,integer,integer) to authenticated;
grant execute on function public.mark_ai_parse_started(uuid,text),public.mark_ai_parse_finished(uuid,text,text,integer) to service_role;
notify pgrst, 'reload schema';
commit;
