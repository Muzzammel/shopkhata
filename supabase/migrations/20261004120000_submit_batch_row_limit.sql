-- BIG SLICE 5: enforce the 100-row batch limit in the database.
--
-- The limit was applied only by the application's server action. The RPC can
-- be called directly by any signed-in account, where a batch of any size was
-- accepted. An oversized batch is now refused before any row is examined.
--
-- submit_batch is the largest function in the schema and has been restated in
-- full five times. To leave every other line exactly as deployed, this adds the
-- one check to the stored definition instead of restating it, and stops the
-- migration unless the insertion point is found exactly once.
do $$
declare
  definition text := pg_get_functiondef('public.submit_batch(jsonb)'::regprocedure);
  anchor constant text := 'v_rows := command -> ''rows'';';
  guard constant text := E'\n\n  if jsonb_array_length(v_rows) > 100 then\n'
    || E'    raise exception ''BATCH_VALIDATION_FAILED'' using errcode = ''P0001'',\n'
    || E'      detail = jsonb_build_array(jsonb_build_object(''row_id'', null, ''field'', ''rows'', ''code'', ''BATCH_TOO_LARGE'', ''message'', ''A batch can contain at most 100 rows.''))::text;\n'
    || E'  end if;';
begin
  if (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 then
    raise exception 'submit_batch_row_limit: expected the rows assignment exactly once in public.submit_batch';
  end if;
  if position('BATCH_TOO_LARGE' in definition) > 0 then
    raise exception 'submit_batch_row_limit: public.submit_batch already enforces a row limit';
  end if;
  execute replace(definition, anchor, anchor || guard);
end $$;
