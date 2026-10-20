-- NOTE: change to your own passwords for production environments
\set pgpass `echo "$POSTGRES_PASSWORD"`

ALTER USER pgbouncer WITH PASSWORD :'pgpass';
