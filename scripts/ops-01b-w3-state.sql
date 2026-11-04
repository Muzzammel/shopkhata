-- OPS-01B W3 authoritative state read (runbook §7 "W3 failure matrix"). READ-ONLY, ONE statement, so it runs with
-- `supabase db query -f`. Take it twice, on NEW connections, at least 10 s apart, and save both outputs; then classify
-- with scripts/ops-01b-w3-state.mjs. Never remove the firewall on these outputs by eye.
select
  clock_timestamp() as read_at,
  -- Every singleton row (0 or 2+ rows = UNKNOWN), with the fields that make it internally consistent.
  (select coalesce(jsonb_agg(jsonb_build_object('enabled', m.enabled, 'enabled_at', m.enabled_at, 'enabled_by', m.enabled_by,
     'has_reason', btrim(coalesce(m.reason, '')) <> '', 'release_ref', m.release_ref, 'bypass_user_id', m.bypass_user_id)), '[]'::jsonb)
   from private.system_maintenance m) as maintenance,
  -- The latest enable/disable in the audit trail; it must agree with the state.
  (select to_jsonb(x) from (select action, metadata ->> 'release_ref' as release_ref, (metadata ->> 'at')::timestamptz as at
     from public.audit_events where entity_type = 'system_maintenance' and action in ('maintenance.enabled', 'maintenance.disabled')
     order by (metadata ->> 'at')::timestamptz desc limit 1) x) as last_transition,
  -- A control call still running (e.g. the W3 enable whose client crashed) can still change the state.
  (select count(*) from pg_stat_activity a where a.pid <> pg_backend_pid() and a.state <> 'idle' and a.query ilike '%set_maintenance%') as pending_controls,
  -- Fail closed if this session cannot see other sessions' queries.
  (select count(*) = 0 from pg_stat_activity a where a.pid <> pg_backend_pid() and a.backend_type = 'client backend' and a.query = '<insufficient privilege>') as activity_visible
