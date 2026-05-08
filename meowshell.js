#!/usr/bin/env node

/**
 * meowshell
 * ─────────────────────────────────────────────
 * Give any web-based MCP client shell access to your machine.
 * No SSH, no local setup required.
 *
 * Usage:
 *   MCP_TOKEN=mysecret MCP_PORT=8080 node meowshell.js
 *
 * Client config (paste into your MCP client):
 *   {
 *     "mcpServers": {
 *       "my-server": {
 *         "type": "url",
 *         "url": "http://yourserver:8080/mcp",
 *         "headers": {
 *           "Authorization": "Bearer mysecret"
 *         }
 *       }
 *     }
 *   }
 */

import http from "node:http";
import https from "node:https";
import net from "node:net";
import { readFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import { exec } from "node:child_process";
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// ────────────────────────────────────────────────
//  Constants
// ────────────────────────────────────────────────

const VERSION = "1.0.0";
const PORT_STATE_FILE = ".mcp_port";
const DEFAULT_PORT    = 13579;

// ────────────────────────────────────────────────
//  CLI flags — exit immediately without loading server
// ────────────────────────────────────────────────

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log(`meowshell v${VERSION}`);
  process.exit(0);
}

if (process.argv.includes("--health")) {
  console.log("Checking server health...");

  let port = DEFAULT_PORT;
  try {
    port = parseInt(readFileSync(PORT_STATE_FILE, "utf-8").trim(), 10) || DEFAULT_PORT;
  } catch { /* use default */ }

  http.get(`http://localhost:${port}/health`, (res) => {
    let data = "";
    res.on("data", (chunk) => (data += chunk));
    res.on("end", () => {
      try {
        const json = JSON.parse(data);
        console.log(`Status: ${json.status}`);
        console.log(`Version: ${json.version}`);
        process.exit(json.status === "ok" ? 0 : 1);
      } catch {
        console.log("Invalid response from server");
        process.exit(1);
      }
    });
  }).on("error", () => {
    console.log("Server not running");
    process.exit(1);
  });

  // Keep process alive until the callback above calls process.exit()
  // No more synchronous code runs after this point for --health.
  // Node will stay alive waiting for the HTTP callback to fire.
  // The rest of the module (below) is function definitions — safe.
}

// ────────────────────────────────────────────────
//  Port helpers
// ────────────────────────────────────────────────

async function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => {
      srv.close();
      resolve(true);
    });
  });
}

/**
 * Resolve port with two modes:
 * - LOCKED (explicit): MCP_PORT env var set → use exact port, fail if taken
 * - AUTO (first run): No env set → try saved port, scan if needed, save result
 */
async function resolvePort(explicitPort, savedPort) {
  // Mode 1: Explicit port set by user → LOCKED (fail if taken, no auto-fallback)
  if (explicitPort != null) {
    const free = await isPortFree(explicitPort);
    if (!free) {
      console.error(`FATAL: Port ${explicitPort} is already in use.`);
      console.error(`       Either free the port or choose a different one.`);
      process.exit(1);
    }
    // Save it for reference
    try { await writeFile(PORT_STATE_FILE, String(explicitPort), "utf-8"); } catch {}
    return explicitPort;
  }

  // Mode 2: No explicit port → AUTO (first run or restoring previous)
  // Try saved port first (stable across restarts)
  if (savedPort != null) {
    const free = await isPortFree(savedPort);
    if (free) {
      return savedPort;
    }
    // Saved port is taken — fall through to scan
  }

  // Scan for a free port (up to 100 attempts from default)
  const startAt = 13579;
  for (let i = 0; i < 100; i++) {
    const candidate = startAt + i;
    if (candidate > 65535) break;
    const free = await isPortFree(candidate);
    if (free) {
      // Save for next restart
      try { await writeFile(PORT_STATE_FILE, String(candidate), "utf-8"); } catch {}
      return candidate;
    }
  }

  console.error("FATAL: No free port found in range");
  process.exit(1);
}

