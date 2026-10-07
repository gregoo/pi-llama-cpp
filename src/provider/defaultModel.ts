import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { LLAMA_PROVIDER_ID } from "../constants";

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

let mapPromise: Promise<Record<string, string> | null> | null = null;

/**
 * Resolves Pi's internal `defaultModelPerProvider` map — a plain mutable
 * object exported from a dist module that the package's exports map does
 * not expose. Registering llama.cpp in it makes the built-in `/login`
 * flow auto-select a default model after saving credentials, instead of
 * erroring with "no default model is configured for provider".
 *
 * Deep imports are blocked by the exports map, so we locate Pi's own
 * installation via the process entry point and import the file directly
 * by URL. Anchoring on `process.argv[1]` (rather than our own module
 * resolution) guarantees we mutate the copy Pi is actually running, even
 * if a second copy of the package exists in the extension's node_modules.
 *
 * Any failure yields null — callers treat that as a no-op and Pi keeps
 * its stock behavior.
 */
function getDefaultModelMap(): Promise<Record<string, string> | null> {
  if (!mapPromise) {
    mapPromise = (async () => {
      try {
        let dir = dirname(realpathSync(process.argv[1]));
        for (let i = 0; i < 12; i++) {
          const pkgPath = join(dir, "package.json");
          if (existsSync(pkgPath)) {
            try {
              const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
              if (pkg.name === PI_PACKAGE_NAME) {
                const mod: any = await import(
                  pathToFileURL(join(dir, "dist", "core", "model-resolver.js"))
                    .href
                );
                const map = mod?.defaultModelPerProvider;
                return map && typeof map === "object" ? map : null;
              }
            } catch {
              // Unreadable package.json — keep walking up
            }
          }
          const parent = dirname(dir);
          if (parent === dir) break;
          dir = parent;
        }
      } catch {
        // Entry point missing or import failed — feature disabled
      }
      return null;
    })();
  }
  return mapPromise;
}

/**
 * Registers `modelId` as the default model for llama.cpp in Pi's login
 * flow, so `/login llama.cpp` selects it after saving credentials.
 * Fire-and-forget safe: never throws.
 */
export async function setLlamaDefaultModel(modelId: string): Promise<void> {
  const map = await getDefaultModelMap();
  if (map) map[LLAMA_PROVIDER_ID] = modelId;
}

/**
 * Reads back the model registered as llama.cpp's default in Pi's in-memory
 * map — i.e. the most recently selected llama.cpp model in this process
 * (the map is updated on every llama.cpp `model_select`). Returns
 * `undefined` when Pi cannot be found or no model has been registered yet.
 */
export async function getLlamaDefaultModel(): Promise<string | undefined> {
  const map = await getDefaultModelMap();
  const value = map?.[LLAMA_PROVIDER_ID];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
