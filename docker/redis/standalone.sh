#!/bin/sh
# One Redis server for the integration tests (V7.1): plain on 6379, TLS with the test CA
# on 6380. The default user has a password, `datanest` may do everything and `reader`
# only read; the seed (docker/seed/redis) is loaded once the server answers.
set -eu

redis-server /datanest/standalone.conf &
server=$!

CLI="redis-cli -p 6379 --user datanest --pass datanest --no-auth-warning"
until $CLI PING >/dev/null 2>&1; do
  sleep 0.2
done
$CLI < /docker-entrypoint-initdb.d/seed.redis >/dev/null
echo 'datanest: seed loaded'

wait "$server"
