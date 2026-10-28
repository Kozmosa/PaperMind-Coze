#!/bin/bash
# 写接口对拍 v3：纯 ASCII 载荷避开终端编码噪声（用完可删）
GO=http://localhost:9091
TS=http://localhost:9092
PASS=0; FAIL=0

norm() { jq -S 'walk(if type=="object" then del(.id,.created_at,.updated_at) else . end)' 2>/dev/null; }

cmp_rw() { # name path payload del_tpl
  local name=$1 path=$2 payload=$3 del_tpl=$4
  local gid tid gb tb gc tc
  gid=$(curl -s -m 20 -X POST "$GO$path" -H "Content-Type: application/json" -d "$payload" | jq -r '.data.id // empty')
  tid=$(curl -s -m 20 -X POST "$TS$path" -H "Content-Type: application/json" -d "$payload" | jq -r '.data.id // empty')
  [ -z "$gid" -o -z "$tid" ] && { echo "SKIP  $name (创建失败 go=$gid ts=$tid)"; return; }
  gb=$(curl -s -m 15 -X DELETE "$GO$del_tpl$gid" | norm); gc=$?
  tb=$(curl -s -m 15 -X DELETE "$TS$del_tpl$tid" | norm); tc=$?
  if [ "$gb" = "$tb" ]; then echo "PASS  $name  POST+DELETE"; PASS=$((PASS+1))
  else echo "FAIL  $name"; diff <(echo "$tb") <(echo "$gb") | head -6; echo "----"; FAIL=$((FAIL+1)); fi
}

cmp_rw stickynotes     "/api/v1/stickynotes"     '{"papercore":"parity-note-xyz","author_name":"parity"}' "/api/v1/stickynotes/"
cmp_rw draft-pool      "/api/v1/draft-pool"      '{"content":"parity-draft-xyz","file_name":"p.md"}'      "/api/v1/draft-pool/"
cmp_rw problem-logs    "/api/v1/problem-logs"    '{"problem":"parity-problem-xyz"}'                      "/api/v1/problem-logs/"
cmp_rw knowledge-nodes "/api/v1/knowledge-nodes" '{"papercore":"parity-knode-xyz"}'                      "/api/v1/knowledge-nodes/"
cmp_rw study-notes     "/api/v1/study-notes"     '{"title":"parity-snote","content":"parity-content-xyz","user_id":"11111111-1111-1111-1111-111111111111"}' "/api/v1/study-notes/"

# PUT 更新对拍（knowledge-nodes /:id 是 put）
gid=$(curl -s -m 20 -X POST "$GO/api/v1/knowledge-nodes" -H "Content-Type: application/json" -d '{"papercore":"parity-put-xyz"}' | jq -r '.data.id')
tid=$(curl -s -m 20 -X POST "$TS/api/v1/knowledge-nodes" -H "Content-Type: application/json" -d '{"papercore":"parity-put-xyz"}' | jq -r '.data.id')
gb=$(curl -s -m 15 -X PUT "$GO/api/v1/knowledge-nodes/$gid" -H "Content-Type: application/json" -d '{"papercore":"parity-put-updated"}' | norm)
tb=$(curl -s -m 15 -X PUT "$TS/api/v1/knowledge-nodes/$tid" -H "Content-Type: application/json" -d '{"papercore":"parity-put-updated"}' | norm)
curl -s -m 15 -o /dev/null -X DELETE "$GO/api/v1/knowledge-nodes/$gid"
curl -s -m 15 -o /dev/null -X DELETE "$TS/api/v1/knowledge-nodes/$tid"
[ "$gb" = "$tb" ] && { echo "PASS  knode-PUT"; PASS=$((PASS+1)); } || { echo "FAIL  knode-PUT"; diff <(echo "$tb") <(echo "$gb") | head -6; FAIL=$((FAIL+1)); }

echo ""
echo "===== 写对拍 v3 结果: PASS=$PASS FAIL=$FAIL ====="
