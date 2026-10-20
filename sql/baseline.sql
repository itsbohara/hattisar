-- Applied by hattisar, as the box admin, inside every new project database.
-- :"owner" and :"db" are replaced with escaped identifiers before this runs.
--
-- Nothing here for the shared box's pooler: Supavisor runs its auth_query
-- (pgbouncer.get_auth) in the tenant's own database, not the one the client asks for, so an
-- owner role authenticates through the pooler with no objects in its project database.

CREATE SCHEMA IF NOT EXISTS extensions;

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA extensions;

ALTER SCHEMA public OWNER TO :"owner";
GRANT USAGE ON SCHEMA extensions TO :"owner";

ALTER DATABASE :"db" SET search_path = "$user", public, extensions;
