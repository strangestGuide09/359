-- Durable, content-free completion controls for asynchronous AI parse jobs.
-- No provider output or document content is stored by this migration.
begin;

alter table private.ai_processing_config
  add column if not exists completion_poll_limit integer not null default 60
    check (completion_poll_limit between 1 and 240),
  add column if not exists completion_min_poll_seconds integer not null default 2
    check (completion_min_poll_seconds between 1 and 60);

alter table private.ai_parse_jobs
  add column if not exists completion_poll_count integer not null default 0
    check (completion_poll_count >= 0),
  add column if not exists last_completion_poll_at timestamptz;

create or replace function public.claim_ai_parse_completion(
  p_job_id uuid,
  p_household_id uuid,
  p_requesting_user uuid
) returns table(
  provider_job_id text,
  job_state text,
  fixed_error_code text,
  page_count integer,
  expires_at timestamptz,
  retry_after_seconds integer
) language plpgsql security definer set search_path = '' as $$
declare
  config private.ai_processing_config%rowtype;
  job private.ai_parse_jobs%rowtype;
  retry_seconds integer := 0;
begin
  if auth.role() <> 'service_role' then raise exception 'Server role required'; end if;
  if p_job_id is null or p_household_id is null or p_requesting_user is null then raise exception 'Completion identity is required'; end if;
  select * into config from private.ai_processing_config where singleton;
  if not config.provider_enabled then raise exception 'AI processing is disabled'; end if;
  if not exists (
    select 1 from public.household_members m join public.households h on h.id=m.household_id
    where m.household_id=p_household_id and m.user_id=p_requesting_user and h.archived_at is null
  ) then raise exception 'Active household membership is required'; end if;

  perform pg_advisory_xact_lock(hashtextextended(p_job_id::text,0));
  select * into job from private.ai_parse_jobs
  where id=p_job_id and household_id=p_household_id and requested_by=p_requesting_user;
  if not found then raise exception 'AI parse job not found'; end if;

  if job.state in ('reserved','started','completed') and job.expires_at <= now() then
    update private.ai_parse_jobs set state='cancelled',fixed_error_code='job_expired',updated_at=now()
    where id=job.id;
    job.state := 'cancelled'; job.fixed_error_code := 'job_expired';
  end if;

  if job.state in ('started','completed') then
    if job.completion_poll_count >= config.completion_poll_limit then
      update private.ai_parse_jobs set state='cancelled',fixed_error_code='completion_timeout',updated_at=now()
      where id=job.id and state='started';
      if job.state='started' then job.state := 'cancelled'; job.fixed_error_code := 'completion_timeout'; end if;
    elsif job.last_completion_poll_at is not null and job.last_completion_poll_at > now()-make_interval(secs=>config.completion_min_poll_seconds) then
      retry_seconds := config.completion_min_poll_seconds;
    else
      update private.ai_parse_jobs set completion_poll_count=completion_poll_count+1,last_completion_poll_at=now(),updated_at=now()
      where id=job.id;
    end if;
  end if;

  return query select
    case when job.state in ('started','completed') and retry_seconds=0 then job.provider_job_id else null end,
    job.state,job.fixed_error_code,job.page_count,job.expires_at,retry_seconds;
end;
$$;

revoke execute on function public.claim_ai_parse_completion(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.claim_ai_parse_completion(uuid,uuid,uuid) to service_role;
notify pgrst, 'reload schema';
commit;
