import http from "node:http";
import { writeFileSync } from "node:fs";

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.method === "GET" && req.url === "/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [
        { id: "qwen38-27b", status: { value: "loaded" }, meta: { n_ctx: 131072 } },
      ]}));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      writeFileSync("/tmp/pi-agent-test/payload.json", body);
      res.setHeader("content-type", "text/event-stream");
      const timings = (prompt_n, prompt_ms, predicted_n = 0) => ({
        cache_n: 0,
        prompt_n,
        prompt_ms,
        prompt_per_second: prompt_ms > 0 ? prompt_n / (prompt_ms / 1000) : 0,
        predicted_n,
        predicted_ms: predicted_n > 0 ? 100 : 0,
        predicted_per_second: predicted_n > 0 ? 10 : 0,
        draft_n: 0,
        draft_n_accepted: 0,
      });
      const chunk = (delta, finish, t) =>
        `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "qwen38-27b", timings: t, choices: [{ index: 0, delta, finish_reason: finish ?? null }] })}\n\n`;
      const progress = (processed, total, time_ms) =>
        `data: ${JSON.stringify({ prompt_progress: { processed, total, time_ms, cache: 0 }, timings: timings(processed, time_ms) })}\n\n`;
      res.end(
        progress(2048, 4096, 100) +
          progress(4096, 4096, 250) +
          chunk({ content: "OK" }, null, timings(4096, 250, 1)) +
          chunk({}, "stop", timings(4096, 250, 1)) +
          "data: [DONE]\n\n",
      );
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
});
server.listen(18923, "127.0.0.1", () => console.log("mock llama router on 18923"));
