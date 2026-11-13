/**
 * `kortivai` — interactive shell.
 *
 * Orchestration only: the editor reducer, key decoder, completion, status
 * renderers and transcript are all pure and tested separately. This file
 * wires them to the runtime and owns the terminal lifecycle.
 */
import type {
  AgentEvent,
  ModelRef,
  PermissionAsker,
  PermissionDecision,
  PermissionRequest,
  Session,
  Usage,
} from "../../core/types.ts";
import { accumulateUsage, textOf } from "../../core/agent.ts";
import type { KortivRuntime } from "../../core/wiring.ts";
import { KortivError, errorMessage } from "../../util/errors.ts";
import { homeDir } from "../../util/paths.ts";
import { createEditorState, reduceEditor, type EditorKey, type EditorState } from "../../ui/editor.ts";
import { complete, renderCompletionList, SLASH_COMMANDS, tokenAt } from "../../ui/completion.ts";
import { decidePermission, renderPermissionPrompt } from "../../ui/permission.ts";
import { RawInput } from "../../ui/input.ts";
import {
  renderBanner,
  renderPromptPrefix,
  renderSessionSummary,
  renderStatusLine,
  type StatusInfo,
} from "../../ui/status.ts";
import { renderTable } from "../../ui/table.ts";
import { createTheme, displayWidth, resolveThemeName, type Theme } from "../../ui/theme.ts";
import {
  Transcript,
  renderError,
  renderPermissionBox,
  usageOf,
} from "../../ui/transcript.ts";
import type { CliContext, CliIo } from "../io.ts";
import { flagBool, flagString } from "../io.ts";
import { agentFromFlags, loadRuntime, resolveSession, runtimeOptions } from "../runtime.ts";
import { walkFiles } from "../files.ts";
import { initProject } from "./init.ts";
import { formatAge } from "./sessions.ts";
import { runCommand } from "./run.ts";

type Mode = "editing" | "busy" | "permission" | "closed";

interface PendingSelection {
  kind: "model" | "agent";
  options: string[];
}

const CLEAR_LINE = "\r\u001b[2K";
const MAX_OPTIONS = 30;
const ABORT_EXIT_MS = 1500;

export async function tuiCommand(ctx: CliContext): Promise<number> {
  // Piped or redirected: fall back to the line-mode one-shot, never hang.
  if (!ctx.io.stdinIsTTY || !ctx.io.stdoutIsTTY) return runCommand(ctx);
  const shell = new Shell(ctx);
  return shell.run();
}

class Shell {
  private readonly ctx: CliContext;
  private readonly io: CliIo;
  private theme!: Theme;
  private runtime!: KortivRuntime;
  private transcript!: Transcript;
  private input!: RawInput;
  private session!: Session;
  private editor: EditorState = createEditorState();
  private status: StatusInfo = { agent: "build", model: "default", cwd: process.cwd() };
  private mode: Mode = "editing";
  private files: string[] = [];
  private usage: Usage | undefined;
  private modelKey: string | undefined;
  private history: string[] = [];
  private pendingSelection: PendingSelection | undefined;
  private spinner: NodeJS.Timeout | undefined;
  private spinnerFrame = 0;
  private lastAbort = 0;
  private exitRequested = false;
  private exitCode = 0;
  private submitResolve: ((value: string | undefined) => void) | undefined;
  private permissionResolve: ((decision: PermissionDecision) => void) | undefined;
  private unsubscribe: () => void = () => {};

  constructor(ctx: CliContext) {
    this.ctx = ctx;
    this.io = ctx.io;
    this.modelKey = flagString(ctx.flags, "model");
  }

