/**
 * Permission layer entry point.
 *
 * OWNER: tools teammate. The exported signatures below are FROZEN.
 *
 * Rule evaluation is intentionally a single flat, ordered list: rules are
 * stated lowest-priority-first and the winner is the most specific match,
 * with a later-stated rule breaking ties. `scope()` layers extra rules at the
 * END of that list, which is what makes per-agent policy (the read-only
 * `plan` agent) override the same-specificity rules in the base config.
 */
import { createInterface } from "node:readline";
import type {
  PermissionAction,
  PermissionAsker,
  PermissionDecision,
  PermissionManager,
  PermissionRequest,
  PermissionRule,
} from "../core/types.ts";
import { matchGlob } from "../util/glob.ts";

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

/**
 * Tools that only read state and therefore need no prompt when no rule has an
 * opinion. This mirrors the `readOnly: true` flags on the built-in ToolDefs;
 * the names live here so the permission layer never depends on the tool layer
 * (which would create an import cycle once tools gate themselves).
 */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "glob",
  "grep",
  "list",
  "webfetch",
  "todoread",
]);

/** Key for the shared "always" answers: the tool plus its concrete subject. */
function learnedKey(request: PermissionRequest): string {
  return `${request.tool}\u0000${request.detail}`;
}

function toolMatches(rule: PermissionRule, tool: string): boolean {
  if (rule.tool === tool || rule.tool === "*") return true;
  // Allow globbed tool names (`mcp_*`) without making `*` itself expensive.
  if (!rule.tool.includes("*") && !rule.tool.includes("?") && !rule.tool.includes("[")) return false;
  return matchGlob(rule.tool, tool);
}

interface Candidate {
  action: PermissionAction;
  /** 2 = tool+pattern match, 1 = tool-only match. */
  specificity: number;
  index: number;
}

function escapeRegex(input: string): string {
  return input.replace(/[.+^${}()|[\]\\?]/g, "\\$&");
}

/**
 * Shell commands are not paths, so `*` in a bash rule must also cross `/`
 * (`rm -rf *` has to catch `rm -rf /`). Path-shaped details keep strict glob
 * semantics so `src/*` does not unexpectedly swallow `src/a/b.ts`.
 */
function commandMatches(pattern: string, detail: string): boolean {
  if (!pattern.includes("*") || pattern.includes("**")) return false;
  const regex = new RegExp(`^${escapeRegex(pattern).split("*").join(".*")}$`);
  return regex.test(detail.replace(/\\/g, "/"));
}

function patternMatches(rule: PermissionRule, request: PermissionRequest): boolean {
  const pattern = rule.pattern;
  if (pattern === undefined || pattern === "") return false;
  if (matchGlob(pattern, request.detail)) return true;
  return request.tool === "bash" && commandMatches(pattern, request.detail);
}

/**
 * Picks the winning rule: highest specificity first, then the latest stated.
 * Returns undefined when no rule has an opinion.
 */
function selectRule(rules: readonly PermissionRule[], request: PermissionRequest): PermissionAction | undefined {
  let winner: Candidate | undefined;
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    if (!rule) continue;
    if (!toolMatches(rule, request.tool)) continue;
    let specificity = 1;
    if (rule.pattern !== undefined && rule.pattern !== "") {
      if (!patternMatches(rule, request)) continue;
      specificity = 2;
    }
    if (!winner || specificity > winner.specificity || (specificity === winner.specificity && index > winner.index)) {
      winner = { action: rule.action, specificity, index };
    }
  }
  return winner?.action;
}

interface ManagerState {
  /** Base rules from config, lowest priority first. */
  base: readonly PermissionRule[];
  /** Extra rules from `scope()` calls, appended after the base rules. */
  scoped: readonly PermissionRule[];
  asker: PermissionAsker | undefined;
  autoApprove: boolean;
  onResolved: ((request: PermissionRequest, decision: PermissionDecision) => void) | undefined;
  /** Shared across every scoped manager: "always" answers are sticky. */
  learned: Map<string, PermissionDecision>;
}

