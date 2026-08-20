import { beforeEach, describe, expect, it, vi } from "vitest";
import { StatsManager } from "../src/managers/stats";

/** Builds a mock extension context with a UI. */
const makeCtx = () => {
  const setWidget = vi.fn();
  return {
    ctx: { ui: { setWidget }, hasUI: true } as any,
    setWidget,
  };
};

/** Builds an SSE response body from raw chunk strings. */
const sseBody = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });

const SSE_CHUNKS = [
  'data: {"prompt_progress":{"total":100,"processed":40,"time_ms":200}}\n\n',
  'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
  'data: [DONE]\n\n',
];

const makeAssistantUpdate = (
  deltaType: string,
  provider = "llama.cpp",
) =>
  ({
    type: "message_update",
    message: { role: "assistant", provider },
    assistantMessageEvent: { type: deltaType, delta: "x" },
  }) as any;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("StatsManager.tapFetch", () => {
  it("passes the body through unchanged and extracts prompt_progress", async () => {
    const stats = new StatsManager();
    const { ctx, setWidget } = makeCtx();
    stats.attachUi(ctx);

    const base = vi.fn(
      async () => new Response(sseBody(SSE_CHUNKS), { status: 200 }),
    );
    const tapped = stats.tapFetch(base as any);

    const response = await tapped("http://x/v1/chat/completions", {});
    const text = await response.text();

    expect(text).toBe(SSE_CHUNKS.join("")); // byte-identical pass-through
    expect(setWidget).toHaveBeenCalledWith(
      "llama-stats",
      [expect.stringContaining("40%")],
    );
  });

  it("passes non-ok responses through untouched", async () => {
    const stats = new StatsManager();
    const { ctx, setWidget } = makeCtx();
    stats.attachUi(ctx);

    const original = new Response("boom", { status: 500 });
    const base = vi.fn(async () => original);
    const tapped = stats.tapFetch(base as any);

    const response = await tapped("http://x/v1/chat/completions", {});
    expect(response).toBe(original);
    expect(setWidget).not.toHaveBeenCalled();
  });

  it("tracks token deltas from raw chunks and finalizes when the body ends", async () => {
    const stats = new StatsManager();
    const { ctx, setWidget } = makeCtx();
    stats.attachUi(ctx);

    const base = vi.fn(
      async () =>
        new Response(
          sseBody([
            'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
            "data: not-json\n\n",
            'data: {"prompt_progress":{"total":10,"processed":5}}\n\n',
          ]),
          { status: 200 },
        ),
    );
    const tapped = stats.tapFetch(base as any);

    await (await tapped("http://x", {})).text();

    // beginStream clears; the delta chunk drives the decode line, the
    // progress chunk adds the bar, and stream end finalizes (no
    // message_end exists for non-agent-loop requests)
    const contents = setWidget.mock.calls
      .map((call) => call[1])
      .filter((content): content is string[] => content !== undefined);
    expect(contents).toHaveLength(3);
    expect(contents[0][0]).toBe("✨ 1 tokens"); // decode from raw delta
    expect(contents[1][0]).toContain("50%"); // progress bar appears
    expect(contents[1][0]).toContain("✨ 1 tokens"); // decode line persists
    expect(contents[2][0]).toContain("📖 5"); // final prefill from progress
    expect(contents[2][0]).toContain("✨ 1 @"); // final decode from delta count
  });

  it("supports cancellation of the tapped stream", async () => {
    const stats = new StatsManager();
    let cancelInner: (reason?: unknown) => void = () => undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"a":1}\n\n'));
        // Stay open until cancelled
        cancelInner = () => controller.error("cancelled");
      },
      cancel() {
        cancelInner();
      },
    });

    const base = vi.fn(async () => new Response(body, { status: 200 }));
    const response = await stats.tapFetch(base as any)("http://x", {});

    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel(); // must not throw or hang

    expect(true).toBe(true);
  });
});

describe("StatsManager prefill display", () => {
  it("shows a progress bar with speed and ETA while prefilling", () => {
    const stats = new StatsManager();
    const { ctx, setWidget } = makeCtx();
    stats.attachUi(ctx);

    stats.beginStream();
    stats.onChunk({ progress: { total: 1000, processed: 250, time_ms: 1000 } });

    expect(setWidget).toHaveBeenCalledWith(
      "llama-stats",
      [
        expect.stringMatching(/📖 .*█+░*.*25%/),
      ],
    );
    const msg = setWidget.mock.calls.at(-1)![1][0] as string;
    expect(msg).toContain("250.0 tok/s");
    expect(msg).toContain("~3s left");
  });

  it("excludes cached tokens from the progress percentage", () => {
    const stats = new StatsManager();
    const { ctx, setWidget } = makeCtx();
    stats.attachUi(ctx);

    stats.beginStream();
    // 900 of 1000 are cache: real progress is 100/100 = 100% → done branch
    stats.onChunk({
      progress: { total: 1000, processed: 1000, time_ms: 500, cache: 900 },
    });

    const msg = setWidget.mock.calls.at(-1)![1][0] as string;
    expect(msg).toContain("1000 tokens");
  });
});

