#!/bin/sh
# One MongoDB server for the integration tests (V7.5): a single-member replica set `rs0`
# on 7017, the same port inside and outside, because the set hands out its members'
# addresses. TLS with the test CA is accepted next to plain connections on that port
# (preferTLS). Users: `datanest` (root), `reader` (read only) and the client certificate
# for X.509. Members talk to each other without a client certificate: the test one is
# issued for servers only. The seed (docker/seed/mongodb) is loaded once the set has a primary.
set -eu

RUN=/tmp/datanest
mkdir -p "$RUN" /data/db
cat /etc/datanest-tls/server.crt /etc/datanest-tls/server.key > "$RUN/server.pem"
# Members of a set with authentication prove themselves to each other with a key file.
head -c 48 /dev/urandom | base64 | tr -d '\n' > "$RUN/keyfile"
chmod 400 "$RUN/keyfile"

mongod --replSet rs0 --port 7017 --bind_ip_all --dbpath /data/db \
  --keyFile "$RUN/keyfile" \
  --tlsMode preferTLS --tlsCertificateKeyFile "$RUN/server.pem" \
  --tlsCAFile /etc/datanest-tls/ca.crt --tlsAllowConnectionsWithoutCertificates \
  --setParameter tlsWithholdClientCertificate=true \
  --wiredTigerCacheSizeGB 0.25 --quiet &
server=$!

SHELL_LOCAL="mongosh --port 7017 --quiet"
until $SHELL_LOCAL --eval 'db.adminCommand({ ping: 1 })' >/dev/null 2>&1; do
  sleep 0.3
done
# Before the first user exists, the localhost exception allows setting up the set and it.
$SHELL_LOCAL --eval "rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: 'localhost:7017' }] })" >/dev/null
until $SHELL_LOCAL --eval 'quit(db.hello().isWritablePrimary ? 0 : 1)' >/dev/null 2>&1; do
  sleep 0.3
done
$SHELL_LOCAL --eval "db.getSiblingDB('admin').createUser({ user: 'datanest', pwd: 'datanest', roles: ['root'] })" >/dev/null

SHELL_ROOT="mongosh --port 7017 --quiet -u datanest -p datanest --authenticationDatabase admin"
$SHELL_ROOT /docker-entrypoint-initdb.d/seed.js
echo 'datanest: seed loaded'

wait "$server"
