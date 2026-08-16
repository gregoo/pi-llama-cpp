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
 * Real-time generation stats for the built-in llama.cpp provider.
 *
 * Two scoped feeds, no global fetch patching:
 *
 * - **Prefill** — `tapFetch()` wraps the provider's own fetch and reads
 *   `prompt_progress` chunks off the raw SSE body (pi-ai's parser drops
 *   non-standard fields, so no event carries them). Only works when the
 *   server build supports `return_progress`; otherwise the `timings`
 *   counter in every chunk is used instead.
 * - **Decode** — server-reported `timings` (`predicted_n`,
 *   `predicted_per_second`) when present: authoritative under speculative
 *   decoding, where one SSE chunk can carry several tokens. Pi's
 *   `message_update` per-delta timing is the fallback for older builds.
 *
 * Display uses the `llama-stats` widget slot, separate from the sampling
 * footer status.
 */
export class StatsManager {
  private ui: ExtensionContext["ui"] | null = null;
  private hasUI = false;

  // Prefill state (fed by the stream tap)
  private progress: PromptProgress | null = null;
  private hasPrefill = false;

  // Latest server-reported timings (fed by the stream tap)
  private timings: LlamaTimings | null = null;

  // Decode state (fed by message_update; fallback when no timings)
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
    this.tokenCount = 0;
    this.timestamps = [];
    this.genStart = 0;
    this.generating = false;
    this.toolCalling = false;
    this.finalStats = null;
    this.render();
  }

  /** Records one tapped SSE chunk (`prompt_progress` and/or `timings`). */
  onChunk(data: { progress?: PromptProgress; timings?: LlamaTimings }): void {
    if (data.progress) {
      this.progress = data.progress;
      this.hasPrefill = true;
    }
    if (data.timings) this.timings = data.timings;
    this.render();
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

    if (!this.generating) {
      this.generating = true;
      this.genStart = Date.now();
    }
    this.toolCalling = delta.type === "toolcall_delta";
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

    // Token count: server usage > server timings (spec-decode-accurate)
    // > delta count.
    const genTokens =
      message.role === "assistant" && message.usage.output > 0
        ? message.usage.output
        : this.serverTokens() ?? this.tokenCount;

    // Speed: prefer the server's own clock, fall back to local elapsed time.
    let avgTps: number;
    const predMs = this.timings?.predicted_ms;
    if (genTokens === this.serverTokens() && typeof predMs === "number" && predMs > 0) {
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
    this.render();
  }

  /**
   * Wraps a fetch so that successful response bodies are tapped for
   * `prompt_progress` chunks. Bytes pass through unchanged; the wrapped
   * stream is cancel-safe. Intended to be passed as `options.fetch` to the
   * provider's `streamSimple`, so only this provider's requests are touched.
   */
  tapFetch(base?: typeof fetch): typeof fetch {
    const upstream = base ?? globalThis.fetch.bind(globalThis);
    return async (input, init) => {
      const response = await upstream(input, init);
      if (!response.ok || !response.body) return response;

      this.beginStream();
      const body = tapSseBody(response.body, (chunk) => {
        const data: { progress?: PromptProgress; timings?: LlamaTimings } = {};
        if (chunk.prompt_progress && typeof chunk.prompt_progress === "object") {
          data.progress = chunk.prompt_progress as PromptProgress;
        }
        if (chunk.timings && typeof chunk.timings === "object") {
          data.timings = chunk.timings as LlamaTimings;
        }
        if (data.progress || data.timings) this.onChunk(data);
      });
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

  private render(): void {
    if (!this.ui || !this.hasUI) return;
    const idle =
      !this.generating && !this.hasPrefill && !this.finalStats && !this.timings;
    this.ui.setWidget(WIDGET_KEY, idle ? undefined : [this.message()]);
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

    return parts.join(" · ") || "Working...";
  }
}

/** Provider of an agent message, without narrowing the union. */
function messageProvider(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const candidate = message as { provider?: unknown };
  return typeof candidate.provider === "string" ? candidate.provider : undefined;
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
 * ignored; the stream stays intact for the real consumer.
 */
function tapSseBody(
  body: ReadableStream<Uint8Array>,
  onChunk: (chunk: Record<string, unknown>) => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let buffer = "";
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
      } finally {
        controller.close();
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => undefined);
    },
  });
}
