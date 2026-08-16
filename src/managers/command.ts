import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { AutocompleteItem } from "@earendil-works/pi-tui";
import { LLAMA_PROVIDER_ID, PROVIDER_NAME } from "../constants";
import { ConfigResolver } from "../resolver";
import { SamplingState, updateSamplingStatus } from "./sampling";

/**
 * Command manager for the `/models` command.
 *
 * Model loading/unloading lives in Pi's built-in `/llama` command; this
 * extension only offers sampling set selection for the current model.
 */
export class CommandManager {
  constructor(private readonly resolver: ConfigResolver) {}

  /**
   * Sets up the argument completions for the `/models` command
   *
   * @param prefix Prefix written by the user
   * @returns Completions with that prefix
   */
  getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
    const available = [
      {
        value: "sampling",
        label: "sampling",
        description: "Select the sampling set for the current model",
      },
    ];
    const filtered = available.filter((a) => a.value.startsWith(prefix));
    return filtered.length > 0 ? filtered : null;
  }

  /**
   * Executes the `/models` command. With no argument (or `sampling`) it
   * opens the sampling set picker for the current model.
   *
   * @param args Arguments of the command
   * @param ctx The context used by Pi
   */
  async handleCommand(
    args: string,
    ctx: ExtensionCommandContext,
    _pi: ExtensionAPI,
  ) {
    const name =
      args === "sampling" || args.startsWith("sampling ")
        ? args.slice("sampling".length).trim()
        : "";

    await this.handleSamplingCommand(name, ctx);
  }

  /**
   * Handles the `sampling` subcommand: select the sampling set injected
   * into requests for the current model (or clear the selection).
   *
   * @param name The requested set name ("" for the picker, "none"/"off"
   *             to clear)
   * @param ctx The context used by Pi
   */
  private async handleSamplingCommand(
    name: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    const model = ctx.model;
    if (!model || model.provider !== LLAMA_PROVIDER_ID) {
      ctx.ui.notify(
        `Sampling sets only apply to ${PROVIDER_NAME} models. Switch to one first.`,
        "warning",
      );
      return;
    }

    const samplingMap = this.resolver.resolveSamplingMap(model.id);
    if (!samplingMap) {
      ctx.ui.notify(
        `No sampling sets defined for ${model.id} (define a 'samplingMap' in 'llamaModelsConfig').`,
        "warning",
      );
      return;
    }

    // No argument: show the picker
    if (name === "") {
      const choices = [...Object.keys(samplingMap), "none"];
      const choice = await ctx.ui.select(
        `${PROVIDER_NAME} sampling sets for ${model.name}:`,
        choices,
      );
      if (!choice) return;
      name = choice;
    }

    if (name === "none" || name === "off") {
      SamplingState.set(model.id, undefined);
      updateSamplingStatus(ctx, model.id);
      ctx.ui.notify(
        `Sampling: (none) — using ${PROVIDER_NAME} server/model defaults`,
        "info",
      );
      return;
    }

    if (!(name in samplingMap)) {
      ctx.ui.notify(
        `Unknown sampling set '${name}'. Available: ${Object.keys(samplingMap).join(", ")}, none`,
        "error",
      );
      return;
    }

    SamplingState.set(model.id, name);
    updateSamplingStatus(ctx, model.id);
    ctx.ui.notify(`Sampling set for ${model.name}: ${name}`, "info");
  }
}
