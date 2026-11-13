/**
 * The only module that reads raw stdin.
 *
 * Decodes bytes and escape sequences into {@link EditorKey} events and owns
 * terminal state: raw mode and cursor visibility are restored on stop, on
 * error, and on process exit. In raw mode Ctrl+C is a key event, never a
 * signal, so a running turn can be cancelled without killing the process.
 */
import type { EditorKey, EditorKeyName } from "./editor.ts";
import type { Sink } from "./sink.ts";

const ESC = "\u001b";

const CSI_KEYS: Array<[string, EditorKeyName]> = [
  [`${ESC}[A`, "up"],
  [`${ESC}[B`, "down"],
  [`${ESC}[C`, "right"],
  [`${ESC}[D`, "left"],
  [`${ESC}[H`, "home"],
  [`${ESC}[F`, "end"],
  [`${ESC}[1~`, "home"],
  [`${ESC}[4~`, "end"],
  [`${ESC}[7~`, "home"],
  [`${ESC}[8~`, "end"],
  [`${ESC}[3~`, "delete"],
  [`${ESC}[1;5C`, "right"],
  [`${ESC}[1;5D`, "left"],
  [`${ESC}[1;5A`, "up"],
  [`${ESC}[1;5B`, "down"],
  [`${ESC}OA`, "up"],
  [`${ESC}OB`, "down"],
  [`${ESC}OC`, "right"],
  [`${ESC}OD`, "left"],
  [`${ESC}OH`, "home"],
  [`${ESC}OF`, "end"],
];

const IGNORED = [`${ESC}[200~`, `${ESC}[201~`, `${ESC}[Z`];

const CSI_PATTERN = /^\u001b\[[0-9;?]*[A-Za-z~]/;

export interface KeyDecoder {
  push(chunk: string): EditorKey[];
  /** Emits anything still held back (a lone ESC, a truncated sequence). */
  flush(): EditorKey[];
}

export function createKeyDecoder(): KeyDecoder {
  let pending = "";

  const decode = (input: string, final: boolean): EditorKey[] => {
    const events: EditorKey[] = [];
    let text = "";
    const flushText = () => {
      if (text) {
        events.push({ name: "text", text });
        text = "";
      }
    };

    let index = 0;
    while (index < input.length) {
      const codePoint = input.codePointAt(index)!;
      const char = String.fromCodePoint(codePoint);
      const size = char.length;

      if (char === ESC) {
        const rest = input.slice(index);
        const known = CSI_KEYS.find(([sequence]) => rest.startsWith(sequence));
        if (known) {
          flushText();
          events.push({ name: known[1] });
          index += known[0].length;
          continue;
        }
        const ignored = IGNORED.find((sequence) => rest.startsWith(sequence));
        if (ignored) {
          index += ignored.length;
          continue;
        }
        const csi = CSI_PATTERN.exec(rest);
        if (csi) {
          flushText();
          events.push({ name: "escape" });
          index += csi[0].length;
          continue;
        }
        if (rest.length < 12 && !final) {
          pending = rest;
          break;
        }
        flushText();
        events.push({ name: "escape" });
        index += 1;
        continue;
      }

      index += size;
      switch (codePoint) {
        case 3:
          flushText();
          events.push({ name: "ctrl-c" });
          break;
        case 4:
          flushText();
          events.push({ name: "ctrl-d" });
          break;
        case 1:
          flushText();
          events.push({ name: "ctrl-a" });
          break;
        case 5:
          flushText();
          events.push({ name: "ctrl-e" });
          break;
        case 11:
          flushText();
          events.push({ name: "ctrl-k" });
          break;
        case 12:
          flushText();
          events.push({ name: "ctrl-l" });
          break;
        case 21:
          flushText();
          events.push({ name: "ctrl-u" });
          break;
        case 23:
          flushText();
          events.push({ name: "ctrl-w" });
          break;
        case 10:
        case 13:
          flushText();
          events.push({ name: "enter" });
          break;
        case 8:
        case 127:
          flushText();
          events.push({ name: "backspace" });
          break;
        case 9:
          flushText();
          events.push({ name: "tab" });
          break;
        default:
          if (codePoint >= 32) text += char;
          break;
      }
    }
    flushText();
    return events;
  };

  return {
    push(chunk: string): EditorKey[] {
      const input = pending + chunk;
      pending = "";
      return decode(input, false);
    },
    flush(): EditorKey[] {
      if (!pending) return [];
      const held = pending;
      pending = "";
      return decode(held, true);
    },
  };
}

/** Convenience for tests and one-shot chunks. */
export function decodeKeys(chunk: string): EditorKey[] {
  return createKeyDecoder().push(chunk);
}

export interface RawInputOptions {
  stdin?: NodeJS.ReadStream;
  stdout?: Sink;
  onKey: (key: EditorKey) => void;
  onError?: (error: unknown) => void;
}

const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;

export class RawInput {
  private readonly stdin: NodeJS.ReadStream;
  private readonly stdout: Sink | undefined;
  private readonly decoder = createKeyDecoder();
  private readonly onKey: (key: EditorKey) => void;
  private readonly onError: ((error: unknown) => void) | undefined;
  private started = false;
  private rawMode = false;
  private cursorHidden = false;

  private readonly handleData = (chunk: Buffer | string): void => {
    try {
      for (const key of this.decoder.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"))) {
        this.onKey(key);
      }
    } catch (error) {
      this.onError?.(error);
    }
  };

  private readonly restore = (): void => {
    this.stop();
  };

  private readonly onSignal = (): void => {
    this.stop();
    process.exit(130);
  };

  constructor(options: RawInputOptions) {
    this.stdin = options.stdin ?? process.stdin;
    this.stdout = options.stdout;
    this.onKey = options.onKey;
    this.onError = options.onError;
  }

  get active(): boolean {
    return this.started;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const stream = this.stdin;
    if (typeof stream.setRawMode === "function") {
      try {
        stream.setRawMode(true);
        this.rawMode = true;
      } catch {
        this.rawMode = false;
      }
    }
    stream.setEncoding?.("utf8");
    stream.on("data", this.handleData);
    stream.resume?.();
    process.once("exit", this.restore);
    process.once("SIGINT", this.onSignal);
    process.once("SIGTERM", this.onSignal);
    process.on("uncaughtExceptionMonitor", this.restore);
    process.on("unhandledRejection", this.restore);
  }

  stop(): void {
    if (!this.started) {
      this.showCursor();
      return;
    }
    this.started = false;
    const stream = this.stdin;
    stream.off("data", this.handleData);
    if (this.rawMode && typeof stream.setRawMode === "function") {
      try {
        stream.setRawMode(false);
      } catch {
        // The terminal is already gone; nothing left to restore.
      }
    }
    this.rawMode = false;
    process.off("exit", this.restore);
    process.off("SIGINT", this.onSignal);
    process.off("SIGTERM", this.onSignal);
    process.off("uncaughtExceptionMonitor", this.restore);
    process.off("unhandledRejection", this.restore);
    this.showCursor();
  }

  hideCursor(): void {
    if (this.cursorHidden) return;
    this.cursorHidden = true;
    this.stdout?.write(HIDE_CURSOR);
  }

  showCursor(): void {
    if (!this.cursorHidden) return;
    this.cursorHidden = false;
    this.stdout?.write(SHOW_CURSOR);
  }
}
