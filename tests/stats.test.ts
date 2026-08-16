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

  it("ignores chunks without prompt_progress and malformed lines", async () => {
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

    // Only the prompt_progress chunk produced content (beginStream clears)
    const contents = setWidget.mock.calls
      .map((call) => call[1])
      .filter((content) => content !== undefined);
    expect(contents).toEqual([[expect.stringContaining("50%")]]);
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

  it("builds the final line from timings when usage is absent, with MTP acceptance", () => {
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
    expect(msg).toContain("✨ 422 @ 28.1 tok/s · MTP 76%");
  });

  it("extracts both prompt_progress and timings from tapped chunks", async () => {
    const stats = new StatsManager();
    const { ctx, setWidget } = makeCtx();
    stats.attachUi(ctx);

    const base = vi.fn(
      async () =>
        new Response(
          sseBody([
            'data: {"prompt_progress":{"total":100,"processed":50,"time_ms":100},"timings":{"predicted_n":7,"predicted_per_second":3.5}}\n\n',
            "data: [DONE]\n\n",
          ]),
          { status: 200 },
        ),
    );
    await (await stats.tapFetch(base as any)("http://x", {})).text();

    // Timings are captured by the tap; the decode line appears on update
    stats.onMessageUpdate(makeAssistantUpdate("text_delta"));
    const msg = setWidget.mock.calls.at(-1)![1][0] as string;
    expect(msg).toContain("50%");
    expect(msg).toContain("7 tokens");
    expect(msg).toContain("3.5 tok/s");
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
