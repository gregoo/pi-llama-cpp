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

interface FinalStats {
  prefillTokens?: number;
  prefillTps?: number;
  genTokens: number;
  avgTps: number;
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
 *   server build supports `return_progress`; otherwise this feed is empty.
 * - **Decode** — Pi's `message_update` event fires per token delta; token
 *   timing gives tokens/sec without touching the stream at all.
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

  // Decode state (fed by message_update)
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
    this.tokenCount = 0;
    this.timestamps = [];
    this.genStart = 0;
    this.generating = false;
    this.toolCalling = false;
    this.finalStats = null;
    this.render();
  }

  /** Records a `prompt_progress` chunk from the stream tap. */
  prefill(progress: PromptProgress): void {
    this.progress = progress;
    this.hasPrefill = true;
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
    if (!this.generating && !this.hasPrefill) return;

    // Prefer the server-reported count; fall back to the delta count.
    const genTokens =
      message.role === "assistant" && message.usage.output > 0
        ? message.usage.output
        : this.tokenCount;
    const elapsedSec = (Date.now() - this.genStart) / 1000;
    const avgTps = elapsedSec > 0 ? genTokens / elapsedSec : 0;

    const processed = this.progress?.processed ?? 0;
    const cache = this.progress?.cache ?? 0;
    const timeMs = this.progress?.time_ms ?? 0;
    const actualPrefill = processed - cache;
    const prefillTps =
      timeMs > 0 && actualPrefill > 0 ? actualPrefill / (timeMs / 1000) : undefined;

    this.finalStats = {
      prefillTokens: this.hasPrefill ? processed : undefined,
      prefillTps,
      genTokens,
      avgTps,
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
        const progress = chunk.prompt_progress;
        if (progress && typeof progress === "object") {
          this.prefill(progress as PromptProgress);
        }
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    };
  }

  /** Rolling tokens/sec over the last ~10 token arrivals. */
  private rollingTps(): number {
    if (this.timestamps.length < 2) return 0;
    const recent = this.timestamps.slice(-10);
    const delta = recent[recent.length - 1] - recent[0];
    if (delta <= 0) return 0;
    return (recent.length - 1) / (delta / 1000);
  }

  private render(): void {
    if (!this.ui || !this.hasUI) return;
    const idle = !this.generating && !this.hasPrefill && !this.finalStats;
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
    }

    // Generation speed (no ETA — output length is unpredictable)
    if (this.generating && this.tokenCount > 0) {
      const tps = this.rollingTps();
      const icon = this.toolCalling ? "🔧" : "✨";
      parts.push(
        `${icon} ${tps > 0 ? `${tps.toFixed(1)} tok/s · ` : ""}${this.tokenCount} tokens`,
      );
    }

    // Final stats (persisted until the next generation)
    if (this.finalStats && !this.generating) {
      const final = this.finalStats;
      if (final.prefillTokens !== undefined) {
        parts.push(
          `📖 ${
            final.prefillTps
              ? `${final.prefillTokens} @ ${final.prefillTps.toFixed(1)} tok/s`
              : final.prefillTokens
          }`,
        );
      }
      parts.push(`✨ ${final.genTokens} @ ${final.avgTps.toFixed(1)} tok/s`);
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