describe("StatsManager decode display", () => {
  it("counts token deltas and shows rolling speed", () => {
    const stats = new StatsManager();
    const { ctx, setWidget } = makeCtx();
    stats.attachUi(ctx);

    const now = vi.spyOn(Date, "now");
    let t = 1_000_000;
    now.mockImplementation(() => (t += 50)); // 20 tok/s

    stats.beginStream();
    for (let i = 0; i < 5; i++) {
      stats.onMessageUpdate(makeAssistantUpdate("text_delta"));
    }

    const msg = setWidget.mock.calls.at(-1)![1][0] as string;
    expect(msg).toContain("5 tokens");
    expect(msg).toContain("20.0 tok/s");
    now.mockRestore();
  });

  it("uses the tool icon for tool call deltas", () => {
    const stats = new StatsManager();
    const { ctx, setWidget } = makeCtx();
    stats.attachUi(ctx);

    stats.beginStream();
    stats.onMessageUpdate(makeAssistantUpdate("toolcall_delta"));

    const msg = setWidget.mock.calls.at(-1)![1][0] as string;
    expect(msg).toContain("🔧");
  });

  it("ignores non-delta events and other providers", () => {
    const stats = new StatsManager();
    const { ctx, setWidget } = makeCtx();
    stats.attachUi(ctx);

    stats.beginStream();
    stats.onMessageUpdate(makeAssistantUpdate("text_start"));
    stats.onMessageUpdate(makeAssistantUpdate("text_delta", "openai"));

    expect(setWidget).toHaveBeenCalledTimes(1); // only beginStream's clear
  });
});