function makeManager(state: ManagerState): PermissionManager {
  const effectiveRules = (): PermissionRule[] => [...state.base, ...state.scoped];

  const resolve = (request: PermissionRequest, decision: PermissionDecision): PermissionDecision => {
    state.onResolved?.(request, decision);
    return decision;
  };

  const ask = async (request: PermissionRequest): Promise<PermissionDecision> => {
    if (!state.asker) {
      // Never silently allow: an unanswered `ask` is a refusal.
      return resolve(request, "deny");
    }
    const answer = await state.asker.ask(request);
    if (answer === "allow-always") {
      // The asker cannot choose the persistence scope, so anything it says
      // "always" to is remembered for the rest of the session.
      state.learned.set(learnedKey(request), "allow");
      return resolve(request, "allow");
    }
    if (answer === "deny") return resolve(request, "deny");
    return resolve(request, "allow");
  };

  return {
    async check(request: PermissionRequest): Promise<PermissionDecision> {
      if (state.autoApprove) return resolve(request, "allow");

      const remembered = state.learned.get(learnedKey(request));
      if (remembered) return resolve(request, remembered);

      const action = selectRule(effectiveRules(), request);
      if (action === "allow") return resolve(request, "allow");
      if (action === "deny") return resolve(request, "deny");
      if (action === "ask") return ask(request);

      if (READ_ONLY_TOOLS.has(request.tool)) return resolve(request, "allow");
      return ask(request);
    },

    remember(request: PermissionRequest, _scope: "session" | "project"): void {
      // An "always" answer is always an approval; the scope only affects
      // whether a caller wants to persist it, which is not yet wired.
      state.learned.set(learnedKey(request), "allow");
    },

    rules(): PermissionRule[] {
      const learned: PermissionRule[] = [...state.learned.entries()].map(([key, decision]) => {
        const separator = key.indexOf("\u0000");
        return {
          tool: key.slice(0, separator),
          pattern: key.slice(separator + 1),
          action: decision === "deny" ? "deny" : "allow",
        };
      });
      return [...effectiveRules(), ...learned];
    },

    scope(rules: PermissionRule[]): PermissionManager {
      return makeManager({ ...state, scoped: [...state.scoped, ...rules] });
    },
  };
}

export function createPermissionManager(
  options: PermissionManagerOptions = {},
): PermissionManager {
  return makeManager({
    base: options.rules ?? [],
    scoped: [],
    asker: options.asker,
    autoApprove: options.autoApprove ?? false,
    onResolved: options.onResolved,
    learned: new Map(),
  });
}

function parseAnswer(raw: string): PermissionDecision {
  const answer = raw.trim().toLowerCase();
  if (answer === "always" || answer === "a") return "allow-always";
  if (answer === "y" || answer === "yes") return "allow";
  return "deny";
}

/**
 * Headless asker. Reads a single `y`/`n` answer from stdin and caches
 * "always" answers for the process lifetime.
 */
export function createPromptAsker(): PermissionAsker {
  return {
    async ask(request: PermissionRequest): Promise<PermissionDecision> {
      // Without a TTY there is nobody to answer, and reading stdin would
      // block until EOF. Refuse immediately so headless runs never hang.
      if (!process.stdin.isTTY) return "deny";

      const lines = [`\n${request.title}`, `  ${request.detail}`];
      if (request.preview) {
        for (const line of request.preview.split("\n")) lines.push(`  | ${line}`);
      }
      process.stdout.write(`${lines.join("\n")}\n`);

      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await new Promise<string>((resolvePromise) => {
          rl.question("Allow? [y]es / [n]o / [a]lways: ", (value) => resolvePromise(value));
        });
        return parseAnswer(answer);
      } finally {
        rl.close();
      }
    },
  };
}
