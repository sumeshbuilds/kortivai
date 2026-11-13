/** The only output channel a renderer may use. */
export interface Sink {
  write(text: string): void;
}

export interface BufferSink extends Sink {
  text(): string;
  clear(): void;
}

/** Collects output in memory; used by tests and by pure whole-turn renders. */
export function bufferSink(): BufferSink {
  let buffer = "";
  return {
    write: (text) => {
      buffer += text;
    },
    text: () => buffer,
    clear: () => {
      buffer = "";
    },
  };
}
