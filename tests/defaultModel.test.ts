import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Builds a fake `@earendil-works/pi-coding-agent` installation (bin +
 * package.json + dist/core/model-resolver.js) so the walk-up resolution
 * can be exercised without a real Pi. The fake map publishes itself on
 * globalThis so assertions do not depend on ESM instance identity.
 */
describe("setLlamaDefaultModel", () => {
  let root: string;
  let fakeBin: string;
  let origArgv1: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-fake-"));
    const pkgDir = join(
      root,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
    );
    mkdirSync(join(pkgDir, "dist", "core"), { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "@earendil-works/pi-coding-agent" }),
    );
    writeFileSync(
      join(pkgDir, "dist", "core", "model-resolver.js"),
      [
        "globalThis.__piFakeMap = globalThis.__piFakeMap ?? {};",
        "export const defaultModelPerProvider = globalThis.__piFakeMap;",
        "",
      ].join("\n"),
    );
    // Like the real install: the bin's realpath lives inside the package
    // (dist/cli.js), so the walk-up from argv[1] reaches its package.json.
    fakeBin = join(pkgDir, "dist", "cli.js");
    writeFileSync(fakeBin, "#!/usr/bin/env node\n");
    origArgv1 = process.argv[1];
  });

  afterEach(() => {
    process.argv[1] = origArgv1;
    delete (globalThis as Record<string, unknown>).__piFakeMap;
    vi.resetModules();
    rmSync(root, { recursive: true, force: true });
  });

  it("registers the model in Pi's defaultModelPerProvider map", async () => {
    process.argv[1] = fakeBin;
    const { setLlamaDefaultModel } =
      await import("../src/provider/defaultModel");

    await setLlamaDefaultModel("qwen38-27b");

    expect((globalThis as Record<string, any>).__piFakeMap["llama.cpp"]).toBe(
      "qwen38-27b",
    );
  });

  it("updates the registered model on subsequent calls", async () => {
    process.argv[1] = fakeBin;
    const { setLlamaDefaultModel } =
      await import("../src/provider/defaultModel");

    await setLlamaDefaultModel("qwen38-27b");
    await setLlamaDefaultModel("gpt-20b");

    expect((globalThis as Record<string, any>).__piFakeMap["llama.cpp"]).toBe(
      "gpt-20b",
    );
  });

  it("is a no-op (never throws) when Pi cannot be located", async () => {
    process.argv[1] = join(root, "does-not-exist");
    const { setLlamaDefaultModel } =
      await import("../src/provider/defaultModel");

    await expect(setLlamaDefaultModel("x")).resolves.toBeUndefined();
    expect((globalThis as Record<string, any>).__piFakeMap).toBeUndefined();
  });
});
