import type {
  ExtensionContext,
  MessageEndEvent,
  MessageUpdateEvent,
} from "@earendil-works/pi-coding-agent";
import { LLAMA_PROVIDER_ID } from "../constants";

/** A llama.cpp `prompt_progress` chunk (emitted with `return_progress: true`). */
export interface PromptProgress {
  total?: number;
  processed?: number;
  time_ms?: number;
  cache?: number;
}

/** Kinds of token deltas tracked for decode speed (mirrors pi-ai's parser). */
export type DeltaKind = "text" | "thinking" | "toolcall";

/** OpenAI-style usage object carried by the final SSE chunk. */
export interface LlamaUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/** A llama.cpp `timings` chunk (present on every SSE chunk in recent builds). */
export interface LlamaTimings {
  cache_n?: number;
  prompt_n?: number;
  prompt_ms?: number;
  prompt_per_token_ms?: number;
  prompt_per_second?: number;
  predicted_n?: number;
  predicted_ms?: number;
  predicted_per_token_ms?: number;
  predicted_per_second?: number;
  draft_n?: number;
  draft_n_accepted?: number;
}

interface FinalStats {
  prefillTokens?: number;
  prefillTps?: number;
  cached?: number;
  genTokens: number;
  avgTps: number;
  specPct?: number;
}

const WIDGET_KEY = "llama-stats";
const MAX_TOKEN_TIMESTAMPS = 50;

/**
 * Minimum wall-clock gap between widget redraws. The tap and the
 * message_update feed both fire per SSE token, so without this the widget
 * (a full component rebuild plus a TUI render request) would be rebuilt on
 * every token on the SSE processing path. Redraws are coalesced to a few
 * per second; stream start and finalization always draw immediately.
 */
const RENDER_INTERVAL_MS = 200;

/**
 * Real-time generation stats for the built-in llama.cpp provider.
 *
 * The fetch tap (`tapFetch()`, wired into the wrapper's `streamSimple`) is
 * the primary feed: it sees every request the provider makes — including
 * compaction and branch summarization, which bypass the agent loop and its
 * extension events. It injects `return_progress: true` into the request
 * body, then reads off the raw SSE stream:
 *
 * - **Prefill** — `prompt_progress` chunks (pi-ai's parser drops
 *   non-standard fields, so no event carries them); when the server build
 *   lacks support, the `timings` counter in every chunk is used instead.
 * - **Decode** — token deltas detected in the raw chunks (mirroring pi-ai's
 *   parser), plus server-reported `timings` (`predicted_n`,
 *   `predicted_per_second`) when present: authoritative under speculative
 *   decoding, where one SSE chunk can carry several tokens.
 *
 * Pi's `message_update` per-delta timing is a secondary feed for the agent
 * loop (first-wins dedup keeps the two from double-counting), and
 * `message_end` refines the final stats with authoritative usage. When the
 * tapped body completes, `finishStream()` finalizes — covering compaction,
 * where no `message_end` ever fires.
 *
 * Display uses the `llama-stats` widget slot, separate from the sampling
 * footer status. Redraws are throttled to a few per second (the feeds fire
 * per token, and Pi's own "Working" editor-border indicator covers the
 * in-flight state, so the widget shows no filler text while idle).
 */
export class StatsManager {
  private ui: ExtensionContext["ui"] | null = null;
  private hasUI = false;

  /** Render throttle state (see {@link RENDER_INTERVAL_MS}). */
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRenderAt = 0;
  private readonly renderIntervalMs: number;

  constructor(renderIntervalMs: number = RENDER_INTERVAL_MS) {
    this.renderIntervalMs = renderIntervalMs;
  }

  // Prefill state (fed by the stream tap)
  private progress: PromptProgress | null = null;
  private hasPrefill = false;

  // Latest server-reported timings (fed by the stream tap)
  private timings: LlamaTimings | null = null;

  // Usage from the final SSE chunk (fed by the stream tap)
  private streamUsage: LlamaUsage | null = null;

  // Which feed counts token deltas for the current stream. The tap sees
  // every request through the wrapped provider (agent turns AND compaction),
  // while message_update only fires inside the agent loop. Whichever feed
  // reports the first delta claims counting, so a token is never counted by
  // both (the tap is upstream of pi-ai's parser and wins in practice).
  private deltaSource: "tap" | "events" | null = null;

