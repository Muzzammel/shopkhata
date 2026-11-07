-- Deterministic fingerprint of the authoritative ShopKhata state. Run as the
-- database owner (it must see every shop). The same query runs against the
-- source when a backup is taken and against the restored copy; `pnpm
-- backup:verify` fails unless both results are identical.
select jsonb_build_object(
  -- Every public table, including ones added by later migrations: row count and a hash of every row.
  'tables', (
    select jsonb_object_agg(t.table_name, (xpath('/row/v/text()', query_to_xml(format(
      'select count(*) || '':'' || coalesce(md5(string_agg(r::text, ''|'' order by r::text)), '''') v from public.%I r', t.table_name), false, true, '')))[1]::text)
    from information_schema.tables t where t.table_schema = 'public' and t.table_type = 'BASE TABLE'),
  'auth_users', (select count(*) || ':' || coalesce(md5(string_agg(u.id || u.email || coalesce(u.encrypted_password, ''), '|' order by u.id)), '') from auth.users u),
  -- EVERY Storage table (enumerated from the catalog, so a table added by a Storage upgrade is covered too): row count
  -- and row hash, keyed "storage.<table>". A restore skips empty COPY sections only when the source count here is 0, and
  -- the restored fingerprint must equal this one, which proves the target is empty too.
  --   storage.objects   stable projection (bucket, name, uploader, size, type, eTag, user metadata): re-uploading the bytes
  --                     legitimately rewrites id-independent bookkeeping (version, updated_at, last_accessed_at).
  --   storage.migrations EXCLUDED: the Storage service's own schema history, created by the platform per project; it is
  --                     not in the data dump at all (supabase db dump --data-only omits it), so nothing restores it.
  --   not readable      recorded as "unreadable"; a restore STOPs if such a table's section would need to be skipped.
  'storage', (
    select coalesce(jsonb_object_agg('storage.' || c.relname, case
      when not has_table_privilege(c.oid, 'SELECT') then 'unreadable'
      when c.relname = 'objects' then (xpath('/row/v/text()', query_to_xml(
        'select count(*) || '':'' || coalesce(md5(string_agg(concat_ws(''|'', o.bucket_id, o.name, o.owner_id, o.metadata ->> ''size'', o.metadata ->> ''mimetype'', o.metadata ->> ''eTag'', o.user_metadata::text), E''\n'' order by o.bucket_id, o.name)), '''') v from storage.objects o',
        false, true, '')))[1]::text
      else (xpath('/row/v/text()', query_to_xml(format(
        'select count(*) || '':'' || coalesce(md5(string_agg(r::text, ''|'' order by r::text)), '''') v from storage.%I r', c.relname), false, true, '')))[1]::text
    end), '{}')
    from pg_class c where c.relnamespace = 'storage'::regnamespace and c.relkind in ('r', 'p') and c.relname <> 'migrations'),
  'receipt_objects', (select count(*) || ':' || coalesce(md5(string_agg(o.name || ':' || coalesce(o.metadata ->> 'size', ''), '|' order by o.name)), '') from storage.objects o where o.bucket_id = 'expense-receipts'),
  -- The projections the application reports from, per shop.
  'shops', (
    select jsonb_object_agg(s.id, jsonb_build_object(
      'sales_totals', (select to_jsonb(x) from public.report_sales_totals(s.id, '0001-01-01', '9999-12-31') x),
      'customer_due_totals', (select to_jsonb(x) from public.report_customer_due_totals(s.id) x),
      'payment_totals', (select coalesce(jsonb_agg(to_jsonb(x) order by x.source nulls first, x.method nulls first), '[]') from public.report_payment_totals(s.id, '0001-01-01', '9999-12-31') x),
      'expense_totals', (select coalesce(jsonb_agg(to_jsonb(x) order by x.category nulls first), '[]') from public.report_expense_totals(s.id, '0001-01-01', '9999-12-31') x),
      'effective_invoices', (select count(*) || ':' || coalesce(md5(string_agg(e::text, '|' order by e.canonical_invoice_id)), '') from public.effective_invoices e where e.shop_id = s.id),
      'customer_balances', (select count(*) || ':' || coalesce(md5(string_agg(b::text, '|' order by b.customer_id)), '') from public.customer_financial_balances b where b.shop_id = s.id),
      'customer_ledger', (select count(*) || ':' || coalesce(md5(string_agg(l::text, '|' order by l.sequence_id, l.entry_type)), '') from public.customer_ledger l where l.shop_id = s.id),
      'effective_expenses', (select count(*) || ':' || coalesce(md5(string_agg(x::text, '|' order by x.id)), '') from public.effective_expenses x where x.shop_id = s.id),
      'closed_dates', (select coalesce(jsonb_agg(d.business_date order by d.business_date), '[]') from (
        select distinct on (c.business_date) c.business_date, c.event_type from public.daily_closes c where c.shop_id = s.id order by c.business_date, c.event_sequence desc) d where d.event_type = 'closed')
    )) from public.shops s),
  'migrations', (select coalesce(jsonb_agg(m.version order by m.version), '[]') from supabase_migrations.schema_migrations m)
) as fingerprint;