describe("StatsManager final stats", () => {
  it("finalizes on message end using the server-reported token count", () => {
    const stats = new StatsManager();
    const { ctx, setWidget } = makeCtx();
    stats.attachUi(ctx);

    const now = vi.spyOn(Date, "now");
    let t = 1_000_000;
    now.mockImplementation(() => (t += 10));

    stats.beginStream();
    stats.onChunk({ progress: { total: 800, processed: 800, time_ms: 400 } });
    for (let i = 0; i < 3; i++) {
      stats.onMessageUpdate(makeAssistantUpdate("text_delta"));
    }

    stats.onMessageEnd({
      type: "message_end",
      message: {
        role: "assistant",
        provider: "llama.cpp",
        usage: { input: 100, output: 42, cacheRead: 0, cacheWrite: 0 },
      },
    } as any);

    const msg = setWidget.mock.calls.at(-1)![1][0] as string;
    expect(msg).toContain("📖 800 @ 2000.0 tok/s"); // prefill final
    expect(msg).toContain("✨ 42 @"); // usage.output, not the delta count
    now.mockRestore();
  });

  it("falls back to the delta count when usage is absent", () => {
    const stats = new StatsManager();
    const { ctx, setWidget } = makeCtx();
    stats.attachUi(ctx);

    stats.beginStream();
    for (let i = 0; i < 3; i++) {
      stats.onMessageUpdate(makeAssistantUpdate("text_delta"));
    }

    stats.onMessageEnd({
      type: "message_end",
      message: {
        role: "assistant",
        provider: "llama.cpp",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    } as any);

    const msg = setWidget.mock.calls.at(-1)![1][0] as string;
    expect(msg).toContain("✨ 3 @");
  });

  it("ignores message end for other providers", () => {
    const stats = new StatsManager();
    const { ctx, setWidget } = makeCtx();
    stats.attachUi(ctx);

    stats.beginStream();
    stats.onMessageEnd({
      type: "message_end",
      message: { role: "assistant", provider: "openai" },
    } as any);

    // Only the beginStream clear — no final stats rendered
    expect(setWidget).toHaveBeenCalledTimes(1);
  });
});

describe("StatsManager server timings", () => {
  it("prefers server-reported token count and speed over delta timing", () => {
    const stats = new StatsManager();
    const { ctx, setWidget } = makeCtx();
    stats.attachUi(ctx);

    stats.beginStream();
    stats.onChunk({
      timings: { predicted_n: 422, predicted_per_second: 27.5 },
    });
    for (let i = 0; i < 3; i++) {
      stats.onMessageUpdate(makeAssistantUpdate("text_delta"));
    }

    const msg = setWidget.mock.calls.at(-1)![1][0] as string;
    expect(msg).toContain("422 tokens"); // not the delta count (3)
    expect(msg).toContain("27.5 tok/s"); // server speed, not rolling
  });

  it("shows a timings-based prefill counter when prompt_progress is absent", () => {
    const stats = new StatsManager();
    const { ctx, setWidget } = makeCtx();
    stats.attachUi(ctx);

    stats.beginStream();
    stats.onChunk({ timings: { prompt_n: 4097, cache_n: 390 } });

    const msg = setWidget.mock.calls.at(-1)![1][0] as string;
    expect(msg).toContain("📖 4487 tokens prefill");
  });

  it("builds the final line from timings when usage is absent, with draft acceptance", () => {
    const stats = new StatsManager();
    const { ctx, setWidget } = makeCtx();
    stats.attachUi(ctx);

    stats.beginStream();
    stats.onChunk({
      timings: {
        prompt_n: 19,
        cache_n: 27572,
        prompt_ms: 652.7,
        predicted_n: 422,
        predicted_ms: 15000,
        predicted_per_second: 28.1,
        draft_n: 336,
        draft_n_accepted: 255,
      },
    });
    stats.onMessageUpdate(makeAssistantUpdate("text_delta"));

    stats.onMessageEnd({
      type: "message_end",
      message: {
        role: "assistant",
        provider: "llama.cpp",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    } as any);

    const msg = setWidget.mock.calls.at(-1)![1][0] as string;
    expect(msg).toContain("📖 27591 (27572 cached) @ 29.1 tok/s");
    expect(msg).toContain("✨ 422 @ 28.1 tok/s · spec 76%");
  });

  it("extracts both prompt_progress and timings from tapped chunks", async () => {
    const stats = new StatsManager();
    const { ctx, setWidget } = makeCtx();
    stats.attachUi(ctx);

    // Deferred body so the message update arrives while the stream is open
    let push: (chunk: string) => void = () => undefined;
    let finish: () => void = () => undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        push = (chunk) => controller.enqueue(encoder.encode(chunk));
        finish = () => controller.close();
      },
    });

    const base = vi.fn(async () => new Response(body, { status: 200 }));
    const response = await stats.tapFetch(base as any)("http://x", {});
    const reader = response.body!.getReader();

    push(
      'data: {"prompt_progress":{"total":100,"processed":50,"time_ms":100},"timings":{"predicted_n":7,"predicted_per_second":3.5}}\n\n',
    );
    await reader.read(); // let the tap process the chunk

    // Timings are captured by the tap; the decode line appears on update
    stats.onMessageUpdate(makeAssistantUpdate("text_delta"));
    const msg = setWidget.mock.calls.at(-1)![1][0] as string;
    expect(msg).toContain("50%");
    expect(msg).toContain("7 tokens");
    expect(msg).toContain("3.5 tok/s");

    push("data: [DONE]\n\n");
    finish();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
  });
});

