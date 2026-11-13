/**
 * Permission layer entry point.
 *
 * OWNER: tools teammate. The exported signatures below are FROZEN.
 */
import type {
  PermissionAsker,
  PermissionDecision,
  PermissionManager,
  PermissionRequest,
  PermissionRule,
} from "../core/types.ts";

export interface PermissionManagerOptions {
  /** Config rules, lowest priority first. */
  rules?: PermissionRule[];
  /** Interactive asker. When absent, `ask` rules are denied. */
  asker?: PermissionAsker;
  /** `--yolo`: allow everything without asking. */
  autoApprove?: boolean;
  /** Notified whenever a decision is made, for the transcript. */
  onResolved?: (request: PermissionRequest, decision: PermissionDecision) => void;
}

export function createPermissionManager(
  _options: PermissionManagerOptions = {},
): PermissionManager {
  throw new Error("createPermissionManager is not implemented yet");
}

/**
 * Headless asker. Reads a single `y`/`n` answer from stdin and caches
 * "always" answers for the process lifetime.
 */
export function createPromptAsker(): PermissionAsker {
  throw new Error("createPromptAsker is not implemented yet");
}