  // Decode state (fallback when no server timings/usage)
  private tokenCount = 0;
  private timestamps: number[] = [];
  private genStart = 0;
  private generating = false;
  private toolCalling = false;

  /** Final stats, kept on the widget until the next generation. */
  private finalStats: FinalStats | null = null;

  /**
   * Remembers a UI reference so the stream tap (which has no context) can
   * render. Called from event handlers that have a context.
   */
  attachUi(ctx: ExtensionContext): void {
    this.ui = ctx.ui;
    this.hasUI = ctx.hasUI;
  }

  /**
   * Starts tracking a new chat response stream (called by the fetch tap
   * when a response body begins). Resets all per-generation state.
   */
  beginStream(): void {
    this.progress = null;
    this.hasPrefill = false;
    this.timings = null;
    this.streamUsage = null;
    this.deltaSource = null;
    this.tokenCount = 0;
    this.timestamps = [];
    this.genStart = 0;
    this.generating = false;
    this.toolCalling = false;
    this.finalStats = null;
    this.render(true);
  }

  /** Records one tapped SSE chunk (progress, timings, usage and/or a token delta). */
  onChunk(data: {
    progress?: PromptProgress;
    timings?: LlamaTimings;
    usage?: LlamaUsage;
    delta?: DeltaKind;
  }): void {
    if (data.progress) {
      this.progress = data.progress;
      this.hasPrefill = true;
    }
    if (data.timings) this.timings = data.timings;
    if (data.usage) this.streamUsage = data.usage;
    if (data.delta) {
      this.recordDelta(data.delta, "tap");
      return;
    }
    this.render();
  }

  /**
   * Cancels any pending throttled redraw. Call when the UI goes away so a
   * stray timer cannot fire against a stale widget slot.
   */
  dispose(): void {
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
  }

  /** Tracks decode speed from per-delta message updates. */
  onMessageUpdate(event: MessageUpdateEvent): void {
    if (messageProvider(event.message) !== LLAMA_PROVIDER_ID) return;

    const delta = event.assistantMessageEvent;
    if (
      delta.type !== "text_delta" &&
      delta.type !== "thinking_delta" &&
      delta.type !== "toolcall_delta"
    ) {
      return;
    }
    this.recordDelta(
      delta.type === "toolcall_delta"
        ? "toolcall"
        : delta.type === "thinking_delta"
          ? "thinking"
          : "text",
      "events",
    );
  }

  /**
   * Counts one token arrival from either feed. The first feed to report a
   * delta for this stream claims counting (see `deltaSource`), so the tap
   * and message_update never double-count the same token.
   */
  private recordDelta(kind: DeltaKind, source: "tap" | "events"): void {
    if (this.deltaSource === null) this.deltaSource = source;
    else if (this.deltaSource !== source) return;

    if (!this.generating) {
      this.generating = true;
      this.genStart = Date.now();
    }
    this.toolCalling = kind === "toolcall";
    this.tokenCount++;
    const now = Date.now();
    this.timestamps.push(now);
    if (this.timestamps.length > MAX_TOKEN_TIMESTAMPS) this.timestamps.shift();
    this.render();
  }

  /** Finalizes the stats when the assistant message completes. */
  onMessageEnd(event: MessageEndEvent): void {
    const message = event.message;
    if (messageProvider(message) !== LLAMA_PROVIDER_ID) return;
    if (!this.generating && !this.hasPrefill && !this.timings) return;
    this.finalize(
      message.role === "assistant" && message.usage ? message.usage : undefined,
    );
  }

  /**
   * Finalizes the stats when the tapped stream body completes. Covers
   * requests that bypass the agent loop (compaction, branch summarization),
   * where no `message_end` event fires. For regular turns `message_end`
   * follows and re-finalizes with the authoritative usage.
   */
  finishStream(): void {
    if (this.finalStats) return;
    if (!this.generating && !this.hasPrefill && !this.timings) return;
    this.finalize(undefined);
  }

