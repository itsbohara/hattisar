-- Copied from supabase/supabase docker/volumes/db/pooler.sql (Apache-2.0); see docker/NOTICE.

\set pguser `echo "$POSTGRES_USER"`

\c _supabase
create schema if not exists _supavisor;
alter schema _supavisor owner to :pguser;
\c postgres
