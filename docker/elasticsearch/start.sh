#!/bin/bash
# One Elasticsearch node for the integration tests (V7.8): plain HTTP on 9200 with security
# on, the `elastic` user's password `datanest`, and a user `reader` that may only read.
# The seed (docker/seed/elasticsearch) is loaded once the node answers.
set -eu

/usr/local/bin/docker-entrypoint.sh eswrapper &
server=$!

until curl -sf -u elastic:datanest 'http://localhost:9200/_cluster/health?wait_for_status=yellow&timeout=1s' >/dev/null 2>&1; do
  sleep 1
done
/bin/bash /docker-entrypoint-initdb.d/seed.sh
echo 'datanest: seed loaded'

wait "$server"
