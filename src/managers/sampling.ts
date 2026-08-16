import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PROVIDER_NAME } from "../constants";

/**
 * Session-only, per-model sampling set selection.
 *
 * A model can define several named sampling sets in `llamaModelsConfig`;
 * at most one is active per model at a time (or none, in which case the
 * server/model defaults apply). Selections live only for the current Pi
 * session — they are not persisted.
 */
const selections = new Map<string, string>();

export const SamplingState = {
  /**
   * Gets the active sampling set name for a model.
   *
   * @param modelId The model ID
   * @returns The set name, or undefined when no set is active
   */
  get(modelId: string): string | undefined {
    return selections.get(modelId);
  },

  /**
   * Sets (or clears, with `undefined`) the active sampling set for a model.
   *
   * @param modelId The model ID
   * @param name The set name, or undefined to clear
   */
  set(modelId: string, name: string | undefined): void {
    if (name === undefined) selections.delete(modelId);
    else selections.set(modelId, name);
  },

  /** Clears all selections (test helper). */
  clear(): void {
    selections.clear();
  },
};

/**
 * Updates the footer status with the sampling set active for a model.
 *
 * @param ctx Pi context
 * @param modelId The model ID
 */
export function updateSamplingStatus(
  ctx: ExtensionContext,
  modelId: string,
): void {
  const name = SamplingState.get(modelId);
  ctx.ui.setStatus(
    PROVIDER_NAME,
    name !== undefined ? `sampling: ${name}` : undefined,
  );
}
