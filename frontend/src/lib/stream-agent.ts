/**
 * Reads the agent's Server-Sent Events stream.
 *
 * EventSource is not usable here: it only issues GETs, and the request carries
 * a JSON body. So this is fetch + a ReadableStream reader, which also gives us
 * an AbortController for cancellation — worth having, because a thinking-mode
 * reply can run for minutes and the user may well change their mind.
 */

export type AgentStreamEvent =
  | { type: "start"; trace_id?: string; model?: string; provider?: string }
  | { type: "reasoning"; delta: string }
  | { type: "content"; delta: string }
  | { type: "error"; error: string }
  | {
      type: "done";
      trace_id?: string;
      provider?: string;
      model?: string;
      content?: string;
      reasoning?: string;
      latency_ms?: number;
      token_usage?: Record<string, number>;
    };

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8090/api/v1";

export interface StreamAgentOptions {
  message: string;
  modelMode?: "fast" | "thinking";
  model?: string;
  provider?: string;
  project?: unknown;
  signal?: AbortSignal;
  onEvent: (event: AgentStreamEvent) => void;
}

export async function streamAgentReply({
  message,
  modelMode = "fast",
  model,
  provider,
  project,
  signal,
  onEvent,
}: StreamAgentOptions): Promise<void> {
  const response = await fetch(`${API_BASE}/ai/chat/stream`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-stackpilot-CSRF": "1",
    },
    body: JSON.stringify({
      message,
      model_mode: modelMode,
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
      ...(project ? { project } : {}),
    }),
    signal,
  });

  if (!response.ok) {
    // The error arrives as normal JSON, because the stream never opened.
    let detail = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      detail = body?.error || detail;
    } catch {
      // Keep the status line.
    }
    throw new Error(detail);
  }
  if (!response.body) {
    throw new Error("This browser did not provide a readable response stream.");
  }

  const reader = response.body.getReader();
  // stream: true matters — a multi-byte character can be split across two
  // network reads, and decoding each read independently would corrupt it.
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Frames are separated by a blank line. Anything after the last complete
      // separator is a partial frame and stays in the buffer.
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data) continue;
          try {
            onEvent(JSON.parse(data) as AgentStreamEvent);
          } catch {
            // A malformed frame should not kill a stream that is otherwise
            // producing a good answer.
          }
        }
      }
    }
  } finally {
    // Releasing the lock lets the connection be torn down promptly on abort,
    // rather than lingering until GC.
    reader.releaseLock();
  }
}
