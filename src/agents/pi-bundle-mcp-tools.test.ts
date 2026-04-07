import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { writeBundleProbeMcpServer, writeClaudeBundle } from "./bundle-mcp.test-harness.js";
import { createBundleMcpToolRuntime } from "./pi-bundle-mcp-tools.js";

const tempDirs: string[] = [];
const cleanupCallbacks: Array<() => Promise<void>> = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(cleanupCallbacks.splice(0, cleanupCallbacks.length).map((cb) => cb()));
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function startHttpProbeServer(responseText: string): Promise<string> {
  const mcpServer = new McpServer({ name: "http-probe", version: "1.0.0" });
  mcpServer.tool("bundle_probe", "Bundle MCP probe", async () => ({
    content: [{ type: "text", text: responseText }],
  }));

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await mcpServer.connect(transport);

  const server = http.createServer(async (req, res) => {
    if (!(req.url ?? "").startsWith("/mcp")) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    await transport.handleRequest(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  cleanupCallbacks.push(async () => {
    await transport.close().catch(() => {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected HTTP MCP server to bind to an ephemeral port");
  }
  return `http://127.0.0.1:${address.port}/mcp`;
}

async function createBundledRuntime(options?: { reservedToolNames?: string[] }) {
  const workspaceDir = await makeTempDir("openclaw-bundle-mcp-tools-");
  const pluginRoot = path.join(workspaceDir, ".openclaw", "extensions", "bundle-probe");
  const serverScriptPath = path.join(pluginRoot, "servers", "bundle-probe.mjs");
  await writeBundleProbeMcpServer(serverScriptPath);
  await writeClaudeBundle({ pluginRoot, serverScriptPath });

  return createBundleMcpToolRuntime({
    workspaceDir,
    cfg: {
      plugins: {
        entries: {
          "bundle-probe": { enabled: true },
        },
      },
    },
    reservedToolNames: options?.reservedToolNames,
  });
}

describe("createBundleMcpToolRuntime", () => {
  it("loads bundle MCP tools and executes them", async () => {
    const runtime = await createBundledRuntime();

    try {
      expect(runtime.tools.map((tool) => tool.name)).toEqual(["bundle_probe"]);
      const result = await runtime.tools[0].execute("call-bundle-probe", {}, undefined, undefined);
      expect(result.content[0]).toMatchObject({
        type: "text",
        text: "FROM-BUNDLE",
      });
      expect(result.details).toEqual({
        mcpServer: "bundleProbe",
        mcpTool: "bundle_probe",
      });
    } finally {
      await runtime.dispose();
    }
  });

  it("skips bundle MCP tools that collide with existing tool names", async () => {
    const runtime = await createBundledRuntime({ reservedToolNames: ["bundle_probe"] });

    try {
      expect(runtime.tools).toEqual([]);
    } finally {
      await runtime.dispose();
    }
  });

  it("loads configured stdio MCP tools without a bundle", async () => {
    const workspaceDir = await makeTempDir("openclaw-bundle-mcp-tools-");
    const serverScriptPath = path.join(workspaceDir, "servers", "configured-probe.mjs");
    await writeBundleProbeMcpServer(serverScriptPath);

    const runtime = await createBundleMcpToolRuntime({
      workspaceDir,
      cfg: {
        mcp: {
          servers: {
            configuredProbe: {
              command: "node",
              args: [serverScriptPath],
              env: {
                BUNDLE_PROBE_TEXT: "FROM-CONFIG",
              },
            },
          },
        },
      },
    });

    try {
      expect(runtime.tools.map((tool) => tool.name)).toEqual(["bundle_probe"]);
      const result = await runtime.tools[0].execute(
        "call-configured-probe",
        {},
        undefined,
        undefined,
      );
      expect(result.content[0]).toMatchObject({
        type: "text",
        text: "FROM-CONFIG",
      });
      expect(result.details).toEqual({
        mcpServer: "configuredProbe",
        mcpTool: "bundle_probe",
      });
    } finally {
      await runtime.dispose();
    }
  });

  it("loads configured HTTP MCP tools without a bundle", async () => {
    const workspaceDir = await makeTempDir("openclaw-bundle-mcp-tools-");
    const serverUrl = await startHttpProbeServer("FROM-HTTP");

    const runtime = await createBundleMcpToolRuntime({
      workspaceDir,
      cfg: {
        mcp: {
          servers: {
            configuredProbe: {
              url: serverUrl,
            },
          },
        },
      },
    });

    try {
      expect(runtime.tools.map((tool) => tool.name)).toEqual(["bundle_probe"]);
      const result = await runtime.tools[0].execute(
        "call-http-configured-probe",
        {},
        undefined,
        undefined,
      );
      expect(result.content[0]).toMatchObject({
        type: "text",
        text: "FROM-HTTP",
      });
      expect(result.details).toEqual({
        mcpServer: "configuredProbe",
        mcpTool: "bundle_probe",
      });
    } finally {
      await runtime.dispose();
    }
  });
});
