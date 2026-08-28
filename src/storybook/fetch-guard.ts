import { STORYBOOK_ALLOWED_FAKE_RESPONSES } from "./fixtures";

export const STORYBOOK_NETWORK_GUARD_PREFIX = "STORYBOOK_NETWORK_GUARD";

export interface StorybookFakeResponse {
  body: string;
  status?: number;
}

export type StorybookFakeResponseMap = Record<string, StorybookFakeResponse>;

type StorybookEventListener = EventListenerOrEventListenerObject | ((this: EventSource, event: MessageEvent) => void);

export function storybookRequestUrl(input: RequestInfo | URL): string {
  if (input instanceof Request) return input.url;
  if (input instanceof URL) return input.toString();
  return input;
}

export function createStorybookFetchGuard(
  allowed: StorybookFakeResponseMap = STORYBOOK_ALLOWED_FAKE_RESPONSES,
): typeof fetch {
  return async (input) => {
    const url = storybookRequestUrl(input);
    const path = new URL(url, "http://storybook.local").pathname;
    const response = allowed[path];
    if (!response) {
      throw new Error(`${STORYBOOK_NETWORK_GUARD_PREFIX}: unexpected request ${url}; use an explicit fake response`);
    }
    return new Response(response.body, {
      status: response.status ?? 200,
      headers: { "content-type": "application/json", "x-storybook-fake": "true" },
    });
  };
}

class StorybookEventSource extends EventTarget {
  static readonly CONNECTING = 0 as const;
  static readonly OPEN = 1 as const;
  static readonly CLOSED = 2 as const;
  readonly CONNECTING = 0 as const;
  readonly OPEN = 1 as const;
  readonly CLOSED = 2 as const;
  readonly url: string;
  readonly withCredentials = false;
  readonly readyState = 2;
  onopen: ((this: EventSource, event: Event) => void) | null = null;
  onmessage: ((this: EventSource, event: MessageEvent) => void) | null = null;
  onerror: ((this: EventSource, event: Event) => void) | null = null;

  constructor(url: string | URL, _eventSourceInitDict?: EventSourceInit) {
    super();
    this.url = url.toString();
  }

  close(): void {
    // Deliberately inert: stories must never open a live stream.
  }

  addEventListener<K extends keyof EventSourceEventMap>(type: K, listener: (this: EventSource, event: EventSourceEventMap[K]) => void, options?: boolean | AddEventListenerOptions): void;
  addEventListener(type: string, listener: (this: EventSource, event: MessageEvent) => void, options?: boolean | AddEventListenerOptions): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
  addEventListener(type: string, listener: StorybookEventListener, options?: boolean | AddEventListenerOptions): void {
    void type;
    void listener;
    void options;
  }

  removeEventListener<K extends keyof EventSourceEventMap>(type: K, listener: (this: EventSource, event: EventSourceEventMap[K]) => void, options?: boolean | EventListenerOptions): void;
  removeEventListener(type: string, listener: (this: EventSource, event: MessageEvent) => void, options?: boolean | EventListenerOptions): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void;
  removeEventListener(type: string, listener: StorybookEventListener, options?: boolean | EventListenerOptions): void {
    void type;
    void listener;
    void options;
  }
}

export function installStorybookFetchGuard(): () => void {
  const original = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  globalThis.fetch = createStorybookFetchGuard();
  globalThis.EventSource = StorybookEventSource;
  return () => {
    globalThis.fetch = original;
    globalThis.EventSource = originalEventSource;
  };
}
