# meowshell

> Give any web-based MCP client shell access to your machine — no SSH, no local setup required.

## What is this?

meowshell is a lightweight HTTP server that exposes local shell execution as MCP tools. If you want your Claude.ai, Cursor, or any other web-based MCP client to actually run commands on a real machine, this server bridges that gap.

```
┌─────────────────────┐        HTTP         ┌─────────────────────┐
│  Web MCP Client     │ ──────────────────►│     meowshell      │
│  (Claude.ai, etc)  │                     │  (runs on your box)│
└─────────────────────┘                     └─────────┬───────────┘
                                                      │
                                                      ▼
                                               ┌─────────────┐
                                               │ child_proc │
                                               │ .exec()    │
                                               └─────────────┘
```

**Why?** Web-based MCP clients have no filesystem, no SSH, no local process execution. They can only connect to remote MCP servers over HTTP. If you want to give a web client "hands" on a real machine, you currently have to build it yourself. This server is that built thing — self-hosted, minimal, ready to go.

## Features

- **Zero dependencies** — just Node.js + `@modelcontextprotocol/sdk`
- **4 tools out of the box**: `exec`, `read_file`, `write_file`, `list_dir`
- **Auto port selection** — finds a free port (10k+ range) and remembers it
- **Command timeout enforcement** — cannot run without a timeout leash
- **Bearer token auth** — single static token, rotated manually
- **Health check endpoint** — `GET /health` (no auth required)
- **Version flag** — `node meowshell.js --version`
- **PM2-ready** — ecosystem config generated automatically

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/yourusername/meowshell.git
cd meowshell
npm install   # or pnpm install

# 2. Run the setup wizard (creates .env, client config, ecosystem file)
node setup.js

# 3. Start the server
node meowshell.js
```

That's it. The setup wizard asks a few questions, generates everything, and you're ready to paste the client config into your MCP client.

## Setup Wizard Options

```bash
# Interactive mode (default)
node setup.js

# CLI mode — skip all questions
node setup.js --port 13579 --timeout 30000

# With domain for Caddy auto-HTTPS
node setup.js --domain myserver.com

# Skip PM2 auto-start
node setup.js --no-pm2
```

## Manual Configuration

If you prefer to skip the wizard:

```bash
# Set environment and run
export MCP_TOKEN="your-secret-token"
export MCP_PORT=13579
export MCP_WORKDIR="/path/to/serve"
export MCP_TIMEOUT=30000

node meowshell.js
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_TOKEN` | **required** | Bearer token for auth |
| `MCP_PORT` | `13579` | Port to listen on (auto-resolves if taken) |
| `MCP_WORKDIR` | `process.cwd()` | Working directory for commands |
| `MCP_TIMEOUT` | `30000` | Command timeout in ms (30s default, max 10 min) |
| `MCP_CERT_PATH` | — | TLS certificate file (optional) |
| `MCP_KEY_PATH` | — | TLS key file (optional) |

## Client Configuration

After running `node setup.js`, you'll get a `mcp-client-config.json` file. Paste it into your MCP client:

```json
{
  "mcpServers": {
    "my-server": {
      "type": "url",
      "url": "http://localhost:13579/mcp",
      "headers": {
        "Authorization": "Bearer your-token-here"
      }
    }
  }
}
```

## Tools Available

| Tool | Input | Description |
|------|-------|-------------|
| `exec` | `{ command: string }` | Run a shell command |
| `read_file` | `{ path: string }` | Read a file as text |
| `write_file` | `{ path: string, content: string }` | Write text to a file |
| `list_dir` | `{ path: string }` | List directory contents |

## Deployment

### Development (localhost)

```bash
node setup.js
node meowshell.js
```

### Production (remote server)

```bash
# 1. Clone and install
git clone https://github.com/yourusername/meowshell.git
cd meowshell
npm install

# 2. Run setup (sets port, token, generates everything)
node setup.js --port 13579 --timeout 30000 --domain yourdomain.com

# 3. Start with PM2 (auto-restart on crash)
npx pm2 start ecosystem.config.cjs
npx pm2 save
```

### With Caddy (auto-HTTPS)

If you have a domain, Caddy handles TLS automatically:

```bash
# After setup.js creates your Caddyfile
caddy run
```

Caddyfile looks like:
```
yourdomain.com {
    reverse_proxy localhost:13579
}
```

## Security Notes

- **No sandboxing** — you own the server, you know what you're doing
- **Single user** — one token, one owner
- **No multi-tenant** — not designed for shared access
- **No auth system** — bearer token rotated manually via `.env`
- **Path traversal protection** — `read_file`/`write_file` cannot escape `MCP_WORKDIR`

## Utility Scripts

```bash
# Check server version
node meowshell.js --version

# Gracefully kill the server
node kill.js
```

## File Structure

```
meowshell/
├── meowshell.js       # Main server (HTTP + MCP)
├── meowshell-setup.js  # Interactive setup wizard
├── meowshell-kill.js   # Graceful shutdown script
├── package.json       # Dependencies
├── .gitignore         # Ignored files
├── .env               # Your config (generated, not committed)
├── ecosystem.config.cjs    # PM2 config (generated)
└── mcp-client-config.json  # Client config (generated)
```

## Why this exists

Web-based MCP clients (browser, hosted apps) have no filesystem, no SSH, no local process execution. They can only connect to remote MCP servers over HTTP. There was no existing minimal, self-hostable server that bridges this gap.

If you want to give a web client "hands" on a real machine, you have to build it yourself. This is that built thing.

## Requirements

- Node.js 18+
- npm or pnpm

## License

MIT — do whatever you want with it. It's your server, your machine.