#!/bin/sh
# A Redis Cluster of three masters in one container (V7.1). Every node announces
# 127.0.0.1 and listens on the same port as on the host, so the slot map the cluster
# hands out leads the tests straight to each node; the cluster bus stays inside.
set -eu

PORTS='7391 7392 7393'
for port in $PORTS; do
  redis-server --port "$port" --cluster-enabled yes \
    --cluster-config-file "/tmp/nodes-$port.conf" --cluster-announce-ip 127.0.0.1 \
    --requirepass datanest --masterauth datanest --save '' --appendonly no &
done

CLI='redis-cli -a datanest --no-auth-warning'
for port in $PORTS; do
  until $CLI -p "$port" PING >/dev/null 2>&1; do
    sleep 0.2
  done
done

$CLI --cluster create 127.0.0.1:7391 127.0.0.1:7392 127.0.0.1:7393 --cluster-yes >/dev/null
until $CLI -p 7391 CLUSTER INFO | grep -q 'cluster_state:ok'; do
  sleep 0.2
done
# The keys land on all three masters: their slots spread across the ranges.
for name in alpha bravo charlie delta echo foxtrot golf hotel india juliet; do
  $CLI -c -p 7391 SET "cluster:$name" "$name" >/dev/null
done
$CLI -c -p 7391 SET cluster:seed done >/dev/null
echo 'datanest: cluster ready'

wait
