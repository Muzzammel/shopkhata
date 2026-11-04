-- OPS-01B W5 quiescence observation. READ-ONLY. Prints ONE json line. Run it TWICE, at least 5 seconds apart (runbook
-- W5); both must say "quiescent": true, and the session inventory must be reviewed. `pnpm backup:db` with
-- SHOPKHATA_BACKUP_REQUIRE_QUIESCENT=1 runs it before and after the dumps and refuses to take the W6 recovery point
-- otherwise.
--
-- quiescent = no other client session is running a statement or holding a transaction open, no session has written in
-- an open transaction (backend_xid), nobody waits for a lock, and no other session holds a row-write lock on an
-- application, Storage or Auth relation. An old pre-36 RPC transaction left open across the bootstrap shows up here
-- (idle in transaction, backend_xid set, RowExclusiveLock on its tables) even though the maintenance barrier could not
-- see it.
with others as (
  select a.pid, a.usename, a.application_name, a.state, a.xact_start, a.backend_xid is not null as wrote, a.wait_event_type, left(a.query, 80) as query
  from pg_stat_activity a
  where a.datname = current_database() and a.pid <> pg_backend_pid() and a.backend_type = 'client backend'),
write_locks as (
  select l.pid, n.nspname || '.' || c.relname || ':' || l.mode as lock
  from pg_locks l join pg_class c on c.oid = l.relation join pg_namespace n on n.oid = c.relnamespace
  where l.pid <> pg_backend_pid() and l.granted and n.nspname in ('public', 'private', 'storage', 'auth')
    and l.mode in ('RowExclusiveLock', 'ShareUpdateExclusiveLock', 'ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock'))
select jsonb_build_object(
  'at', clock_timestamp(),
  'quiescent', (select count(*) = 0 from others where state <> 'idle' or xact_start is not null or wrote or wait_event_type = 'Lock')
    and (select count(*) = 0 from pg_locks where not granted)
    and (select count(*) = 0 from write_locks),
  'busy', (select count(*) from others where state <> 'idle' or xact_start is not null or wait_event_type = 'Lock'),
  'open_writers', (select count(*) from others where wrote),
  'lock_waiters', (select count(*) from pg_locks where not granted),
  'write_locks', (select coalesce(jsonb_agg(pid || ' ' || lock order by pid, lock), '[]') from write_locks),
  'sessions', (select coalesce(jsonb_agg(jsonb_build_object('pid', pid, 'user', usename, 'app', application_name, 'state', state,
      'xact_start', xact_start, 'wrote', wrote, 'wait', wait_event_type, 'query', query) order by usename, pid), '[]') from others)
) as quiescence;
