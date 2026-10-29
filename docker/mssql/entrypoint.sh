#!/bin/bash
# SQL Server runs no init scripts of its own (unlike the MySQL and PostgreSQL images):
# start it, load docker/seed/mssql once with sqlcmd, then stay with the server process.
# TLS uses the test CA's server certificate (V4.3), copied where the server may read it.
set -euo pipefail

SQLCMD=(/opt/mssql-tools18/bin/sqlcmd -C -S 127.0.0.1 -U sa -P "$MSSQL_SA_PASSWORD" -b)

install -d -m 700 /var/opt/mssql/tls
install -m 600 /etc/datanest-tls/server.crt /etc/datanest-tls/server.key /var/opt/mssql/tls/
cat > /var/opt/mssql/mssql.conf <<'CONF'
[network]
tlscert = /var/opt/mssql/tls/server.crt
tlskey = /var/opt/mssql/tls/server.key
tlsprotocols = 1.2
forceencryption = 0
CONF

/opt/mssql/bin/sqlservr &
server=$!

for _ in $(seq 1 180); do
  if "${SQLCMD[@]}" -Q 'SELECT 1' >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if [ ! -f /var/opt/mssql/.datanest-seeded ]; then
  for script in /docker-entrypoint-initdb.d/*.sql; do
    echo "datanest: running $script"
    "${SQLCMD[@]}" -f 65001 -i "$script"
  done
  touch /var/opt/mssql/.datanest-seeded
fi

wait "$server"
