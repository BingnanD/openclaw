import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

type StdioMcpServerLaunchConfig = {
  kind: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
};

type HttpMcpServerLaunchConfig = {
  kind: "http";
  url: URL;
};

type McpServerLaunchConfig = StdioMcpServerLaunchConfig | HttpMcpServerLaunchConfig;

type McpServerLaunchResult =
  | { ok: true; config: McpServerLaunchConfig }
  | { ok: false; reason: string };

type McpTransportSession = {
  transport: Transport & { close(): Promise<void> };
  description: string;
  stderr?: NodeJS.ReadableStream;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value)
    .map(([key, entry]) => {
      if (typeof entry === "string") {
        return [key, entry] as const;
      }
      if (typeof entry === "number" || typeof entry === "boolean") {
        return [key, String(entry)] as const;
      }
      return null;
    })
    .filter((entry): entry is readonly [string, string] => entry !== null);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries = value.filter((entry): entry is string => typeof entry === "string");
  return entries.length > 0 ? entries : [];
}

export function resolveMcpServerLaunchConfig(raw: unknown): McpServerLaunchResult {
  if (!isRecord(raw)) {
    return { ok: false, reason: "server config must be an object" };
  }

  if (typeof raw.command === "string" && raw.command.trim().length > 0) {
    const cwd =
      typeof raw.cwd === "string" && raw.cwd.trim().length > 0
        ? raw.cwd
        : typeof raw.workingDirectory === "string" && raw.workingDirectory.trim().length > 0
          ? raw.workingDirectory
          : undefined;
    return {
      ok: true,
      config: {
        kind: "stdio",
        command: raw.command,
        args: toStringArray(raw.args),
        env: toStringRecord(raw.env),
        cwd,
      },
    };
  }

  if (typeof raw.url === "string" && raw.url.trim().length > 0) {
    try {
      const url = new URL(raw.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return { ok: false, reason: "MCP server url must use http or https" };
      }
      return {
        ok: true,
        config: {
          kind: "http",
          url,
        },
      };
    } catch {
      return { ok: false, reason: "MCP server url is invalid" };
    }
  }

  return { ok: false, reason: "its command or url is missing" };
}

export function describeMcpServerLaunchConfig(config: McpServerLaunchConfig): string {
  if (config.kind === "http") {
    return config.url.toString();
  }
  const args =
    Array.isArray(config.args) && config.args.length > 0 ? ` ${config.args.join(" ")}` : "";
  const cwd = config.cwd ? ` (cwd=${config.cwd})` : "";
  return `${config.command}${args}${cwd}`;
}

function isLegacySseFallbackCandidate(error: unknown): boolean {
  return (
    error instanceof StreamableHTTPError && typeof error.code === "number" && error.code >= 400
  );
}

export async function connectClientToMcpServer(params: {
  client: Client;
  config: McpServerLaunchConfig;
}): Promise<McpTransportSession> {
  if (params.config.kind === "stdio") {
    const transport = new StdioClientTransport({
      command: params.config.command,
      args: params.config.args,
      env: params.config.env,
      cwd: params.config.cwd,
      stderr: "pipe",
    });
    await params.client.connect(transport);
    return {
      transport,
      description: describeMcpServerLaunchConfig(params.config),
    };
  }

  const streamableTransport = new StreamableHTTPClientTransport(params.config.url);
  try {
    await params.client.connect(streamableTransport);
    return {
      transport: streamableTransport,
      description: describeMcpServerLaunchConfig(params.config),
    };
  } catch (error) {
    await streamableTransport.close().catch(() => {});
    if (!isLegacySseFallbackCandidate(error)) {
      throw error;
    }
  }

  const sseTransport = new SSEClientTransport(params.config.url);
  await params.client.connect(sseTransport);
  return {
    transport: sseTransport,
    description: `${describeMcpServerLaunchConfig(params.config)} (legacy-sse)`,
  };
}

export type { McpServerLaunchConfig, McpServerLaunchResult, McpTransportSession };
