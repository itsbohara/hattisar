-- Modified from supabase/supabase docker/volumes/db/roles.sql (Apache-2.0); see docker/NOTICE.
-- Only pgbouncer gets a password: supavisor's auth_query logs in as it with POSTGRES_PASSWORD.
-- The roles of services this stack does not run keep none.
\set pgpass `echo "$POSTGRES_PASSWORD"`

ALTER USER pgbouncer WITH PASSWORD :'pgpass';
