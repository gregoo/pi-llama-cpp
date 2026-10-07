import { beforeEach, describe, expect, it, vi } from "vitest";
import { LLAMA_PROVIDER_ID } from "../src/constants";
import { getLlamaDefaultModel } from "../src/provider/defaultModel";
import {
  isUnknownModel,
  pollCatalogue,
  recoverLlamaModel,
} from "../src/provider/recovery";
import type { ConfigResolver } from "../src/resolver";

// Pi's dist-lookup for the in-memory default map is out of scope here
const mockGetLlamaDefaultModel = vi.hoisted(() => vi.fn());
vi.mock("../src/provider/defaultModel", () => ({
  getLlamaDefaultModel: mockGetLlamaDefaultModel,
}));

const makeResolver = (provider?: string, model?: string) =>
  ({
    getDefaultProvider: vi.fn().mockReturnValue(provider),
    getDefaultModel: vi.fn().mockReturnValue(model),
    // Single attempt, no waiting: keeps the recoverLlamaModel tests fast.
    resolveRetryConfig: vi.fn().mockReturnValue({ tries: 1, delaySeconds: 1 }),
  }) as unknown as ConfigResolver;

const makeCtx = (
  models: { id: string; provider: string }[],
  opts: { refreshError?: boolean; hasUI?: boolean } = {},
) => {
  const refresh = vi.fn().mockResolvedValue({
    aborted: false,
    errors: new Map<string, Error>(),
  });
  if (opts.refreshError)
    refresh.mockRejectedValue(new Error("backend unreachable"));
  const notify = vi.fn();
  const ctx = {
    modelRegistry: {
      refresh,
      getProvider: vi.fn().mockReturnValue({
        getModels: vi.fn().mockReturnValue(models),
      }),
    },
    hasUI: opts.hasUI ?? true,
    ui: { notify },
  } as any;
  return { ctx, refresh, notify };
};

const model = (id: string) => ({ id, provider: LLAMA_PROVIDER_ID });

beforeEach(() => {
  vi.clearAllMocks();
  mockGetLlamaDefaultModel.mockResolvedValue(undefined);
});

describe("isUnknownModel", () => {
  it("detects Pi's unknown placeholder", () => {
    expect(isUnknownModel({ provider: "unknown", id: "unknown" })).toBe(true);
  });

  it("rejects real models and absence", () => {
    expect(isUnknownModel(model("qwen3.5"))).toBe(false);
    expect(isUnknownModel({ provider: "unknown", id: "other" })).toBe(false);
    expect(isUnknownModel(undefined)).toBe(false);
    expect(isUnknownModel(null)).toBe(false);
  });
});

