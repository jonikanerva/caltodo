-- The catalog snapshot of the application tables in the `public` schema.
--
-- The migration tests compare this snapshot between databases. The Node
-- fixture generator wrote `drizzle_schema.snapshot.json` with this query
-- after the real Drizzle migrator ran. The snapshot excludes the objects
-- that the Rust server adds on purpose: the SQLx ledger `_sqlx_migrations`
-- and the session table `app_sessions` with its indexes. The `drizzle`
-- schema is outside `public`, so the snapshot excludes it too.
SELECT json_build_object(
  'tables', (
    SELECT coalesce(json_agg(json_build_object(
      'table', c.relname,
      'kind', c.relkind
    ) ORDER BY c.relname), '[]'::json)
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
      AND c.relname NOT IN ('_sqlx_migrations', 'app_sessions')
  ),
  'columns', (
    SELECT coalesce(json_agg(json_build_object(
      'table', c.relname,
      'position', a.attnum,
      'name', a.attname,
      'type', format_type(a.atttypid, a.atttypmod),
      'not_null', a.attnotnull,
      'default', pg_get_expr(d.adbin, d.adrelid)
    ) ORDER BY c.relname, a.attnum), '[]'::json)
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND c.relname NOT IN ('_sqlx_migrations', 'app_sessions')
  ),
  'constraints', (
    SELECT coalesce(json_agg(json_build_object(
      'table', c.relname,
      'name', con.conname,
      'type', con.contype,
      'definition', pg_get_constraintdef(con.oid)
    ) ORDER BY c.relname, con.conname), '[]'::json)
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname NOT IN ('_sqlx_migrations', 'app_sessions')
  ),
  'indexes', (
    SELECT coalesce(json_agg(json_build_object(
      'table', i.tablename,
      'name', i.indexname,
      'definition', i.indexdef
    ) ORDER BY i.tablename, i.indexname), '[]'::json)
    FROM pg_indexes i
    WHERE i.schemaname = 'public'
      AND i.tablename NOT IN ('_sqlx_migrations', 'app_sessions')
  ),
  'functions', (
    SELECT coalesce(json_agg(p.proname ORDER BY p.proname), '[]'::json)
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
  )
)::text AS snapshot
