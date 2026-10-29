#!/bin/sh
# A master and a Sentinel that watches it, in one container (V7.1), so the address the
# Sentinel hands out (127.0.0.1:7381) is the one the tests reach through the port on the
# host. The Sentinel has a password of its own.
set -eu

redis-server --port 7381 --requirepass datanest --masterauth datanest \
  --save '' --appendonly no &
server=$!

until redis-cli -p 7381 -a datanest --no-auth-warning PING >/dev/null 2>&1; do
  sleep 0.2
done
redis-cli -p 7381 -a datanest --no-auth-warning SET sentinel:seed master >/dev/null

# Sentinel rewrites its configuration, so it gets a writable copy.
cat > /tmp/sentinel.conf <<'CONF'
port 7382
sentinel announce-ip 127.0.0.1
sentinel monitor datanest 127.0.0.1 7381 1
sentinel auth-pass datanest datanest
requirepass sentinel
CONF
redis-sentinel /tmp/sentinel.conf &

wait "$server"