  /** Shared finalization core for message_end and stream completion. */
  private finalize(usage?: { output: number }): void {
    // Token count: message usage > server timings (spec-decode-accurate)
    // > chunk usage > delta count.
    const chunkTokens = this.streamUsage?.completion_tokens;
    const genTokens =
      usage && usage.output > 0
        ? usage.output
        : (this.serverTokens() ??
          (typeof chunkTokens === "number" && chunkTokens > 0
            ? chunkTokens
            : this.tokenCount));

    // Speed: prefer the server's own clock, fall back to local elapsed time.
    let avgTps: number;
    const predMs = this.timings?.predicted_ms;
    if (
      genTokens === this.serverTokens() &&
      typeof predMs === "number" &&
      predMs > 0
    ) {
      avgTps = genTokens / (predMs / 1000);
    } else {
      const elapsedSec = (Date.now() - this.genStart) / 1000;
      avgTps = elapsedSec > 0 ? genTokens / elapsedSec : 0;
    }

    // Prefill: prompt_progress if available, otherwise the final timings.
    let prefillTokens: number | undefined;
    let prefillTps: number | undefined;
    let cached: number | undefined;
    if (this.hasPrefill && this.progress) {
      const processed = this.progress.processed ?? 0;
      cached = this.progress.cache ?? 0;
      const timeMs = this.progress.time_ms ?? 0;
      prefillTokens = processed;
      prefillTps =
        timeMs > 0 && processed - cached > 0
          ? (processed - cached) / (timeMs / 1000)
          : undefined;
    } else {
      const t = this.timings;
      if (t && typeof t.prompt_n === "number") {
        cached = t.cache_n ?? 0;
        prefillTokens = t.prompt_n + cached;
        prefillTps =
          (t.prompt_ms ?? 0) > 0 && t.prompt_n > 0
            ? t.prompt_n / ((t.prompt_ms ?? 0) / 1000)
            : undefined;
      }
    }

    const draftN = this.timings?.draft_n ?? 0;
    const draftAcc = this.timings?.draft_n_accepted ?? 0;

    this.finalStats = {
      prefillTokens,
      prefillTps,
      cached,
      genTokens,
      avgTps,
      specPct: draftN > 0 ? Math.round((draftAcc / draftN) * 100) : undefined,
    };
    this.generating = false;
    this.toolCalling = false;
    this.render(true);
  }

  /**
   * Schedules a widget redraw, coalescing the per-token feed into at most
   * one draw per {@link renderIntervalMs}. `force` bypasses the throttle
   * (stream start / finalization).
   */
  private render(force = false): void {
    if (!this.ui || !this.hasUI) return;

    // Throttling disabled: draw on every call (tests, high-refresh UIs).
    if (this.renderIntervalMs <= 0) {
      this.draw();
      return;
    }

    const now = Date.now();
    if (force || now - this.lastRenderAt >= this.renderIntervalMs) {
      this.cancelPendingRender();
      this.lastRenderAt = now;
      this.draw();
      return;
    }
    if (!this.renderTimer) {
      this.renderTimer = setTimeout(
        () => {
          this.renderTimer = null;
          this.lastRenderAt = Date.now();
          this.draw();
        },
        this.renderIntervalMs - (now - this.lastRenderAt),
      );
    }
  }

  private cancelPendingRender(): void {
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
  }

  private draw(): void {
    if (!this.ui) return;
    const message = this.message();
    // No parts means nothing to show: Pi's own "Working" indicator (editor
    // border) covers the in-flight state, so the plugin adds no filler text.
    this.ui.setWidget(WIDGET_KEY, message ? [message] : undefined);
  }