  async run(): Promise<number> {
    const asker: PermissionAsker = { ask: (request) => this.askPermission(request) };
    this.runtime = await loadRuntime(runtimeOptions(this.ctx, { asker }));
    this.theme = createTheme({
      name: resolveThemeName(this.runtime.config.ui?.theme),
      env: this.io.env,
      isTTY: true,
      columns: this.io.columns,
    });
    this.transcript = new Transcript({
      theme: this.theme,
      sink: this.io.stdout,
      markdown: this.runtime.config.ui?.markdown,
      showReasoning: this.runtime.config.ui?.showReasoning,
      showTokenUsage: this.runtime.config.ui?.showTokenUsage,
      echoUser: false,
    });
    this.unsubscribe = this.runtime.events.subscribe((event) => this.onEvent(event));

    try {
      this.session =
        (await resolveSession(this.runtime, {
          session: flagString(this.ctx.flags, "session"),
          continueLatest: flagBool(this.ctx.flags, "continue"),
        })) ??
        (await this.runtime.agents.createSession({
          cwd: flagString(this.ctx.flags, "cwd") ?? this.io.cwd,
          agent: agentFromFlags(this.ctx),
          model: this.modelKey,
        }));

      this.status = {
        agent: this.session.agent,
        model: `${this.session.model.provider}/${this.session.model.model}`,
        cwd: this.session.cwd,
        usage: this.session.usage,
      };
      this.files = walkFiles(this.session.cwd);

      this.io.stdout.write(`${this.renderBannerText()}\n`);
      this.io.stdout.write(
        `${this.theme.dim(`  resumed session ${this.session.id.slice(0, 8)}`)}\n`,
      );
      this.io.stdout.write(
        `${this.theme.dim(`  ${this.session.title}`)}\n\n`,
      );

      this.input = new RawInput({
        stdin: this.io.stdin,
        stdout: this.io.stdout,
        onKey: (key) => this.handleKey(key),
        onError: (error) => this.note(`input error: ${errorMessage(error)}`),
      });
      this.input.start();
      await this.loop();
    } finally {
      this.mode = "closed";
      this.stopSpinner();
      this.input?.stop();
      this.unsubscribe();
      try {
        await this.runtime.close();
      } catch {
        // best effort
      }
      await this.printSummary();
    }
    return this.exitCode;
  }

  private renderBannerText(): string {
    return renderBanner(
      {
        name: "kortivai",
        version: version(),
        cwd: this.session.cwd,
        model: this.status.model,
        agent: this.status.agent,
      },
      this.theme,
    );
  }

  private async loop(): Promise<void> {
    while (!this.exitRequested) {
      this.mode = "editing";
      this.editor = createEditorState({ buffer: "", history: this.history });
      this.io.stdout.write(`${renderStatusLine(this.status, this.theme)}\n`);
      this.renderPrompt();
      const submitted = await this.waitForSubmit();
      if (submitted === undefined) break;
      await this.handleInput(submitted);
    }
  }

  private waitForSubmit(): Promise<string | undefined> {
    return new Promise<string | undefined>((resolve) => {
      this.submitResolve = resolve;
    });
  }

  private finishSubmit(value: string | undefined): void {
    const resolve = this.submitResolve;
    this.submitResolve = undefined;
    resolve?.(value);
  }

  /* ---------------------------------------------------------------- *
   * Keys
   * ---------------------------------------------------------------- */

  private handleKey(key: EditorKey): void {
    switch (this.mode) {
      case "busy":
        this.onBusyKey(key);
        return;
      case "permission":
        this.onPermissionKey(key);
        return;
      case "editing":
        this.onEditingKey(key);
        return;
      default:
        return;
    }
  }

  private onEditingKey(key: EditorKey): void {
    if (key.name === "tab") {
      this.handleCompletion();
      return;
    }
    if (key.name === "ctrl-l") {
      this.clearScreen();
      return;
    }
    const result = reduceEditor(this.editor, key);
    this.editor = result.state;
    if (result.redraw) this.renderPrompt();
    if (result.exit) {
      this.finishSubmit(undefined);
      return;
    }
    if (result.submitted !== undefined) {
      this.history = this.editor.history;
      this.io.stdout.write("\n");
      this.finishSubmit(result.submitted);
    }
  }

  private onBusyKey(key: EditorKey): void {
    if (key.name !== "ctrl-c") return;
    const now = Date.now();
    if (now - this.lastAbort < ABORT_EXIT_MS) {
      this.exitRequested = true;
      this.exitCode = 130;
      this.runtime.agents.abort(this.session.id);
      return;
    }
    this.lastAbort = now;
    this.status = { ...this.status, cancelling: true };
    this.runtime.agents.abort(this.session.id);
    this.note("cancelling — press Ctrl+C again to exit");
  }

