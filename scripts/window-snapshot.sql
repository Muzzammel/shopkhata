-- Release-window snapshot. READ-ONLY (every statement is a SELECT); run as the database owner (it must see every shop).
-- Prints ONE json line.
--
-- RECORD LEVEL. Every public base table (whatever migrations have added) is captured row by row, keyed by its primary
-- key, with the full row content, so scripts/window-compare.mjs can say exactly WHICH record was inserted, changed or
-- deleted and check it against the operator's record-level smoke declaration. The audit trail is one of those tables;
-- the comparator separates maintenance.* rows (release control) from business audit rows (which must be declared).
-- Receipts are captured per object (owner, size, type, eTag), accounts as one hash (no smoke creates an account; the
-- password hashes are never written into the evidence), plus the applied migrations and the full maintenance state.
--
-- Each table's rows are aggregated through query_to_xml (so this stays one plain SELECT without helper objects) and
-- base64-encoded inside it, so XML escaping can never alter the JSON.
-- ponytail: the whole business data set goes into one JSON document. Fine for the pilot's volume (thousands of rows);
-- past ~100k rows switch to per-row hashes plus full content only for rows newer than the recovery point.
select jsonb_build_object(
  'at', clock_timestamp(),
  'rows', (
    select coalesce(jsonb_object_agg(t.relname, convert_from(decode((xpath('/row/v/text()', query_to_xml(format(
      'select encode(convert_to(coalesce(jsonb_object_agg(%s, to_jsonb(r)), ''{}'')::text, ''UTF8''), ''base64'') v from public.%I r',
      coalesce(t.keyexpr, 'md5(r::text)'), t.relname), false, true, '')))[1]::text, 'base64'), 'UTF8')::jsonb), '{}')
    from (
      select c.relname::text as relname,
        (select string_agg(format('r.%I::text', a.attname), ' || ''|'' || ' order by array_position(i.indkey::int2[], a.attnum))
           from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
          where i.indrelid = c.oid and i.indisprimary) as keyexpr
      from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')) t),
  'receipts', (select coalesce(jsonb_object_agg(o.name, jsonb_build_object('owner_id', o.owner_id, 'size', o.metadata ->> 'size',
      'mimetype', o.metadata ->> 'mimetype', 'etag', o.metadata ->> 'eTag', 'created_at', o.created_at)), '{}')
    from storage.objects o where o.bucket_id = 'expense-receipts'),
  'auth_users', (select count(*) || ':' || coalesce(md5(string_agg(u.id || u.email || coalesce(u.encrypted_password, ''), '|' order by u.id)), '') from auth.users u),
  'migrations', (select coalesce(jsonb_agg(m.version order by m.version), '[]') from supabase_migrations.schema_migrations m),
  -- null before migration 36 exists
  'maintenance', case when to_regclass('private.system_maintenance') is null then null else
    convert_from(decode((xpath('/row/v/text()', query_to_xml(
      'select encode(convert_to(coalesce((select to_jsonb(m) - ''updated_at'' from private.system_maintenance m), ''null'')::text, ''UTF8''), ''base64'') v',
      false, true, '')))[1]::text, 'base64'), 'UTF8')::jsonb end
) as snapshot;
