import type { AgentEvent, EventBus, Unsubscribe } from "./types.ts";

/**
 * Minimal synchronous fan-out bus. Listeners are isolated: a throwing
 * listener cannot break the agent loop or starve the other listeners.
 */
export function createEventBus(onListenerError?: (error: unknown) => void): EventBus {
  const listeners = new Set<(event: AgentEvent) => void>();

  return {
    emit(event) {
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch (error) {
          onListenerError?.(error);
        }
      }
    },
    subscribe(listener): Unsubscribe {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