  /**
   * Wraps a fetch so that successful response bodies are tapped for
   * `prompt_progress`, `timings`, token deltas and usage. Request bodies get
   * `return_progress: true` injected (see {@link withReturnProgress});
   * response bytes pass through unchanged and the wrapped stream is
   * cancel-safe. Intended to be passed as `options.fetch` to the provider's
   * `streamSimple`, so only this provider's requests are touched.
   *
   * Tapping at the fetch level (rather than relying on extension events)
   * keeps stats working for requests that bypass the agent loop —
   * compaction and branch summarization never fire
   * `before_provider_request` / `message_update` / `message_end`.
   */
  tapFetch(base?: typeof fetch): typeof fetch {
    const upstream = base ?? globalThis.fetch.bind(globalThis);
    return async (input, init) => {
      const response = await upstream(input, withReturnProgress(init));
      if (!response.ok || !response.body) return response;

      this.beginStream();
      const body = tapSseBody(
        response.body,
        (chunk) => {
          const data: {
            progress?: PromptProgress;
            timings?: LlamaTimings;
            usage?: LlamaUsage;
            delta?: DeltaKind;
          } = {};
          if (
            chunk.prompt_progress &&
            typeof chunk.prompt_progress === "object"
          ) {
            data.progress = chunk.prompt_progress as PromptProgress;
          }
          if (chunk.timings && typeof chunk.timings === "object") {
            data.timings = chunk.timings as LlamaTimings;
          }
          if (chunk.usage && typeof chunk.usage === "object") {
            data.usage = chunk.usage as LlamaUsage;
          }
          const delta = chunkDeltaKind(chunk);
          if (delta) data.delta = delta;
          if (data.progress || data.timings || data.usage || data.delta)
            this.onChunk(data);
        },
        () => this.finishStream(),
      );
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    };
  }

  /** Server-reported generated token count (authoritative under MTP). */
  private serverTokens(): number | undefined {
    const n = this.timings?.predicted_n;
    return typeof n === "number" && n >= 0 ? n : undefined;
  }

  /** Server-reported cumulative decode speed. */
  private serverTps(): number {
    const t = this.timings?.predicted_per_second;
    return typeof t === "number" && t > 0 ? t : 0;
  }

  /** Rolling tokens/sec over the last ~10 token arrivals (fallback). */
  private rollingTps(): number {
    if (this.timestamps.length < 2) return 0;
    const recent = this.timestamps.slice(-10);
    const delta = recent[recent.length - 1] - recent[0];
    if (delta <= 0) return 0;
    return (recent.length - 1) / (delta / 1000);
  }

  private message(): string {
    const parts: string[] = [];

    // Prefill progress (only when the server sends prompt_progress)
    if (this.hasPrefill && this.progress && !this.finalStats) {
      // Exclude cached tokens from progress (matches llama.cpp WebUI)
      const cache = this.progress.cache ?? 0;
      const processed = (this.progress.processed ?? 0) - cache;
      const total = (this.progress.total ?? 0) - cache;
      const timeMs = this.progress.time_ms ?? 0;

      if (total > 0 && processed < total) {
        const pct = (processed / total) * 100;
        const filled = Math.round((pct / 100) * 20);
        parts.push(
          `📖 ${"█".repeat(filled)}${"░".repeat(20 - filled)} ${pct.toFixed(0).padStart(3)}%`,
        );
        if (timeMs > 0 && processed > 0) {
          const tps = processed / (timeMs / 1000);
          parts.push(`${tps.toFixed(1)} tok/s`);
          parts.push(`~${formatDuration((total - processed) / tps)} left`);
        }
      } else if (processed > 0 || this.progress.processed !== undefined) {
        parts.push(`📖 ${this.progress.processed} tokens`);
      } else {
        parts.push("📖 Prefilling...");
      }
    } else if (!this.finalStats && !this.generating && this.timings) {
      // No prompt_progress support — fall back to the timings counter
      const fresh = this.timings.prompt_n ?? 0;
      const cached = this.timings.cache_n ?? 0;
      parts.push(
        fresh > 0 || cached > 0
          ? `📖 ${fresh + cached} tokens prefill`
          : "📖 Prefilling...",
      );
    }

    // Generation speed (no ETA — output length is unpredictable)
    if (this.generating) {
      const tokens = this.serverTokens() ?? this.tokenCount;
      if (tokens > 0) {
        const tps = this.serverTps() || this.rollingTps();
        const icon = this.toolCalling ? "🔧" : "✨";
        parts.push(
          `${icon} ${tps > 0 ? `${tps.toFixed(1)} tok/s · ` : ""}${tokens} tokens`,
        );
      }
    }

    // Final stats (persisted until the next generation)
    if (this.finalStats && !this.generating) {
      const final = this.finalStats;
      if (final.prefillTokens !== undefined) {
        let prefill = `📖 ${final.prefillTokens}`;
        if ((final.cached ?? 0) > 0) prefill += ` (${final.cached} cached)`;
        if (final.prefillTps)
          prefill += ` @ ${final.prefillTps.toFixed(1)} tok/s`;
        parts.push(prefill);
      }
      let decode = `✨ ${final.genTokens} @ ${final.avgTps.toFixed(1)} tok/s`;
      if (final.specPct !== undefined) decode += ` · spec ${final.specPct}%`;
      parts.push(decode);
    }

    return parts.join(" · ");
  }
}

