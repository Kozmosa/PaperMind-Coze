#!/bin/bash
# GET 接口对拍：同请求双发 TS/Go，状态码+规范化响应体逐字节 diff（用完可删）
GO=http://localhost:9091
TS=http://localhost:9092
D=/tmp/parity; rm -rf "$D"; mkdir -p "$D"
PASS=0; FAIL=0; SKIP=0

fetch() { # $1=url $2=outprefix
  local body; body=$(mktemp)
  local code; code=$(curl -s -m 30 -o "$body" -w '%{http_code}' "$1")
  echo "$code" > "$2.code"
  if head -c 1 "$body" | grep -q '[{[]'; then
    sed 's/:9091/:PORT/g; s/:9092/:PORT/g' "$body" | jq -S . > "$2" 2>/dev/null || cp "$body" "$2"
  else
    sed 's/:9091/:PORT/g; s/:9092/:PORT/g' "$body" > "$2"
  fi
  rm -f "$body"
}

run() { # $1=name $2=path
  fetch "$GO$2" "$D/$1.go"
  fetch "$TS$2" "$D/$1.ts"
  if diff -q "$D/$1.go.code" "$D/$1.ts.code" >/dev/null && diff -q "$D/$1.go" "$D/$1.ts" >/dev/null; then
    echo "PASS  $name  [$(cat "$D/$1.go.code")]"
    PASS=$((PASS+1))
  else
    echo "FAIL  $name  go=$(cat "$D/$1.go.code") ts=$(cat "$D/$1.ts.code")"
    diff "$D/$1.ts" "$D/$1.go" | head -10
    echo "----"
    FAIL=$((FAIL+1))
  fi
}

skip() { echo "SKIP  $1  ($2)"; SKIP=$((SKIP+1)); }

# ── 动态 ID（同一 DB，取一次两边共用）──
MID=$(curl -s -m 20 "$GO/api/v1/materials" | jq -r '.data[0].id // empty')
DID=$(curl -s -m 20 "$GO/api/v1/draft-pool" | jq -r '.data[0].id // empty')
NID=$(curl -s -m 20 "$GO/api/v1/knowledge-nodes" | jq -r '.data[0].id // empty')
FID=$(curl -s -m 20 "$GO/api/v1/forums" | jq -r '.data[0].id // .data[0].forum_id // .data[0].forumId // empty')
SID=$(curl -s -m 20 "$GO/api/v1/study-notes" | jq -r '.data[0].id // empty')
RID=$(curl -s -m 20 "$GO/api/v1/reflections" | jq -r '.data[0].id // empty')
CSID=$(curl -s -m 20 "$GO/api/v1/chat-sessions" | jq -r '.data[0].id // .data[0].session_id // .data[0].sessionId // empty')
TAG=$(curl -s -m 20 "$GO/api/v1/materials" | jq -r '.data[0].tags[0] // empty')
TAGQ=$(printf '%s' "$TAG" | jq -rR @uri)

run health       "/api/v1/health"
run config       "/api/v1/config"
run materials    "/api/v1/materials"
run kb-graph     "/api/v1/knowledge-builder/graph-data"
run knodes       "/api/v1/knowledge-nodes"
run draft-pool   "/api/v1/draft-pool"
run stickynotes  "/api/v1/stickynotes"
run forums       "/api/v1/forums"
run pstyle       "/api/v1/papernote-style"
run snote-list   "/api/v1/study-notes"
run refl-list    "/api/v1/reflections"
run plogs        "/api/v1/problem-logs"
run psl-list     "/api/v1/problem-solving-logs"
run psl-stats    "/api/v1/problem-solving-logs/stats"
run cc-recent    "/api/v1/control-center/recent-records"
run csessions    "/api/v1/chat-sessions"

[ -n "$MID" ]  && run mat-filecontent "/api/v1/materials/$MID/file-content"  || skip mat-filecontent "无 material id"
[ -n "$DID" ]  && run file-contents   "/api/v1/file-contents/$DID"           || skip file-contents "无 draft id"
[ -n "$NID" ]  && run knode-get       "/api/v1/knowledge-nodes/$NID"         || skip knode-get "无 node id"
[ -n "$FID" ]  && run forum-posts     "/api/v1/forums/$FID/posts"            || skip forum-posts "无 forum id"
[ -n "$SID" ]  && run snote-get       "/api/v1/study-notes/$SID"             || skip snote-get "无 note id"
[ -n "$RID" ]  && run refl-get        "/api/v1/reflections/$RID"             || skip refl-get "无 reflection id"
[ -n "$CSID" ] && run csession-msgs   "/api/v1/chat-sessions/$CSID/messages" || skip csession-msgs "无 session id"
[ -n "$TAGQ" ] && run kb-tagdocs      "/api/v1/knowledge-builder/tag-documents?tag=$TAGQ" || skip kb-tagdocs "无 tag"

echo ""
echo "===== GET 对拍结果: PASS=$PASS FAIL=$FAIL SKIP=$SKIP ====="
