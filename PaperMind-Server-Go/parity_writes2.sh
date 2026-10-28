#!/bin/bash
# 剩余写接口对拍（用完可删）
GO=http://localhost:9091; TS=http://localhost:9092
T=$(cat /tmp/parity_token)
URL=$(grep '^COZE_SUPABASE_URL' /e/Code/PaperMind-Coze/.env | cut -d= -f2)
KEY=$(grep '^COZE_SUPABASE_SERVICE_ROLE_KEY' /e/Code/PaperMind-Coze/.env | cut -d= -f2)
PASS=0; FAIL=0

norm() { jq -S 'walk(if type=="object" then del(.id,.created_at,.updated_at,.sessionId,.expires_at) else . end)' 2>/dev/null; }

pair() { # name goResp tsResp（已规范化的字符串）
  if [ "$2" = "$3" ]; then echo "PASS  $1"; PASS=$((PASS+1))
  else echo "FAIL  $1"; diff <(echo "$3") <(echo "$2") | head -6; FAIL=$((FAIL+1)); fi
}

req() { # method url json -> "status|body"
  local m=$1 u=$2 j=$3
  local b c; b=$(mktemp)
  c=$(curl -s -m 30 -o "$b" -w '%{http_code}' -X "$m" "$u" -H "X-Session: $T" -H "Content-Type: application/json" -d "$j")
  echo "$c|$(norm < "$b")"; rm -f "$b"
}

both() { # name method pathTpl(json) —— path 里 __ID__ 占位
  local name=$1 m=$2 pgo=$3 pts=$4 j=$5
  pair "$name" "$(req "$m" "$GO$pgo" "$j")" "$(req "$m" "$TS$pts" "$j")"
}

echo "== 1) papernote-style PUT（登录用户）=="
both pstyle-put PUT "/api/v1/papernote-style" "/api/v1/papernote-style" '{"general_preference":"concise bullets"}'

echo "== 2) papernote-style extract =="
both pstyle-extract POST "/api/v1/papernote-style/extract" "/api/v1/papernote-style/extract" '{"refinementPrompt":"make it terse"}'

echo "== 3) study-note 全生命周期（POST→PUT→DELETE）=="
gid=$(curl -s -m 20 -X POST "$GO/api/v1/study-notes" -H "X-Session: $T" -H "Content-Type: application/json" -d '{"title":"p4note","content":"p4 content","user_id":"11111111-1111-1111-1111-111111111111"}' | jq -r '.data.id')
tid=$(curl -s -m 20 -X POST "$TS/api/v1/study-notes" -H "X-Session: $T" -H "Content-Type: application/json" -d '{"title":"p4note","content":"p4 content","user_id":"11111111-1111-1111-1111-111111111111"}' | jq -r '.data.id')
pair snote-put "$(req PUT "$GO/api/v1/study-notes/$gid" '{"title":"p4note-v2","content":"updated content"}')" \
              "$(req PUT "$TS/api/v1/study-notes/$tid" '{"title":"p4note-v2","content":"updated content"}')"
curl -s -o /dev/null -X DELETE "$GO/api/v1/study-notes/$gid"; curl -s -o /dev/null -X DELETE "$TS/api/v1/study-notes/$tid"

echo "== 4) materials PUT（各自名下资料 26/27）=="
pair mat-put "$(req PUT "$GO/api/v1/materials/26" '{"name":"parity-test.pdf","tags":["p4tag"]}')" \
             "$(req PUT "$TS/api/v1/materials/27" '{"name":"parity-test.pdf","tags":["p4tag"]}')"

echo "== 5) draft-pool PATCH =="
pair draft-patch "$(req PATCH "$GO/api/v1/draft-pool/42" '{"status":"processed"}')" \
                 "$(req PATCH "$TS/api/v1/draft-pool/43" '{"status":"processed"}')"

echo "== 6) chat-sessions 消息 =="
gs=$(curl -s -m 20 -X POST "$GO/api/v1/chat-sessions" -H "X-Session: $T" -H "Content-Type: application/json" -d '{"title":"p4 session"}' | jq -r '.data.session_id // .data.id')
ts_=$(curl -s -m 20 -X POST "$TS/api/v1/chat-sessions" -H "X-Session: $T" -H "Content-Type: application/json" -d '{"title":"p4 session"}' | jq -r '.data.session_id // .data.id')
pair csession-msg "$(req POST "$GO/api/v1/chat-sessions/$gs/messages" '{"role":"user","content":"p4 question"}')" \
                  "$(req POST "$TS/api/v1/chat-sessions/$ts_/messages" '{"role":"user","content":"p4 question"}')"

echo "== 7) forum + posts =="
gf=$(curl -s -m 20 -X POST "$GO/api/v1/forums" -H "X-Session: $T" -H "Content-Type: application/json" -d '{"name":"p4forum","type":"discussion"}' | jq -r '.data.id')
tf=$(curl -s -m 20 -X POST "$TS/api/v1/forums" -H "X-Session: $T" -H "Content-Type: application/json" -d '{"name":"p4forum","type":"discussion"}' | jq -r '.data.id')
pair forum-post "$(req POST "$GO/api/v1/forums/$gf/posts" '{"title":"p4 title","content":"p4 body","author_name":"parity"}')" \
                "$(req POST "$TS/api/v1/forums/$tf/posts" '{"title":"p4 title","content":"p4 body","author_name":"parity"}')"

echo "== 8) mark-viewed =="
pair mark-viewed "$(req POST "$GO/api/v1/control-center/mark-viewed" '{"type":"material","id":26}')" \
                 "$(req POST "$TS/api/v1/control-center/mark-viewed" '{"type":"material","id":27}')"

echo "== 9) psl POST→DELETE =="
pair psl-create "$(req POST "$GO/api/v1/problem-solving-logs" '{"question":"p4 q","answer":"p4 a","user_id":"11111111-1111-1111-1111-111111111111"}')" \
                "$(req POST "$TS/api/v1/problem-solving-logs" '{"question":"p4 q","answer":"p4 a","user_id":"11111111-1111-1111-1111-111111111111"}')"

echo ""
echo "===== 阶段四结果: PASS=$PASS FAIL=$FAIL ====="