// ────────────────────────────────────────────────
//  Auth
// ────────────────────────────────────────────────

let MCP_TOKEN = "";

function isAuthenticated(req) {
  const auth = req.headers["authorization"];
  return auth != null && auth === `Bearer ${MCP_TOKEN}`;
}

function sendStatus(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(payload);
}

// ────────────────────────────────────────────────
//  Path safety — prevent traversal outside WORKDIR
// ────────────────────────────────────────────────

function safeResolve(base, input) {
  const target = resolve(base, input);
  if (!target.startsWith(base)) {
    const err = new Error(`Path traversal denied: "${input}" resolves outside the working directory`);
    err.code = "TRAVERSAL";
    throw err;
  }
  return target;
}

// ────────────────────────────────────────────────
//  Tool definitions
// ────────────────────────────────────────────────

const TOOL_DEFINITIONS = [
  {
    name: "exec",
    description: "Execute a shell command on the server. Returns stdout, stderr, and exit code.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Shell command to execute",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read the full contents of a file as UTF-8 text.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file (relative to workdir or absolute within workdir)",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file. Creates parent directories automatically.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file (relative to workdir or absolute within workdir)",
        },
        content: {
          type: "string",
          description: "Text content to write",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "list_dir",
    description: "List files and directories inside a given path.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the directory (relative to workdir or absolute within workdir)",
        },
      },
      required: ["path"],
    },
  },
];

// ────────────────────────────────────────────────
//  Tool handlers
// ────────────────────────────────────────────────

let WORKDIR = process.cwd();
let TIMEOUT = 30000;

async function handleToolCall(name, args) {
  switch (name) {
    case "exec": {
      const { command } = args;
      return new Promise((resolvePromise) => {
        const child = exec(
          command,
          { cwd: WORKDIR, timeout: TIMEOUT, maxBuffer: 10 * 1024 * 1024 },
          (error, stdout, stderr) => {
            const content = [];
            if (stdout) content.push({ type: "text", text: stdout });
            if (stderr) content.push({ type: "text", text: stderr });

            if (error) {
              if (error.killed || error.signal === "SIGTERM") {
                content.push({
                  type: "text",
                  text: `\n[Command timed out after ${TIMEOUT}ms and was terminated]`,
                });
              }
              return resolvePromise({ content, isError: true });
            }

            resolvePromise({ content });
          },
        );
      });
    }

    case "read_file": {
      const targetPath = safeResolve(WORKDIR, args.path);
      const content = await readFile(targetPath, "utf-8");
      return { content: [{ type: "text", text: content }] };
    }

    case "write_file": {
      const targetPath = safeResolve(WORKDIR, args.path);
      const parentDir = resolve(targetPath, "..");
      await mkdir(parentDir, { recursive: true });
      await writeFile(targetPath, args.content, "utf-8");
      return {
        content: [{ type: "text", text: `File written: ${relative(WORKDIR, targetPath)}` }],
      };
    }

    case "list_dir": {
      const targetPath = safeResolve(WORKDIR, args.path);
      const entries = await readdir(targetPath, { withFileTypes: true });
      const listing = entries
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => `${e.name}${e.isDirectory() ? "/" : ""}`);
      return { content: [{ type: "text", text: listing.join("\n") }] };
    }

    default:
      throw new Error(`Unknown tool: "${name}"`);
  }
}

// ────────────────────────────────────────────────
//  Server startup (only if not running CLI flags)
// ────────────────────────────────────────────────

