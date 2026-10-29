#!/bin/bash
# YugabyteDB for the compat group (V6.5): starts the single-node cluster, then loads
# docker/seed/yugabyte into a new datanest_test database, as the image cannot by itself.
set -euo pipefail

/home/yugabyte/bin/yugabyted start --background=false --ui=false \
  --base_dir=/home/yugabyte/var --tserver_flags="ysql_max_connections=100" &
server=$!

until /home/yugabyte/bin/ysqlsh -h "$(hostname)" -U yugabyte -d yugabyte -c 'SELECT 1' >/dev/null 2>&1; do
  if ! kill -0 "$server" 2>/dev/null; then
    echo 'yugabyted stopped before it was ready' >&2
    exit 1
  fi
  sleep 1
done

/home/yugabyte/bin/ysqlsh -h "$(hostname)" -U yugabyte -d yugabyte -v ON_ERROR_STOP=1 \
  -c 'CREATE DATABASE datanest_test'
for file in /docker-entrypoint-initdb.d/*.sql; do
  /home/yugabyte/bin/ysqlsh -h "$(hostname)" -U yugabyte -d datanest_test -v ON_ERROR_STOP=1 -f "$file"
done
echo 'seed loaded'
wait "$server"
