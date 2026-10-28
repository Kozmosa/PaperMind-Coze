#!/bin/bash
# 重管理操作对拍（用完可删）：用法 parity_admin.sh <base_url> <phase: run|snapshot>
B="$1"; PHASE="$2"
T=$(cat /tmp/parity_token)
H1="X-Session: $T"
H2="Content-Type: application/json"
URL=$(grep '^COZE_SUPABASE_URL' /e/Code/PaperMind-Coze/.env | cut -d= -f2)
KEY=$(grep '^COZE_SUPABASE_SERVICE_ROLE_KEY' /e/Code/PaperMind-Coze/.env | cut -d= -f2)

if [ "$PHASE" = "run" ]; then
  post() { echo "-- $1"; curl -s -m 120 -X POST "$B$1" -H "$H1" -H "$H2" -d "${2:-{}}" | head -c 200; echo; }
  post "/api/v1/knowledge-builder/trigger"
  post "/api/v1/knowledge-builder/rebuild-all"
  # 等 rebuild 完成
  for i in $(seq 1 20); do
    n=$(curl -s -m 15 "$URL/rest/v1/materials?select=id&user_id=eq.e10d84f9-1b14-4089-b997-7989fb238511&process_status=eq.processing" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" | jq length)
    [ "$n" = "0" ] && break; sleep 5
  done
  post "/api/v1/knowledge-builder/process-materials"
  post "/api/v1/knowledge-builder/process-study-notes"
  post "/api/v1/knowledge-builder/consolidate-tags"
  post "/api/v1/knowledge-builder/migrate-add-conflict-column"
  echo "admin battery done: $B"
elif [ "$PHASE" = "snapshot" ]; then
  TU="e10d84f9-1b14-4089-b997-7989fb238511"
  echo "nodes: $(curl -s -m 15 "$URL/rest/v1/knowledge_nodes?select=id" -G --data-urlencode "user_id=eq.$TU" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" | jq length)"
  echo "materials processed: $(curl -s -m 15 "$URL/rest/v1/materials?select=id" -G --data-urlencode "user_id=eq.$TU" --data-urlencode "process_status=eq.processed" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" | jq length)"
  echo "materials failed: $(curl -s -m 15 "$URL/rest/v1/materials?select=id" -G --data-urlencode "user_id=eq.$TU" --data-urlencode "process_status=eq.failed" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" | jq length)"
  echo "materials with papercore: $(curl -s -m 15 "$URL/rest/v1/materials?select=id" -G --data-urlencode "user_id=eq.$TU" --data-urlencode "papercore=not.is.null" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" | jq length)"
  echo "materials papercore非OK采样: $(curl -s -m 15 "$URL/rest/v1/materials?select=papercore" -G --data-urlencode "user_id=eq.$TU" --data-urlencode "papercore=neq.OK" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" | jq length)"
fi
