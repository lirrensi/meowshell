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
//  CLI flags
// ────────────────────────────────────────────────

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log(`meowshell v${VERSION}`);
  process.exit(0);
}

// ────────────────────────────────────────────────
//  Port resolution — find a free port, stable across restarts
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

async function resolvePort(preferred) {
  // 1. Try the saved port first (stable across restarts)
  let startAt = preferred;
  try {
    const saved = await readFile(PORT_STATE_FILE, "utf-8");
    const parsed = parseInt(saved.trim(), 10);
    if (!isNaN(parsed) && parsed > 0 && parsed < 65536) startAt = parsed;
  } catch { /* no saved port yet */ }

  // 2. Scan for a free port (up to 100 attempts)
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
//  Configuration
// ────────────────────────────────────────────────

const MCP_TOKEN = process.env.MCP_TOKEN;
if (!MCP_TOKEN) {
  console.error("FATAL: MCP_TOKEN environment variable is required");
  process.exit(1);
}

const PORT        = await resolvePort(parseInt(process.env.MCP_PORT || String(DEFAULT_PORT), 10));
const WORKDIR     = resolve(process.env.MCP_WORKDIR       || process.cwd());
const MAX_TIMEOUT = 10 * 60 * 1000; // 10 minutes max
const TIMEOUT     = (() => {
  const raw = parseInt(process.env.MCP_TIMEOUT || "30000", 10);
  if (isNaN(raw) || raw <= 0) {
    console.error(`FATAL: MCP_TIMEOUT must be a positive number (ms). Got: ${process.env.MCP_TIMEOUT}`);
    process.exit(1);
  }
  if (raw > MAX_TIMEOUT) {
    console.error(`FATAL: MCP_TIMEOUT cannot exceed ${MAX_TIMEOUT}ms (10 minutes). Got: ${raw}`);
    process.exit(1);
  }
  return raw;
})();
const CERT_PATH   = process.env.MCP_CERT_PATH             || "";
const KEY_PATH    = process.env.MCP_KEY_PATH              || "";
const HAS_TLS     = CERT_PATH.length > 0 && KEY_PATH.length > 0;

// ────────────────────────────────────────────────
//  Auth
// ────────────────────────────────────────────────

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
  // Normalise path separators and resolve symlinks
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

async function handleToolCall(name, args) {
  switch (name) {
    // ── exec ──────────────────────────────────
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
              // Append timeout hint if the process was killed
              if (error.killed || error.signal === "SIGTERM") {
                content.push({
                  type: "text",
                  text: `\n[Command timed out after ${TIMEOUT}ms and was terminated]`,
                });
              }

              // Non-zero exit → return the output as tool content with isError,
              // so the AI client can decide what to do instead of getting a hard error.
              return resolvePromise({
                content,
                isError: true,
              });
            }

            resolvePromise({ content });
          },
        );
      });
    }

    // ── read_file ───────────────────────────────
    case "read_file": {
      const targetPath = safeResolve(WORKDIR, args.path);
      const content = await readFile(targetPath, "utf-8");
      return { content: [{ type: "text", text: content }] };
    }

    // ── write_file ──────────────────────────────
    case "write_file": {
      const targetPath = safeResolve(WORKDIR, args.path);
      const parentDir = resolve(targetPath, "..");
      await mkdir(parentDir, { recursive: true });
      await writeFile(targetPath, args.content, "utf-8");
      return {
        content: [
          {
            type: "text",
            text: `File written: ${relative(WORKDIR, targetPath)}`,
          },
        ],
      };
    }

    // ── list_dir ────────────────────────────────
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
//  MCP Server
// ────────────────────────────────────────────────

const mcpServer = new Server(
  {
    name: "mcp-shell-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_DEFINITIONS,
}));

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    return await handleToolCall(name, args ?? {});
  } catch (err) {
    // Distinguish between traversal-denied (client mistake) vs. internal errors
    if (err.code === "TRAVERSAL") {
      return { content: [{ type: "text", text: err.message }], isError: true };
    }
    // Actual unexpected errors
    console.error(`Tool call "${name}" failed:`, err);
    return { content: [{ type: "text", text: `Internal error: ${err.message}` }], isError: true };
  }
});

// ────────────────────────────────────────────────
//  HTTP(S) Server + Streamable HTTP Transport
// ────────────────────────────────────────────────

const transport = new StreamableHTTPServerTransport();

const requestHandler = async (req, res) => {
  // ── CORS (permissive; this is a personal tool) ──
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");

  // ── CORS preflight ──
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── Health check (no auth required) ──
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", version: VERSION }));
    return;
  }

  // ── Auth — every request must carry a valid token ──
  if (!isAuthenticated(req)) {
    return sendStatus(res, 401, {
      error: "Unauthorized",
      message: "Missing or invalid Authorization header. Use: Bearer <token>",
    });
  }

  // ── Route: only /mcp is handled ──
  if (req.url !== "/mcp") {
    res.writeHead(404);
    res.end("Not Found");
    return;
  }

  // ── Delegate to MCP transport ──
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

// ────────────────────────────────────────────────
//  Start
// ────────────────────────────────────────────────

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
