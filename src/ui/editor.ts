/**
 * Pure line-editor reducer.
 *
 * Key events are plain data and every editing rule lives here, so the whole
 * interaction surface is testable without a TTY. No I/O, no timers, no
 * process access — see input.ts for the byte decoder and cmd/tui.ts for the
 * shell that drives this.
 */

export type EditorKeyName =
  | "left"
  | "right"
  | "up"
  | "down"
  | "home"
  | "end"
  | "backspace"
  | "delete"
  | "enter"
  | "tab"
  | "escape"
  | "ctrl-a"
  | "ctrl-c"
  | "ctrl-d"
  | "ctrl-e"
  | "ctrl-k"
  | "ctrl-l"
  | "ctrl-u"
  | "ctrl-w"
  | "text";

export interface EditorKey {
  name: EditorKeyName;
  text?: string;
}

export interface EditorState {
  buffer: string;
  cursor: number;
  history: string[];
  /** -1 while editing a fresh line, otherwise an index into `history`. */
  historyIndex: number;
  /** The line being edited when history navigation started. */
  draft: string;
  /** Consecutive Ctrl+C presses; any other key resets it. */
  interrupts: number;
}

export interface EditorResult {
  state: EditorState;
  /** Present when Enter submitted a non-empty line. */
  submitted?: string;
  exit?: boolean;
  /** Ctrl+C on a non-empty line, or a first idle Ctrl+C. */
  cancelled?: boolean;
  /** False when the screen does not need to be repainted. */
  redraw?: boolean;
}

export function createEditorState(init: Partial<Pick<EditorState, "buffer" | "history">> = {}): EditorState {
  const buffer = init.buffer ?? "";
  return {
    buffer,
    cursor: buffer.length,
    history: [...(init.history ?? [])],
    historyIndex: -1,
    draft: "",
    interrupts: 0,
  };
}

function idle(state: EditorState, extra: Partial<EditorResult> = {}): EditorResult {
  return { state: { ...state, interrupts: 0 }, ...extra };
}

function move(state: EditorState, cursor: number): EditorResult {
  return cursor === state.cursor
    ? { state: { ...state, interrupts: 0 }, redraw: false }
    : { state: { ...state, cursor, interrupts: 0 }, redraw: true };
}

function setBuffer(state: EditorState, buffer: string, cursor = buffer.length): EditorResult {
  return { state: { ...state, buffer, cursor, interrupts: 0 }, redraw: true };
}

function wordStart(buffer: string, cursor: number): number {
  let index = cursor;
  while (index > 0 && /\s/.test(buffer[index - 1]!)) index -= 1;
  while (index > 0 && !/\s/.test(buffer[index - 1]!)) index -= 1;
  return index;
}

export function reduceEditor(state: EditorState, key: EditorKey): EditorResult {
  switch (key.name) {
    case "text": {
      const text = key.text ?? "";
      if (!text) return idle(state);
      return setBuffer(
        state,
        state.buffer.slice(0, state.cursor) + text + state.buffer.slice(state.cursor),
        state.cursor + text.length,
      );
    }

    case "left":
      return move(state, Math.max(0, state.cursor - 1));
    case "right":
      return move(state, Math.min(state.buffer.length, state.cursor + 1));
    case "home":
    case "ctrl-a":
      return move(state, 0);
    case "end":
    case "ctrl-e":
      return move(state, state.buffer.length);

    case "backspace":
      if (state.cursor === 0) return idle(state, { redraw: false });
      return setBuffer(state, state.buffer.slice(0, state.cursor - 1) + state.buffer.slice(state.cursor), state.cursor - 1);
    case "delete":
      if (state.cursor >= state.buffer.length) return idle(state, { redraw: false });
      return setBuffer(state, state.buffer.slice(0, state.cursor) + state.buffer.slice(state.cursor + 1));

    case "ctrl-u":
      return state.cursor === 0 ? idle(state, { redraw: false }) : setBuffer(state, state.buffer.slice(state.cursor), 0);
    case "ctrl-k":
      return state.cursor >= state.buffer.length
        ? idle(state, { redraw: false })
        : setBuffer(state, state.buffer.slice(0, state.cursor));
    case "ctrl-w": {
      if (state.cursor === 0) return idle(state, { redraw: false });
      const start = wordStart(state.buffer, state.cursor);
      return setBuffer(state, state.buffer.slice(0, start) + state.buffer.slice(state.cursor), start);
    }

    case "up": {
      if (state.history.length === 0) return idle(state, { redraw: false });
      const goingBack = state.historyIndex === -1;
      const index = goingBack ? state.history.length - 1 : Math.max(0, state.historyIndex - 1);
      const next: EditorState = {
        ...state,
        historyIndex: index,
        draft: goingBack ? state.buffer : state.draft,
        buffer: state.history[index] ?? "",
        interrupts: 0,
      };
      next.cursor = next.buffer.length;
      return { state: next, redraw: true };
    }
    case "down": {
      if (state.historyIndex === -1) return idle(state, { redraw: false });
      if (state.historyIndex >= state.history.length - 1) {
        const next: EditorState = { ...state, historyIndex: -1, buffer: state.draft, interrupts: 0 };
        next.cursor = next.buffer.length;
        return { state: next, redraw: true };
      }
      const next: EditorState = {
        ...state,
        historyIndex: state.historyIndex + 1,
        buffer: state.history[state.historyIndex + 1] ?? "",
        interrupts: 0,
      };
      next.cursor = next.buffer.length;
      return { state: next, redraw: true };
    }

    case "enter": {
      const submitted = state.buffer.trim();
      const history =
        submitted && state.history[state.history.length - 1] !== state.buffer
          ? [...state.history, state.buffer]
          : state.history;
      const next: EditorState = {
        buffer: "",
        cursor: 0,
        history,
        historyIndex: -1,
        draft: "",
        interrupts: 0,
      };
      return submitted ? { state: next, submitted: state.buffer, redraw: true } : { state: next, redraw: true };
    }

    case "ctrl-c": {
      if (state.buffer.length > 0) {
        return {
          state: { ...state, buffer: "", cursor: 0, interrupts: state.interrupts + 1 },
          cancelled: true,
          redraw: true,
        };
      }
      if (state.interrupts >= 1) {
        return { state: { ...state, interrupts: state.interrupts + 1 }, exit: true, redraw: false };
      }
      return {
        state: { ...state, interrupts: state.interrupts + 1 },
        cancelled: true,
        redraw: false,
      };
    }

    case "ctrl-d":
      if (state.buffer.length === 0) return { state, exit: true, redraw: false };
      return setBuffer(state, state.buffer.slice(0, state.cursor) + state.buffer.slice(state.cursor + 1));

    case "ctrl-l":
      return idle(state, { redraw: true });
    case "tab":
    case "escape":
      return idle(state, { redraw: false });
    default:
      return idle(state, { redraw: false });
  }
}
