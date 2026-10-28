#!/bin/sh
# A role that logs in with a client certificate (CN=datanest_cert) only, over TLS (V4.3).
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
CREATE ROLE datanest_cert LOGIN;
GRANT CONNECT ON DATABASE datanest_test TO datanest_cert;
SQL
# First matching line wins, so the certificate rule goes before the image's defaults.
sed -i '1i hostssl all datanest_cert all cert' "$PGDATA/pg_hba.conf"