describe("recoverLlamaModel", () => {
  it("does nothing when the persisted default is not llama.cpp", async () => {
    const { ctx, refresh } = makeCtx([model("m1")]);
    const resolver = makeResolver("openai");

    await expect(recoverLlamaModel(ctx, resolver)).resolves.toBeUndefined();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("re-reads the backend and returns the in-memory preferred model", async () => {
    const { ctx, refresh } = makeCtx([model("m1"), model("m2")]);
    const resolver = makeResolver(LLAMA_PROVIDER_ID, "m1");
    mockGetLlamaDefaultModel.mockResolvedValue("m2");

    const result = await recoverLlamaModel(ctx, resolver);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: [LLAMA_PROVIDER_ID],
        force: true,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(result?.id).toBe("m2"); // most recent selection wins
  });

  it("falls back to the persisted settings default model", async () => {
    const { ctx } = makeCtx([model("m1"), model("m2")]);
    const resolver = makeResolver(LLAMA_PROVIDER_ID, "m2");

    const result = await recoverLlamaModel(ctx, resolver);

    expect(result?.id).toBe("m2");
  });

  it("falls back to the first loaded model", async () => {
    const { ctx } = makeCtx([model("m1"), model("m2")]);
    const resolver = makeResolver(LLAMA_PROVIDER_ID, "missing-model");

    const result = await recoverLlamaModel(ctx, resolver);

    expect(result?.id).toBe("m1");
  });

  it("notifies and returns undefined when the backend stays empty", async () => {
    const { ctx, notify } = makeCtx([]);
    const resolver = makeResolver(LLAMA_PROVIDER_ID, "m1");

    await expect(recoverLlamaModel(ctx, resolver)).resolves.toBeUndefined();
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("no models loaded"),
      "warning",
    );
  });

  it("does not notify when there is no UI", async () => {
    const { ctx, notify } = makeCtx([], { hasUI: false });
    const resolver = makeResolver(LLAMA_PROVIDER_ID, "m1");

    await expect(recoverLlamaModel(ctx, resolver)).resolves.toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
  });

  it("survives a failed refresh and recovers from the restored catalogue", async () => {
    // Refresh rejected (network blip) but the stored catalogue was restored
    const { ctx } = makeCtx([model("m1")], { refreshError: true });
    const resolver = makeResolver(LLAMA_PROVIDER_ID, "m1");

    const result = await recoverLlamaModel(ctx, resolver);

    expect(result?.id).toBe("m1");
  });

  it("returns undefined when a failed refresh leaves no catalogue", async () => {
    const { ctx, notify } = makeCtx([], { refreshError: true });
    const resolver = makeResolver(LLAMA_PROVIDER_ID, "m1");

    await expect(recoverLlamaModel(ctx, resolver)).resolves.toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("reads the retry configuration from the resolver", async () => {
    const { ctx } = makeCtx([model("m1")]);
    const resolver = makeResolver(LLAMA_PROVIDER_ID, "m1");

    await recoverLlamaModel(ctx, resolver);

    expect(resolver.resolveRetryConfig).toHaveBeenCalledTimes(1);
  });
});

describe("pollCatalogue", () => {
  it("re-reads the backend `tries` times while the catalogue stays empty", async () => {
    const { ctx, refresh } = makeCtx([]);
    const sleepFn = vi.fn().mockResolvedValue(undefined);

    const models = await pollCatalogue(
      ctx,
      { tries: 3, delaySeconds: 10 },
      sleepFn,
    );

    expect(models).toEqual([]);
    expect(refresh).toHaveBeenCalledTimes(3);
    // Waits between attempts, but not after the last one
    expect(sleepFn).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenNthCalledWith(1, 10_000);
    expect(sleepFn).toHaveBeenNthCalledWith(2, 10_000);
  });

  it("stops as soon as the catalogue is non-empty", async () => {
    // Empty on the first read, populated on the second
    const getModels = vi
      .fn()
      .mockReturnValueOnce([])
      .mockReturnValue([model("m1")]);
    const ctx = {
      modelRegistry: {
        refresh: vi
          .fn()
          .mockResolvedValue({ aborted: false, errors: new Map() }),
        getProvider: vi.fn().mockReturnValue({ getModels }),
      },
    } as any;
    const sleepFn = vi.fn().mockResolvedValue(undefined);

    const models = await pollCatalogue(
      ctx,
      { tries: 3, delaySeconds: 10 },
      sleepFn,
    );

    expect(models).toEqual([model("m1")]);
    expect(getModels).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledTimes(1);
  });

  it("keeps polling through failed refreshes", async () => {
    const { ctx, refresh } = makeCtx([model("m1")], { refreshError: true });
    const sleepFn = vi.fn().mockResolvedValue(undefined);

    // The refresh rejects every time, but the (restored) catalogue has a
    // model, so the first read already succeeds.
    const models = await pollCatalogue(
      ctx,
      { tries: 3, delaySeconds: 10 },
      sleepFn,
    );

    expect(models).toEqual([model("m1")]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it("survives a refresh that fails on every attempt", async () => {
    const { ctx, refresh } = makeCtx([], { refreshError: true });
    const sleepFn = vi.fn().mockResolvedValue(undefined);

    const models = await pollCatalogue(
      ctx,
      { tries: 2, delaySeconds: 5 },
      sleepFn,
    );

    expect(models).toEqual([]);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledWith(5_000);
  });
});
