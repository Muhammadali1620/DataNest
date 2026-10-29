#!/bin/bash
# Test data for the Elasticsearch integration tests (V7.8): indices with mappings of every
# common field type, documents, an alias, a hidden index and a read-only user.
set -eu

# es METHOD PATH [curl arguments…]
es() {
  local method=$1 path=$2
  shift 2
  curl -sf -u elastic:datanest -H Content-Type:application/json -X "$method" "http://localhost:9200$path" "$@" >/dev/null
}

es POST '/_security/role/datanest_reader' -d '{
  "indices": [{ "names": ["*"], "privileges": ["read", "view_index_metadata", "monitor"] }],
  "cluster": ["monitor"]
}'
es POST '/_security/user/reader' -d '{ "password": "reader", "roles": ["datanest_reader"] }'

es PUT '/products' -d '{
  "settings": { "number_of_shards": 1, "number_of_replicas": 0 },
  "mappings": {
    "properties": {
      "name": { "type": "text", "fields": { "keyword": { "type": "keyword" } } },
      "sku": { "type": "keyword" },
      "price": { "type": "scaled_float", "scaling_factor": 100 },
      "stock": { "type": "long" },
      "added": { "type": "date" },
      "active": { "type": "boolean" },
      "location": { "type": "geo_point" },
      "maker": { "properties": { "name": { "type": "keyword" }, "country": { "type": "keyword" } } },
      "reviews": { "type": "nested", "properties": { "stars": { "type": "integer" }, "text": { "type": "text" } } }
    }
  }
}'

BULK=""
for i in $(seq 1 30); do
  active=$([ $((i % 3)) -eq 0 ] && echo false || echo true)
  BULK+="{\"index\":{\"_index\":\"products\",\"_id\":\"p$i\"}}"$'\n'
  BULK+="{\"name\":\"Product $i\",\"sku\":\"SKU-$i\",\"price\":$i.25,\"stock\":$((i * 10)),\"added\":\"2026-01-$(printf %02d $(( (i % 28) + 1 )))\",\"active\":$active,\"maker\":{\"name\":\"Maker $((i % 4))\",\"country\":\"DE\"},\"reviews\":[{\"stars\":$((i % 5 + 1)),\"text\":\"ok\"}]}"$'\n'
done
# A 64-bit id that a double would round.
BULK+='{"index":{"_index":"products","_id":"big"}}'$'\n'
BULK+='{"name":"Big number","sku":"SKU-BIG","stock":9007199254740993}'$'\n'
curl -sf -u elastic:datanest -H Content-Type:application/x-ndjson -X POST 'http://localhost:9200/_bulk?refresh=true' --data-binary "$BULK" >/dev/null

es PUT '/logs-2026.10' -d '{
  "settings": { "number_of_shards": 1, "number_of_replicas": 0 },
  "mappings": { "properties": { "at": { "type": "date" }, "level": { "type": "keyword" }, "message": { "type": "text" } } }
}'
es POST '/logs-2026.10/_doc?refresh=true' -d '{ "at": "2026-10-29T12:00:00Z", "level": "error", "message": "disk full" }'
es POST '/_aliases' -d '{ "actions": [{ "add": { "index": "logs-2026.10", "alias": "logs" } }] }'
es PUT '/.datanest-hidden' -d '{ "settings": { "index.hidden": true, "number_of_replicas": 0 } }'
es PUT '/datanest-seed' -d '{ "settings": { "number_of_replicas": 0 } }'
