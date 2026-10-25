-- Applied by hattisar, as the box admin, inside every new project database.
-- :"owner" and :"db" are replaced with escaped identifiers before this runs.
--
-- Nothing here for the pooler: Supavisor runs its auth_query in the box's postgres database, not
-- the one the client asks for, so an owner role authenticates through the pooler with no objects
-- in its project database.
--
-- pg_stat_statements is not here: only a superuser may create it, so hattisar creates it after
-- this file and skips it where the admin is not one.

CREATE SCHEMA IF NOT EXISTS extensions;

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;

ALTER SCHEMA public OWNER TO :"owner";
GRANT USAGE ON SCHEMA extensions TO :"owner";

ALTER DATABASE :"db" SET search_path = "$user", public, extensions;