async function startServer() {
  // ── Config ──
  MCP_TOKEN = process.env.MCP_TOKEN;
  if (!MCP_TOKEN) {
    console.error("FATAL: MCP_TOKEN environment variable is required");
    process.exit(1);
  }

  const explicitPort = process.env.MCP_PORT
    ? parseInt(process.env.MCP_PORT, 10)
    : null;

  let savedPort = null;
  try {
    const saved = await readFile(PORT_STATE_FILE, "utf-8");
    const parsed = parseInt(saved.trim(), 10);
    if (!isNaN(parsed) && parsed > 0 && parsed < 65536) savedPort = parsed;
  } catch { /* no saved port yet */ }

  const PORT = await resolvePort(explicitPort, savedPort);
  WORKDIR = resolve(process.env.MCP_WORKDIR || process.cwd());

  const MAX_TIMEOUT = 10 * 60 * 1000;
  const rawTimeout = parseInt(process.env.MCP_TIMEOUT || "30000", 10);
  if (isNaN(rawTimeout) || rawTimeout <= 0) {
    console.error(`FATAL: MCP_TIMEOUT must be a positive number (ms). Got: ${process.env.MCP_TIMEOUT}`);
    process.exit(1);
  }
  if (rawTimeout > MAX_TIMEOUT) {
    console.error(`FATAL: MCP_TIMEOUT cannot exceed ${MAX_TIMEOUT}ms (10 minutes). Got: ${rawTimeout}`);
    process.exit(1);
  }
  TIMEOUT = rawTimeout;

  const CERT_PATH = process.env.MCP_CERT_PATH || "";
  const KEY_PATH  = process.env.MCP_KEY_PATH  || "";
  const HAS_TLS   = CERT_PATH.length > 0 && KEY_PATH.length > 0;

  // ── MCP Server ──
  const mcpServer = new Server(
    { name: "mcp-shell-server", version: VERSION },
    { capabilities: { tools: {} } },
  );

  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      return await handleToolCall(name, args ?? {});
    } catch (err) {
      if (err.code === "TRAVERSAL") {
        return { content: [{ type: "text", text: err.message }], isError: true };
      }
      console.error(`Tool call "${name}" failed:`, err);
      return { content: [{ type: "text", text: `Internal error: ${err.message}` }], isError: true };
    }
  });

  // ── HTTP(S) Server + Transport ──
  const transport = new StreamableHTTPServerTransport();

  const requestHandler = async (req, res) => {
    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", version: VERSION }));
      return;
    }

    if (!isAuthenticated(req)) {
      return sendStatus(res, 401, {
        error: "Unauthorized",
        message: "Missing or invalid Authorization header. Use: Bearer <token>",
      });
    }

    if (req.url !== "/mcp") {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    try {
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("Transport error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal Server Error" }));
      }
    }
  };

  let server;
  if (HAS_TLS) {
    const tlsOptions = {
      cert: readFileSync(CERT_PATH),
      key:  readFileSync(KEY_PATH),
    };
    server = https.createServer(tlsOptions, requestHandler);
  } else {
    server = http.createServer(requestHandler);
  }

  try {
    await mcpServer.connect(transport);
  } catch (err) {
    console.error("FATAL: Failed to connect MCP server to transport:", err);
    process.exit(1);
  }

  const protocol = HAS_TLS ? "https" : "http";
  server.listen(PORT, () => {
    console.log(`┌──────────────────────────────────────────────┐`);
    console.log(`│  🐱  MCP Shell Server                        │`);
    console.log(`│                                              │`);
    console.log(`│  ${(protocol + "://localhost:" + PORT).padEnd(44)}│`);
    console.log(`│  Workdir   : ${WORKDIR.padEnd(35)}│`);
    console.log(`│  Timeout   : ${String(TIMEOUT).padEnd(10)}ms${" ".repeat(25)}│`);
    console.log(`│  Endpoint  : /mcp                            │`);
    if (HAS_TLS) {
      console.log(`│  TLS       : enabled${" ".repeat(29)}│`);
    }
    console.log(`│  Port saved: .mcp_port${" ".repeat(24)}│`);
    console.log(`└──────────────────────────────────────────────┘`);
  });
}

// ── Start the server (for --health, the async http.get callback
//    above keeps the event loop alive until process.exit is called) ──
if (!process.argv.includes("--health") && !process.argv.includes("--version") && !process.argv.includes("-v")) {
  await startServer();
}
