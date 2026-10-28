#!/bin/bash
# AI 端点弹药库：按固定顺序打全部 AI 端点（配录音网关做 prompt 对拍，用完可删）
# 用法: parity_battery.sh <base_url>
B="$1"
T=$(cat /tmp/parity_token)
H1="X-Session: $T"
H2="Content-Type: application/json"

p() { # path payload (SSE 端点也走这里，读完即止)
  curl -s -N --max-time 25 -o /dev/null -X POST "$B$1" -H "$H1" -H "$H2" -d "$2"
}

p "/api/v1/ai/chat" '{"agent":"assistant","message":"PM1 what is parity"}'
p "/api/v1/ai/chat" '{"agent":"knowledge_builder","message":"PM2 build knowledge"}'
p "/api/v1/ai/chat" '{"agent":"note_helper","message":"PM3 help note","context":{"nodeId":1}}'
p "/api/v1/ai/chat" '{"agent":"tutor","message":"PM4 tutor me"}'
p "/api/v1/ai/chat" '{"agent":"reflection_mind","message":"PM5 reflect"}'
p "/api/v1/ai/tutor" '{"message":"PM6 tutor direct"}'
p "/api/v1/ai/suggest" '{"field":"title","current_content":"Fourier draft text","draft_ids":[39]}'
p "/api/v1/ai/suggest-relations" '{"papercore":"Fourier transform decomposes signals into frequencies","tags":["Math"]}'
p "/api/v1/ai/generate-reflection" '{"period":"weekly"}'
p "/api/v1/ai/note-helper" '{"nodeId":1,"papercore":"probe content about transforms","tags":["Math"],"relations":{}}'
p "/api/v1/ai/generate-note" '{"sourceIds":[39]}'
p "/api/v1/ai/refine-note" '{"currentNote":"note body v1","refinementPrompt":"make it shorter","sourceIds":[39]}'
p "/api/v1/problem-solving-logs/summarize" '{"chat_session_id":"parity-session-1","messages":[{"role":"user","content":"what is fourier"},{"role":"assistant","content":"a transform"}]}'

echo "battery done: $B"