describe("StatsManager compaction coverage", () => {
  // Compaction and branch summarization bypass the agent loop: no
  // before_provider_request, no message_update, no message_end. Everything
  // must work from the fetch tap alone.

  it("injects return_progress into the request body and drops content-length", async () => {
    const stats = new StatsManager();
    const { ctx } = makeCtx();
    stats.attachUi(ctx);

    const base = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(sseBody(["data: [DONE]\n\n"]), { status: 200 }),
    );
    const tapped = stats.tapFetch(base as any);
    await (
      await tapped("http://x/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "m", messages: [] }),
        headers: new Headers({
          "content-type": "application/json",
          "content-length": "123",
        }),
      })
    ).text();

    expect(base).toHaveBeenCalledTimes(1);
    const init = base.mock.calls[0][1] as RequestInit;
    const sent = JSON.parse(init.body as string);
    expect(sent.return_progress).toBe(true);
    expect((init.headers as Headers).has("content-length")).toBe(false);
    expect((init.headers as Headers).get("content-type")).toBe(
      "application/json",
    );
  });

  it("passes non-JSON and already-injected bodies through untouched", async () => {
    const stats = new StatsManager();
    const { ctx } = makeCtx();
    stats.attachUi(ctx);

    const base = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(sseBody(["data: [DONE]\n\n"]), { status: 200 }),
    );
    const tapped = stats.tapFetch(base as any);

    const plainBody = "not-json-at-all";
    await (await tapped("http://x", { body: plainBody })).text();
    expect(base.mock.calls[0][1]).toEqual({ body: plainBody });

    // before_provider_request already injected it: no re-serialization
    const injected = JSON.stringify({ model: "m", return_progress: true });
    await (await tapped("http://x", { body: injected })).text();
    expect(base.mock.calls[1][1]).toEqual({ body: injected });
  });

  it("shows prefill, decode speed and final stats for a compaction-style stream with no agent events", async () => {
    const stats = new StatsManager();
    const { ctx, setWidget } = makeCtx();
    stats.attachUi(ctx);

    const base = vi.fn(
      async () =>
        new Response(
          sseBody([
            'data: {"prompt_progress":{"total":4096,"processed":2048,"time_ms":100}}\n\n',
            'data: {"prompt_progress":{"total":4096,"processed":4096,"time_ms":200}}\n\n',
            'data: {"choices":[{"delta":{"content":"A"}}],"timings":{"predicted_n":1,"predicted_per_second":20}}\n\n',
            'data: {"choices":[{"delta":{"content":"B"}}],"timings":{"predicted_n":2,"predicted_per_second":20,"predicted_ms":100}}\n\n',
            'data: {"usage":{"prompt_tokens":4096,"completion_tokens":2}}\n\n',
            "data: [DONE]\n\n",
          ]),
          { status: 200 },
        ),
    );

    await (await stats.tapFetch(base as any)("http://x", {})).text();

    const contents = setWidget.mock.calls
      .map((call) => call[1])
      .filter((content): content is string[] => content !== undefined);
    // Prefill progress bar while the summary prompt is processed
    expect(contents.some((c) => c[0].includes("50%"))).toBe(true);
    // Live decode speed from raw chunks (no message_update at all)
    expect(
      contents.some(
        (c) => c[0].includes("20.0 tok/s") && c[0].includes("tokens"),
      ),
    ).toBe(true);
    // Final stats rendered when the body completes (no message_end)
    const last = contents.at(-1)![0];
    expect(last).toContain("📖 4096 @ 20480.0 tok/s");
    expect(last).toContain("✨ 2 @ 20.0 tok/s");
  });

  it("does not double-count tokens when both the tap and message_update fire", async () => {
    const stats = new StatsManager();
    const { ctx, setWidget } = makeCtx();
    stats.attachUi(ctx);

    // Deferred body: the tap sees the delta first and claims counting;
    // the matching agent-loop updates must then be ignored.
    let push: (chunk: string) => void = () => undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (chunk) =>
          controller.enqueue(new TextEncoder().encode(chunk));
      },
    });

    const base = vi.fn(async () => new Response(body, { status: 200 }));
    const response = await stats.tapFetch(base as any)("http://x", {});
    const reader = response.body!.getReader();

    push('data: {"choices":[{"delta":{"content":"A"}}]}\n\n');
    await reader.read();

    stats.onMessageUpdate(makeAssistantUpdate("text_delta"));
    stats.onMessageUpdate(makeAssistantUpdate("text_delta"));

    const msg = setWidget.mock.calls.at(-1)![1][0] as string;
    expect(msg).toContain("1 tokens"); // counted once, not three times
  });

  it("still counts from message_update when the tap reports no deltas", () => {
    const stats = new StatsManager();
    const { ctx, setWidget } = makeCtx();
    stats.attachUi(ctx);

    stats.beginStream();
    for (let i = 0; i < 3; i++) {
      stats.onMessageUpdate(makeAssistantUpdate("text_delta"));
    }

    const msg = setWidget.mock.calls.at(-1)![1][0] as string;
    expect(msg).toContain("3 tokens");
  });
});

describe("StatsManager lifecycle", () => {
  it("beginStream clears previous generation state", () => {
    const stats = new StatsManager();
    const { ctx, setWidget } = makeCtx();
    stats.attachUi(ctx);

    stats.beginStream();
    stats.onChunk({ progress: { total: 10, processed: 5 } });
    expect(setWidget).toHaveBeenCalledTimes(2);

    stats.beginStream();
    // Idle render clears the widget
    expect(setWidget).toHaveBeenLastCalledWith("llama-stats", undefined);
  });

  it("does not render without a UI (print mode)", () => {
    const stats = new StatsManager();
    stats.attachUi({ ui: null, hasUI: false } as any);

    expect(() => {
      stats.beginStream();
      stats.onChunk({ progress: { total: 10, processed: 5 } });
    }).not.toThrow();
  });
});
