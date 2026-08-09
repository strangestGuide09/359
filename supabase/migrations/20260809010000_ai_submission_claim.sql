-- Recover stranded reserved jobs without persisting content or allowing
-- concurrent duplicate provider submissions.
begin;

alter table private.ai_parse_jobs
  add column if not exists submission_attempt_count integer not null default 0
    check (submission_attempt_count between 0 and 3),
  add column if not exists submission_claimed_at timestamptz;

create or replace function public.claim_ai_parse_submission(
  p_job_id uuid,
  p_requesting_user uuid
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  config private.ai_processing_config%rowtype;
  job private.ai_parse_jobs%rowtype;
begin
  if auth.role() <> 'service_role' then raise exception 'Server role required'; end if;
  if p_job_id is null or p_requesting_user is null then raise exception 'Submission identity is required'; end if;
  select * into config from private.ai_processing_config where singleton;
  if not config.provider_enabled then raise exception 'AI processing is disabled'; end if;

  perform pg_advisory_xact_lock(hashtextextended(p_job_id::text,0));
  select * into job from private.ai_parse_jobs where id=p_job_id and requested_by=p_requesting_user;
  if not found then raise exception 'AI parse job not found'; end if;
  if not exists (
    select 1 from public.household_members m join public.households h on h.id=m.household_id
    where m.household_id=job.household_id and m.user_id=p_requesting_user and h.archived_at is null
  ) then raise exception 'Active household membership is required'; end if;
  if job.state <> 'reserved' then return false; end if;
  if job.expires_at <= now() then
    update private.ai_parse_jobs set state='cancelled',fixed_error_code='job_expired',updated_at=now() where id=job.id;
    return false;
  end if;
  if job.submission_attempt_count >= 3 then
    update private.ai_parse_jobs set state='failed',fixed_error_code='submission_retry_exhausted',updated_at=now() where id=job.id;
    return false;
  end if;
  if job.submission_claimed_at is not null and job.submission_claimed_at > now()-interval '30 seconds' then return false; end if;

  update private.ai_parse_jobs set
    submission_attempt_count=submission_attempt_count+1,
    submission_claimed_at=now(),
    updated_at=now()
  where id=job.id;
  return true;
end;
$$;

revoke execute on function public.claim_ai_parse_submission(uuid,uuid) from public,anon,authenticated;
grant execute on function public.claim_ai_parse_submission(uuid,uuid) to service_role;
notify pgrst, 'reload schema';
commit;