/** Provider of an agent message, without narrowing the union. */
function messageProvider(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const candidate = message as { provider?: unknown };
  return typeof candidate.provider === "string"
    ? candidate.provider
    : undefined;
}

function formatDuration(seconds: number): string {
  if (seconds < 1) return "<1s";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

/**
 * Passes a stream's bytes through unchanged while parsing its SSE `data:`
 * lines and handing each decoded JSON object to `onChunk`. Parse errors are
 * ignored; the stream stays intact for the real consumer. `onComplete` fires
 * only when the body ends naturally (not on cancel or error).
 */
function tapSseBody(
  body: ReadableStream<Uint8Array>,
  onChunk: (chunk: Record<string, unknown>) => void,
  onComplete?: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let buffer = "";
  let cancelled = false;
  const decoder = new TextDecoder();

  return new ReadableStream({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const jsonStr = line.slice(6);
            if (jsonStr === "[DONE]") continue;
            try {
              onChunk(JSON.parse(jsonStr) as Record<string, unknown>);
            } catch {
              // Not JSON — ignore
            }
          }

          controller.enqueue(value);
        }
        if (!cancelled) onComplete?.();
      } finally {
        controller.close();
      }
    },
    cancel(reason) {
      cancelled = true;
      reader.cancel(reason).catch(() => undefined);
    },
  });
}

/** Reasoning fields pi-ai's parser accepts, in priority order. */
const REASONING_FIELDS = [
  "reasoning_content",
  "reasoning",
  "reasoning_text",
] as const;

/**
 * Detects a token-carrying delta in an SSE chunk, mirroring the cases
 * pi-ai turns into `text_delta` / `thinking_delta` / `toolcall_delta`.
 */
function chunkDeltaKind(chunk: Record<string, unknown>): DeltaKind | null {
  const choices = chunk.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const choice = choices[0] as { delta?: unknown } | undefined;
  const delta = choice?.delta;
  if (typeof delta !== "object" || delta === null) return null;
  const d = delta as Record<string, unknown>;
  if (typeof d.content === "string" && d.content.length > 0) return "text";
  for (const field of REASONING_FIELDS) {
    const value = d[field];
    if (typeof value === "string" && value.length > 0) return "thinking";
  }
  if (Array.isArray(d.tool_calls) && d.tool_calls.length > 0) return "toolcall";
  return null;
}

/**
 * Adds `return_progress: true` to a JSON request body so the server emits
 * `prompt_progress` SSE chunks. The tap is only attached to this provider's
 * `streamSimple`, so no other traffic is affected. Non-JSON-object bodies
 * pass through untouched; an already-injected flag (from
 * `before_provider_request`) short-circuits the rewrite.
 */
function withReturnProgress(init?: RequestInit): RequestInit | undefined {
  if (!init || typeof init.body !== "string") return init;
  let payload: unknown;
  try {
    payload = JSON.parse(init.body);
  } catch {
    return init;
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload))
    return init;
  const body = payload as Record<string, unknown>;
  if (body.return_progress === true) return init;
  body.return_progress = true;
  // The rewritten body has a different length: drop content-length so the
  // runtime recomputes it.
  const headers = withoutContentLength(init.headers);
  return {
    ...init,
    body: JSON.stringify(body),
    ...(headers !== undefined ? { headers } : {}),
  };
}

/** Returns `headers` without a content-length entry (any header shape). */
function withoutContentLength(
  headers: RequestInit["headers"],
): RequestInit["headers"] | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).set === "function") {
    const copy = new Headers(headers);
    copy.delete("content-length");
    return copy;
  }
  if (Array.isArray(headers)) {
    return headers.filter(([name]) => name.toLowerCase() !== "content-length");
  }
  const record = headers as Record<string, string>;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(record)) {
    if (name.toLowerCase() !== "content-length") out[name] = value;
  }
  return out;
}
