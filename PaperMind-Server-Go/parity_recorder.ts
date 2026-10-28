// 录音网关：截获 /v1/messages 请求体落盘，返回罐头响应（用完可删）
// 用法: bun parity_recorder.ts <outdir>
const OUT = process.argv[2] || "/tmp/promptdump";
await Bun.write(OUT + "/.start", String(Date.now()));
let seq = 0;

Bun.serve({
  port: 9099,
  async fetch(req) {
    if (new URL(req.url).pathname !== "/v1/messages") {
      return new Response("not found", { status: 404 });
    }
    const body = await req.json();
    seq++;
    await Bun.write(
      `${OUT}/${String(seq).padStart(2, "0")}.json`,
      JSON.stringify(body, null, 1),
    );
    if (body.stream) {
      const sse = [
        'event: message_start\ndata: {"type":"message_start"}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start"}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"OK"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop"}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ].join("");
      return new Response(sse, {
        headers: { "Content-Type": "text/event-stream; charset=utf-8" },
      });
    }
    return Response.json({
      id: "rec_1",
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{ type: "text", text: "OK" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  },
});
console.log("parity recorder listening :9099 ->", OUT);