  private onPermissionKey(key: EditorKey): void {
    const decision = decidePermission(key);
    if (!decision) return;
    const resolve = this.permissionResolve;
    this.permissionResolve = undefined;
    this.mode = "busy";
    this.io.stdout.write("\n");
    resolve?.(decision);
  }

  private renderPrompt(): void {
    const prefix = renderPromptPrefix(this.status, this.theme);
    const room = Math.max(8, this.theme.width - displayWidth(prefix) - 1);
    const window = visibleWindow(this.editor.buffer, this.editor.cursor, room);
    this.io.stdout.write(`${CLEAR_LINE}${prefix}${this.theme.paint(window.text, "text")}`);
    const back = displayWidth(window.text.slice(window.cursor));
    if (back > 0) this.io.stdout.write(`\u001b[${back}D`);
  }

  private handleCompletion(): void {
    const span = tokenAt(this.editor.buffer, this.editor.cursor);
    const result = complete(span.text, { files: this.files });
    if (result.matches.length === 0) return;
    if (result.replacement) {
      const buffer = this.editor.buffer.slice(0, span.start) + result.replacement + this.editor.buffer.slice(span.end);
      this.editor = { ...this.editor, buffer, cursor: span.start + result.replacement.length };
      this.renderPrompt();
      return;
    }
    this.io.stdout.write(`\n${renderCompletionList(result.matches.slice(0, MAX_OPTIONS), this.theme)}\n`);
    this.renderPrompt();
  }

  /* ---------------------------------------------------------------- *
   * Turn
   * ---------------------------------------------------------------- */

  private async handleInput(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed === "") return;

    const selection = this.pendingSelection;
    if (selection) {
      this.pendingSelection = undefined;
      if (/^\d+$/.test(trimmed)) {
        const choice = selection.options[Number(trimmed) - 1];
        if (!choice) {
          this.note(`No option ${trimmed}.`);
          return;
        }
        if (selection.kind === "model") await this.switchModel(choice);
        else await this.switchAgent(choice);
        return;
      }
    }

