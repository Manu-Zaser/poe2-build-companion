/**
 * Minimal MCP server protocol (JSON-RPC 2.0, one message per line over stdio) – no extra dependency.
 * Only what a tool server needs: initialize, ping, tools/list, tools/call. Pure, so it can be tested.
 */

export const PROTOCOL_VERSION = '2025-06-18';

export interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
  /** Changes something (default: only reads). */
  writes?: boolean;
  /** Runs the tool; the result becomes JSON text. Throw an Error with a message for the user/AI on failure. */
  run(args: Record<string, unknown>): Promise<unknown>;
}

export interface ServerInfo {
  name: string;
  version: string;
  instructions?: string;
}

type Json = Record<string, unknown>;
interface Request {
  jsonrpc: '2.0';
  id?: string | number | null;
  method?: string;
  params?: Json;
}

const reply = (id: Request['id'], result: unknown) => ({ jsonrpc: '2.0' as const, id: id ?? null, result });
const fail = (id: Request['id'], code: number, message: string) => ({ jsonrpc: '2.0' as const, id: id ?? null, error: { code, message } });

/**
 * Handles one incoming line. Returns the response object, or null for notifications (no id) and
 * responses from the client. Never throws.
 */
export async function handleMessage(line: string, info: ServerInfo, tools: Tool[]): Promise<object | null> {
  let msg: Request;
  try {
    msg = JSON.parse(line) as Request;
  } catch {
    return fail(null, -32700, 'Parse error');
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return fail(null, -32600, 'Invalid request');
  // Notifications (e.g. notifications/initialized) and responses get no answer.
  if (msg.id === undefined || typeof msg.method !== 'string') return null;

  switch (msg.method) {
    case 'initialize': {
      const asked = typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : PROTOCOL_VERSION;
      return reply(msg.id, {
        protocolVersion: asked,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: info.name, version: info.version },
        ...(info.instructions ? { instructions: info.instructions } : {}),
      });
    }
    case 'ping':
      return reply(msg.id, {});
    case 'tools/list':
      return reply(msg.id, {
        tools: tools.map(({ name, title, description, inputSchema, writes }) => ({
          name,
          title,
          description,
          inputSchema,
          annotations: writes ? { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } : { readOnlyHint: true, openWorldHint: false },
        })),
      });
    case 'tools/call': {
      const name = msg.params?.name;
      const tool = tools.find((t) => t.name === name);
      if (!tool) return fail(msg.id, -32602, `Unknown tool: ${String(name)}`);
      const args = (msg.params?.arguments && typeof msg.params.arguments === 'object' ? msg.params.arguments : {}) as Record<string, unknown>;
      for (const req of tool.inputSchema.required ?? []) {
        if (args[req] === undefined || args[req] === '') return reply(msg.id, toolError(`Missing argument: ${req}`));
      }
      try {
        const result = await tool.run(args);
        return reply(msg.id, { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }], isError: false });
      } catch (err) {
        return reply(msg.id, toolError(err instanceof Error ? err.message : String(err)));
      }
    }
    default:
      return fail(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

/** Tool errors go back as a normal result with isError, so the AI can read and explain them. */
function toolError(message: string) {
  return { content: [{ type: 'text', text: message }], isError: true };
}
