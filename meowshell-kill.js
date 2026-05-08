#!/usr/bin/env node

/**
 * kill.js — Gracefully shut down the MCP shell server
 * ─────────────────────────────────────────────────────
 * Reads .mcp_port to find the running server and kills it.
 *
 * Usage:
 *   node kill.js
 *
 * Also checks --health first to confirm server is actually running.
 */

import { readFile } from "node:fs/promises";
import { exec } from "node:child_process";
import http from "node:http";

const PORT_FILE = ".mcp_port";
const DEFAULT_PORT = 13579;

async function checkHealth(port) {
  return new Promise((resolve) => {
    http.get(`http://localhost:${port}/health`, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          resolve(json.status === "ok");
        } catch {
          resolve(false);
        }
      });
    }).on("error", () => resolve(false));
  });
}

async function main() {
  let port;
  try {
    const content = await readFile(PORT_FILE, "utf-8");
    port = parseInt(content.trim(), 10);
    if (isNaN(port) || port <= 0 || port > 65535) {
      console.error("Invalid port in .mcp_port");
      process.exit(1);
    }
  } catch {
    console.error(`No .mcp_port found. Defaulting to ${DEFAULT_PORT}.`);
    console.error("Run 'node meowshell.js --health' to verify server is running.");
    process.exit(1);
  }

  // Check if server is actually running
  const isRunning = await checkHealth(port);
  if (!isRunning) {
    console.log(`Server on port ${port} is not responding.`);
    console.log("Either the server is not running, or it's on a different port.");
    process.exit(1);
  }

  // Find and kill the process using that port
  const platform = process.platform;
  let killCmd;

  if (platform === "win32") {
    // Windows: use netstat to find PID, then taskkill
    killCmd = `for /f "tokens=5" %a in ('netstat -ano ^| findstr :${port} ^| findstr LISTENING') do taskkill /PID %a /F`;
  } else {
    // Unix: use lsof or fuser
    killCmd = `lsof -ti:${port} | xargs -r kill -TERM || fuser -k ${port}/tcp`;
  }

  exec(killCmd, (err) => {
    if (err) {
      console.error(`Failed to kill server on port ${port}: ${err.message}`);
      process.exit(1);
    }
    console.log(`Server on port ${port} killed.`);
  });
}

main();