/**
 * llama-cpp-stats - Shows real-time generation stats from llama.cpp.
 *
 * Works without server-side prompt_progress support by tracking token timing.
 * Shows tokens/sec and estimated time remaining during generation.
 *
 * If your llama.cpp build supports return_progress, it will also show
 * a prefill progress bar during prompt processing.
 *
 * Just install and it works — no configuration needed.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ─── State ───────────────────────────────────────────────────────────────────

let currentProgress: { total?: number; processed?: number; time_ms?: number; cache?: number } | null = null;
let prevProcessed = 0;
let prevTimeMs = 0;
let hasReceivedPrefill = false;

// Token timing for generation speed tracking
let tokenCount = 0;
let tokenTimestamps: number[] = [];
const MAX_TOKEN_TIMESTAMPS = 50;
let generationStart = 0;
let isGenerating = false;
let isToolCalling = false;

// Rate history for ETA estimation
const rateHistory: { tokenIndex: number; tps: number }[] = [];
const MAX_RATE_POINTS = 20;

// Final stats to persist after generation ends
let finalStats: { prefillTokens?: number; prefillTps?: number; genTokens: number; avgTps: number } | null = null;

let uiRef: any = null;
let hasUIRef = false;
let originalFetch: typeof fetch | null = null;

// Debug counters
let fetchHit = 0;
let llamaHit = 0;
let sseChunkCount = 0;
let firstChunkKeys: string[] = [];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDuration(seconds: number): string {
	if (seconds < 1) return "<1s";
	if (seconds < 60) return `${Math.round(seconds)}s`;
	const m = Math.floor(seconds / 60);
	const s = Math.round(seconds % 60);
	return `${m}m ${s}s`;
}

// Rolling TPS from recent token timestamps
function getRollingTps(): number {
	if (tokenTimestamps.length < 2) return 0;
	const recent = tokenTimestamps.slice(-10);
	const delta = recent[recent.length - 1] - recent[0];
	if (delta <= 0) return 0;
	return (recent.length - 1) / (delta / 1000);
}

function getProgressMessage(): string {
	let parts: string[] = [];

	// Prefill progress (only if server sends prompt_progress)
	// Exclude cached tokens from progress (matches llama.cpp WebUI behavior)
	if (hasReceivedPrefill && currentProgress && !finalStats) {
		const cache = currentProgress.cache ?? 0;
		const actualProcessed = (currentProgress.processed ?? 0) - cache;
		const actualTotal = (currentProgress.total ?? 0) - cache;
		const timeMs = currentProgress.time_ms ?? 0;

		if (actualTotal > 0 && actualProcessed < actualTotal) {
			const pct = (actualProcessed / actualTotal) * 100;
			const filled = Math.round((pct / 100) * 20);
			const bar = "█".repeat(filled) + "░".repeat(20 - filled);
			parts.push(`📖 ${bar} ${pct.toFixed(0).padStart(3)}%`);
			if (timeMs > 0 && actualProcessed > 0) {
				const tps = actualProcessed / (timeMs / 1000);
				parts.push(`${tps.toFixed(1)} tok/s`);
				const eta = (actualTotal - actualProcessed) / tps;
				parts.push(`~${formatDuration(eta)} left`);
			}
		} else if (actualProcessed > 0 || currentProgress.processed !== undefined) {
			// Prefill done — show token count only, tok/s moves to final stats
		parts.push(`📖 ${currentProgress.processed} tokens`);
		} else {
			parts.push("📖 Prefilling...");
		}
	}

	// Generation stats (no ETA — can't predict output length)
	if (isGenerating && tokenCount > 0) {
		const tps = getRollingTps();
		const icon = isToolCalling ? "🔧" : "✨";
		if (tps > 0) {
			parts.push(`${icon} ${tps.toFixed(1)} tok/s`);
		}
		parts.push(`${tokenCount} tokens`);
	}

	// Final stats (persisted after generation ends)
	if (finalStats && !isGenerating) {
		if (finalStats.prefillTokens !== undefined) {
			const prefillStr = finalStats.prefillTps
				? `${finalStats.prefillTokens} @ ${finalStats.prefillTps.toFixed(1)} tok/s`
				: `${finalStats.prefillTokens}`;
			parts.push(`📖 ${prefillStr}`);
		}
		parts.push(`✨ ${finalStats.genTokens} @ ${finalStats.avgTps.toFixed(1)} tok/s`);
	}

	return parts.join(" · ") || "Working...";
}

function updateStatus(): void {
	if (!uiRef || !hasUIRef) return;
	if (!isGenerating && !hasReceivedPrefill && !finalStats) {
		uiRef.setWidget("llama-stats", null);
		return;
	}
	const msg = getProgressMessage();
	uiRef.setWidget("llama-stats", [msg]);
}

function clearStatus(): void {
	if (!uiRef || !hasUIRef) return;
	uiRef.setWidget("llama-stats", null);
}

// ─── SSE Stream Interceptor ──────────────────────────────────────────────────

function captureTimings(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
	sseChunkCount = 0;
	firstChunkKeys = [];
	tokenCount = 0;
	tokenTimestamps = [];
	rateHistory.length = 0;
	hasReceivedPrefill = false;
	currentProgress = null;
	prevProcessed = 0;
	prevTimeMs = 0;
	isGenerating = false;
	isToolCalling = false;
	generationStart = 0;
	finalStats = null;

	const reader = body.getReader();
	let buffer = "";
	const decoder = new TextDecoder();

	return new ReadableStream({
		async start(controller) {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (!line.startsWith("data: ")) continue;
					const jsonStr = line.slice(6);
					if (jsonStr === "[DONE]") {
						// Stream complete
						isGenerating = false;
						updateStatus();
						continue;
					}

					try {
						const chunk = JSON.parse(jsonStr);
						sseChunkCount++;
						if (sseChunkCount === 1) {
							firstChunkKeys = Object.keys(chunk);
						}

						// Track prompt_progress if available (llama.cpp with return_progress)
						if (chunk.prompt_progress) {
							const p = chunk.prompt_progress;
							if (currentProgress) {
								prevProcessed = currentProgress.processed ?? 0;
								prevTimeMs = currentProgress.time_ms ?? 0;
							}
							currentProgress = p;
							hasReceivedPrefill = true;

							const deltaP = (p.processed ?? 0) - prevProcessed;
							const deltaT = (p.time_ms ?? 0) - prevTimeMs;
							if (deltaT > 0 && deltaP > 0) {
								const tps = deltaP / (deltaT / 1000);
								rateHistory.push({ tokenIndex: p.processed ?? 0, tps });
								if (rateHistory.length > MAX_RATE_POINTS) {
									rateHistory.shift();
								}
							}
							updateStatus();
						}

						// Track token generation (works without prompt_progress)
						const choice = chunk.choices?.[0];
						if (choice) {
							if (choice.finish_reason) {
								// Generation complete — capture final stats
								const elapsedSec = (Date.now() - generationStart) / 1000;
								const avgTps = elapsedSec > 0 ? tokenCount / elapsedSec : 0;
								const prefillTimeMs = currentProgress?.time_ms ?? 0;
								const prefillProcessed = currentProgress?.processed ?? 0;
								const cache = currentProgress?.cache ?? 0;
								const actualPrefill = prefillProcessed - cache;
								const prefillTps = prefillTimeMs > 0 && actualPrefill > 0
									? actualPrefill / (prefillTimeMs / 1000)
									: undefined;
								finalStats = {
									prefillTokens: hasReceivedPrefill ? prefillProcessed : undefined,
									prefillTps,
									genTokens: tokenCount,
									avgTps,
								};
								isGenerating = false;
								isToolCalling = false;
								updateStatus();
							} else if (choice.delta) {
								const hasContent = choice.delta.content && choice.delta.content.length > 0;
								const hasReasoning = choice.delta.reasoning_content &&
									choice.delta.reasoning_content.length > 0;
								const hasToolCalls = choice.delta.tool_calls && choice.delta.tool_calls.length > 0;

								if (hasContent || hasReasoning || hasToolCalls) {
									if (!isGenerating) {
										isGenerating = true;
										generationStart = Date.now();
									}
									isToolCalling = hasToolCalls;
									tokenCount++;
									const now = Date.now();
									tokenTimestamps.push(now);
									if (tokenTimestamps.length > MAX_TOKEN_TIMESTAMPS) {
										tokenTimestamps.shift();
									}

									// Calculate instantaneous TPS for this token
									if (tokenTimestamps.length >= 2) {
										const recentDelta = now - tokenTimestamps[tokenTimestamps.length - 2];
										if (recentDelta > 0) {
											const tps = 1000 / recentDelta;
											rateHistory.push({ tokenIndex: tokenCount, tps });
											if (rateHistory.length > MAX_RATE_POINTS) {
												rateHistory.shift();
											}
										}
									}

									updateStatus();
								}
							}
						}
					} catch {
						// Ignore parse errors
					}
				}

				controller.enqueue(value);
			}
			controller.close();
		},
		cancel(reason?: any) {
			reader.cancel(reason);
		},
	});
}

// ─── Fetch Interception ──────────────────────────────────────────────────────

function isLlamaCppRequest(input: any): boolean {
	const url = typeof input === "string" ? input : input?.url;
	if (typeof url !== "string") return false;
	return url.includes("/chat/completions");
}

function ensureStreamOptions(_input: any, init?: any): { input: any; init?: any } {
	// llama.cpp expects return_progress in the request BODY (not query params).
	// See: tools/server/webui/src/lib/services/chat.ts in llama.cpp
	//   return_progress: stream ? true : undefined
	const patchedInit = init ? { ...init } : undefined;

	try {
		let body = patchedInit?.body;
		if (!body) return { input: _input, init: patchedInit };

		const isString = typeof body === "string";
		const p = isString ? JSON.parse(body) : { ...body };

		// Enable prompt_progress SSE events (llama.cpp-specific)
		if (p.stream) {
			p.return_progress = true;
		}

		const newBody = JSON.stringify(p);
		if (isString) {
			patchedInit!.body = newBody;
		} else {
			Object.assign(body, p);
		}
	} catch {
		// Ignore parse errors
	}

	return { input: _input, init: patchedInit };
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const globalState = globalThis as Record<PropertyKey, unknown>;
	if (globalState["pi-llama-cpp-stats/loaded"]) return;
	globalState["pi-llama-cpp-stats/loaded"] = true;

	originalFetch = globalThis.fetch;
	globalThis.fetch = async (input: any, init?: any) => {
		fetchHit++;
		const isLlama = isLlamaCppRequest(input);
		if (isLlama) llamaHit++;
		if (!isLlama) {
			return originalFetch!(input, init);
		}

		const { input: patchedInput, init: patchedInit } = ensureStreamOptions(input, init);

		const response = await originalFetch!(patchedInput, patchedInit);

		if (response.ok && response.body) {
			return new Response(captureTimings(response.body), {
				status: response.status,
				statusText: response.statusText,
				headers: new Headers(response.headers),
			});
		}
		return response;
	};

	pi.on("before_agent_start", (_event, ctx) => {
		uiRef = ctx.ui;
		hasUIRef = ctx.hasUI;
	});

	pi.on("turn_end", async (_event, ctx) => {
		isGenerating = false;
	});

	pi.on("session_shutdown", async () => {
		console.log(`[llama-cpp-stats] fetch: ${fetchHit} total, ${llamaHit} llama.cpp`);
		uiRef = null;
		hasUIRef = false;
		rateHistory.length = 0;
		tokenTimestamps = [];
		prevProcessed = 0;
		prevTimeMs = 0;
		if (originalFetch) {
			globalThis.fetch = originalFetch;
			originalFetch = null;
		}
		delete globalState["pi-llama-cpp-stats/loaded"];
	});

	// Debug command to check interceptor status
	pi.registerCommand("llama-stats", {
		description: "Show llama-cpp-stats interceptor debug info",
		handler: async (_args, ctx) => {
			const progressStr = currentProgress
				? `${currentProgress.processed}/${currentProgress.total}`
				: "none";
			const sseStr = sseChunkCount > 0
				? `SSE: ${sseChunkCount} chunks, keys: [${firstChunkKeys.join(", ")}]`
				: "no SSE parsed";
			const genStr = tokenCount > 0
				? `tokens: ${tokenCount}, tps: ${getRollingTps().toFixed(1)}`
				: "no tokens tracked";
			ctx.ui.notify(
				`fetch: ${fetchHit}/${llamaHit} | prefill: ${progressStr} | ${sseStr} | ${genStr}`,
				"info",
			);
		},
	});
}