    if (trimmed.startsWith("/")) {
      await this.handleSlash(trimmed);
      return;
    }
    await this.runTurn(trimmed);
  }

  private async runTurn(prompt: string): Promise<void> {
    this.mode = "busy";
    this.lastAbort = 0;
    this.status = { ...this.status, busy: true, cancelling: false };
    this.startSpinner();
    try {
      const message = await this.runtime.agents.run({
        sessionId: this.session.id,
        prompt,
        agent: this.status.agent,
        model: this.modelRef(),
      });
      const turnUsage = usageOf(message.parts);
      if (turnUsage) {
        this.usage = this.usage ? accumulateUsage(this.usage, turnUsage) : turnUsage;
        this.status = { ...this.status, usage: this.usage };
      }
      if (message.error === "aborted") this.note("aborted");
      else if (message.error) this.io.stdout.write(`${renderError(message.error, this.theme)}\n`);
    } finally {
      this.stopSpinner();
      this.status = { ...this.status, busy: false, cancelling: false };
      const session = await this.runtime.sessions.get(this.session.id).catch(() => undefined);
      if (session) {
        this.session = session;
        this.status = { ...this.status, model: `${session.model.provider}/${session.model.model}` };
      }
    }
  }

  private modelRef(): ModelRef | undefined {
    if (!this.modelKey) return undefined;
    return this.runtime.providers.resolveModel(this.modelKey);
  }

  /* ---------------------------------------------------------------- *
   * Slash commands
   * ---------------------------------------------------------------- */

  private async handleSlash(line: string): Promise<void> {
    const [rawName, ...rest] = line.slice(1).split(/\s+/);
    const name = `/${rawName ?? ""}`;
    const argument = rest.join(" ").trim();
    switch (name) {
      case "/help":
        this.printHelp();
        return;
      case "/exit":
      case "/quit":
        this.exitRequested = true;
        return;
      case "/clear":
        this.clearScreen();
        return;
      case "/new":
        await this.newSession();
        return;
      case "/model":
        await this.modelCommand(argument);
        return;
      case "/agent":
        await this.agentCommand(argument);
        return;
      case "/sessions":
        await this.sessionsCommand();
        return;
      case "/resume":
        await this.resumeCommand(argument);
        return;
      case "/mcp":
        this.mcpCommand();
        return;
      case "/skills":
        this.skillsCommand();
        return;
      case "/agents":
        this.agentsCommand();
        return;
      case "/init":
        await this.initCommand();
        return;
      case "/compact":
        await this.compactCommand();
        return;
      default:
        this.note(`Unknown command ${name}. Try /help.`);
    }
  }

  private printHelp(): void {
    const width = Math.max(...SLASH_COMMANDS.map((command) => command.name.length)) + 2;
    const lines = SLASH_COMMANDS.map(
      (command) =>
        `  ${this.theme.paint(command.name.padEnd(width), "accentDim")}${this.theme.paint(command.description, "textMuted")}`,
    );
    this.io.stdout.write(`\n${lines.join("\n")}\n`);
    this.io.stdout.write(`${this.theme.dim("  @path mentions complete with Tab; plain text starts a turn.")}\n`);
  }

  private clearScreen(): void {
    this.io.stdout.write("\u001b[2J\u001b[3J\u001b[1;1H");
    this.io.stdout.write(`${this.renderBannerText()}\n\n`);
  }

  private async newSession(): Promise<void> {
    this.session = await this.runtime.agents.createSession({
      cwd: this.session.cwd,
      agent: this.status.agent,
      model: this.modelKey,
    });
    this.files = walkFiles(this.session.cwd);
    this.usage = undefined;
    this.status = {
      agent: this.session.agent,
      model: `${this.session.model.provider}/${this.session.model.model}`,
      cwd: this.session.cwd,
    };
    this.note(`new session ${this.session.id.slice(0, 8)}`);
  }

  private modelOptions(): string[] {
    return this.runtime.providers
      .list()
      .flatMap((provider) => this.runtime.providers.models(provider.id).map((model) => `${provider.id}/${model.id}`))
      .slice(0, MAX_OPTIONS);
  }

  private async modelCommand(argument: string): Promise<void> {
    if (!argument) {
      const options = this.modelOptions();
      if (options.length === 0) {
        this.note("No models are configured.");
        return;
      }
      this.printOptions("model", options, this.status.model);
      return;
    }
    await this.switchModel(argument);
  }

  private async switchModel(key: string): Promise<void> {
    const ref = this.runtime.providers.resolveModel(key);
    if (!ref) {
      this.note(`Unknown model "${key}". Run /model to list them.`);
      return;
    }
    this.modelKey = `${ref.provider}/${ref.model}`;
    this.session.model = ref;
    await this.runtime.sessions.save(this.session).catch(() => undefined);
    this.status = { ...this.status, model: this.modelKey };
    this.note(`model → ${this.modelKey}`);
  }

  private agentOptions(): string[] {
    return this.runtime.agents
      .agents()
      .filter((agent) => agent.mode === "primary")
      .map((agent) => agent.name)
      .slice(0, MAX_OPTIONS);
  }

  private async agentCommand(argument: string): Promise<void> {
    if (!argument) {
      const options = this.agentOptions();
      if (options.length === 0) {
        this.note("No primary agents are defined.");
        return;
      }
      this.printOptions("agent", options, this.status.agent);
      return;
    }
    await this.switchAgent(argument);
  }

  private async switchAgent(name: string): Promise<void> {
    const definition = this.runtime.agents.getAgent(name);
    if (!definition) {
      this.note(`Unknown agent "${name}". Run /agent to list them.`);
      return;
    }
    this.runtime.agents.setAgent(this.session.id, definition.name);
    this.session.agent = definition.name;
    await this.runtime.sessions.save(this.session).catch(() => undefined);
    this.status = { ...this.status, agent: definition.name };
    const note = definition.name === "plan" ? "plan → read-only: writes are blocked" : `${definition.name} agent`;
    this.note(note);
  }

  /** Numbered, transcript-rendered picker; the next number selects. */
  private printOptions(kind: "model" | "agent", options: string[], current: string): void {
    this.pendingSelection = { kind, options };
    this.io.stdout.write(`\n${this.theme.dim(`  Select a ${kind}:`)}\n`);
    options.forEach((option, index) => {
      const marker = option === current ? this.theme.paint(" (current)", "accentDim") : "";
      this.io.stdout.write(
        `  ${this.theme.paint(String(index + 1).padStart(2), "accentDim")}  ${this.theme.paint(option, option === current ? "accent" : "text")}${marker}\n`,
      );
    });
    this.note(`Reply with a number 1-${options.length}, or /${kind} <value>.`);
  }

  private async sessionsCommand(): Promise<void> {
    const sessions = (await this.runtime.sessions.list())
      .filter((session) => !(session.tags ?? []).includes("subagent"))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_OPTIONS);
    if (sessions.length === 0) {
      this.note("No saved sessions.");
      return;
    }
    const rows = sessions.map((session) => [
      session.id === this.session.id ? "▸" : " ",
      session.id.slice(0, 8),
      formatAge(session.updatedAt),
      session.title,
    ]);
    this.io.stdout.write(`\n${renderTable(["", "ID", "UPDATED", "TITLE"], rows, this.theme)}\n`);
    this.note("/resume <id> switches session.");
  }

  private async resumeCommand(argument: string): Promise<void> {
    if (!argument) {
      this.note("Which session? Run /sessions for ids.");
      return;
    }
    const session = await resolveSession(this.runtime, { session: argument });
    if (!session) return;
    this.session = session;
    this.usage = session.usage;
    this.modelKey = undefined;
    this.files = walkFiles(session.cwd);
    this.status = {
      agent: session.agent,
      model: `${session.model.provider}/${session.model.model}`,
      cwd: session.cwd,
      usage: session.usage,
    };
    this.note(`resumed ${session.id.slice(0, 8)} — ${session.title}`);
  }

  private mcpCommand(): void {
    const servers = this.runtime.mcp.status();
    if (servers.length === 0) {
      this.note("No MCP servers configured.");
      return;
    }
    const rows = servers.map((server) => [
      server.server,
      server.status,
      String(server.toolCount),
      server.error ?? "",
    ]);
    this.io.stdout.write(`\n${renderTable(["SERVER", "STATUS", "TOOLS", "NOTE"], rows, this.theme)}\n`);
  }

  private skillsCommand(): void {
    const skills = this.runtime.skills.list();
    if (skills.length === 0) {
      this.note("No skills found.");
      return;
    }
    const rows = skills.map((skill) => [skill.name, skill.description]);
    this.io.stdout.write(`\n${renderTable(["SKILL", "DESCRIPTION"], rows, this.theme)}\n`);
  }

  private agentsCommand(): void {
    const rows = this.runtime.agents.agents().map((agent) => [
      agent.name === this.status.agent ? "▸" : " ",
      agent.name,
      agent.mode,
      agent.description,
    ]);
    this.io.stdout.write(`\n${renderTable(["", "NAME", "MODE", "DESCRIPTION"], rows, this.theme)}\n`);
  }

  private async initCommand(): Promise<void> {
    try {
      const result = await initProject({ cwd: this.session.cwd });
      for (const path of result.created) this.note(`created ${path}`);
    } catch (error) {
      this.note(error instanceof KortivError ? `${error.message} ${error.hint ?? ""}`.trim() : errorMessage(error));
    }
  }

  /**
   * Client-side compaction: dropped messages keep their place in the log but
   * lose their parts, so they stop consuming the model's context window.
   */
  private async compactCommand(): Promise<void> {
    const keep = 8;
    const messages = await this.runtime.sessions.messages(this.session.id);
    if (messages.length <= keep + 1) {
      this.note("Nothing to compact.");
      return;
    }
    const dropped = messages.slice(0, messages.length - keep);
    const digest = dropped
      .slice(-12)
      .map((message) => `- ${message.role}: ${textOf(message.parts).replace(/\s+/g, " ").slice(0, 80)}`)
      .join("\n");
    const target = dropped.find((message) => message.role === "user") ?? dropped[0]!;
    target.parts = [
      {
        type: "text",
        id: `${target.id}-digest`,
        text: `[compacted ${dropped.length} earlier messages]\n${digest}`,
      },
    ];
    for (const message of dropped) {
      if (message !== target) message.parts = [];
      await this.runtime.sessions.update(this.session.id, message);
    }
    await this.runtime.sessions.update(this.session.id, target);
    this.note(`compacted ${dropped.length} messages — kept the last ${keep}`);
  }

  /* ---------------------------------------------------------------- *
   * Permissions, chrome, spinner
   * ---------------------------------------------------------------- */

  private askPermission(request: PermissionRequest): Promise<PermissionDecision> {
    return new Promise<PermissionDecision>((resolve) => {
      this.stopSpinnerLine();
      this.mode = "permission";
      this.transcript.notePermissionShown(request);
      this.permissionResolve = (decision) => resolve(decision);
      this.io.stdout.write(`\n${renderPermissionBox(request, this.theme)}\n`);
      this.io.stdout.write(
        `  ${renderPermissionPrompt(this.theme)} ${this.theme.paint(this.theme.glyphs.prompt, "accent")} `,
      );
    });
  }

  private onEvent(event: AgentEvent): void {
    if (this.spinner) this.io.stdout.write(CLEAR_LINE);
    this.transcript.handle(event);
  }

  private startSpinner(): void {
    if (this.runtime.config.ui?.animations === false) return;
    this.spinnerFrame = 0;
    const tick = () => {
      const frames = this.theme.glyphs.spinner;
      const frame = frames[this.spinnerFrame % frames.length]!;
      this.spinnerFrame += 1;
      this.io.stdout.write(`${CLEAR_LINE}  ${this.theme.paint(frame, "accent")} ${renderStatusLine(this.status, this.theme).trim()}`);
    };
    tick();
    this.spinner = setInterval(tick, 100);
    this.spinner.unref?.();
  }

  private stopSpinnerLine(): void {
    if (this.spinner) this.io.stdout.write(CLEAR_LINE);
  }

  private stopSpinner(): void {
    if (this.spinner) {
      clearInterval(this.spinner);
      this.spinner = undefined;
      this.io.stdout.write(CLEAR_LINE);
    }
  }

  private note(text: string): void {
    this.io.stdout.write(`  ${this.theme.paint(this.theme.glyphs.dot, "textFaint")} ${this.theme.dim(text)}\n`);
  }

  private async printSummary(): Promise<void> {
    try {
      const messages = await this.runtime.sessions.messages(this.session.id);
      this.io.stdout.write(
        `\n${renderSessionSummary(
          { sessionId: this.session.id, messages: messages.length, usage: this.usage ?? this.session.usage },
          this.theme,
        )}\n`,
      );
    } catch {
      // The store may already be closed; the summary is not worth failing on.
    }
  }
}

/** Slides a window along the line so the cursor stays visible. */
function visibleWindow(buffer: string, cursor: number, room: number): { text: string; cursor: number } {
  if (displayWidth(buffer) <= room) return { text: buffer, cursor };
  let start = cursor;
  let used = 0;
  while (start > 0) {
    const width = displayWidth(buffer[start - 1]!);
    if (used + width > room - 2) break;
    used += width;
    start -= 1;
  }
  let end = cursor;
  used = displayWidth(buffer.slice(start, cursor));
  while (end < buffer.length) {
    const width = displayWidth(buffer[end]!);
    if (used + width > room) break;
    used += width;
    end += 1;
  }
  return { text: buffer.slice(start, end), cursor: cursor - start };
}

function version(): string {
  try {
    const url = new URL("../../../package.json", import.meta.url);
    const parsed = JSON.parse(require("node:fs").readFileSync(url, "utf8")) as { version?: string };
    return parsed.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
