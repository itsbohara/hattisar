-- Copied from supabase/supabase docker/volumes/db/_supabase.sql (Apache-2.0); see docker/NOTICE.

\set pguser `echo "$POSTGRES_USER"`

CREATE DATABASE _supabase WITH OWNER :pguser;
