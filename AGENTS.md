# meowshell

## Quick start

```bash
npm install
node meowshell-setup.js   # interactive wizard
node meowshell.js         # start server
```

## Files

- `meowshell.js` — main server (MCP over HTTP)
- `meowshell-setup.js` — setup wizard (generates config, PM2 file, client JSON)
- `meowshell-kill.js` — graceful shutdown

## Configuration

Set via environment variables (or let setup wizard create `.env`):

| Variable | Default | Notes |
|----------|---------|-------|
| `MCP_TOKEN` | **required** | Bearer token for auth |
| `MCP_PORT` | `13579` | Server port (auto-resolves if taken) |
| `MCP_WORKDIR` | cwd | Working directory for commands |
| `MCP_TIMEOUT` | `30000` | Command timeout in ms (max 10 min) |

## Making changes

- Edit `meowshell.js` to add/modify MCP tools
- Edit `meowshell-setup.js` to change setup behavior
- After changes: `node meowshell.js --version` to verify it runs
- Run with debug env: `MCP_TOKEN=test node meowshell.js`

## Testing locally

```bash
# Quick syntax check
node --check meowshell.js
node --check meowshell-setup.js
node --check meowshell-kill.js

# Full test: run the server with a test token
MCP_TOKEN=test MCP_PORT=13580 node meowshell.js
# Then hit the health endpoint
curl http://localhost:13580/health
```

## Common tasks

- **Add a new MCP tool**: Add to the `tools` array in `meowshell.js`, implement in the `handleToolCall` switch
- **Change default port**: Edit `DEFAULT_PORT` in `meowshell.js` or set `MCP_PORT` env
- **Regenerate config**: Run `node meowshell-setup.js` again (overwrites `.env`, `ecosystem.config.cjs`, `mcp-client-config.json`)
- **Graceful shutdown**: `node meowshell-kill.js` (reads `.mcp_port` to find running server)