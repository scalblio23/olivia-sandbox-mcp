# Olivia Sandbox MCP Server

E2B-powered sandbox MCP server that gives OliviaAI full shell, filesystem, and internet access — like having a Linux workstation.

## Tools Available

| Tool | Description |
|------|-------------|
| `exec_command` | Run any shell command (npm, node, curl, git, python, etc.) |
| `write_file` | Create/edit files in the sandbox |
| `read_file` | Read file contents |
| `list_directory` | Browse filesystem |
| `upload_file_to_sandbox` | Download a file from URL into sandbox |
| `get_public_url` | Get public URL for a running server port |
| `install_packages` | Install npm or pip packages |
| `sandbox_status` | Check sandbox health and resources |
| `destroy_sandbox` | Clean up sandbox when done |

## Deploy to Railway

1. Push this repo to GitHub
2. Create a new Railway project from the repo
3. Set environment variables:
   - `E2B_API_KEY` — your E2B API key (get one at https://e2b.dev)
   - `PORT` — Railway sets this automatically
4. Deploy

## Get E2B API Key

1. Go to https://e2b.dev
2. Sign up (free tier includes sandbox hours)
3. Go to Dashboard → API Keys
4. Copy your key and set it as `E2B_API_KEY` in Railway

## Add to OliviaAI

Once deployed, add this MCP server in OliviaAI Settings:
- **Name:** Sandbox
- **URL:** `https://your-railway-url.up.railway.app/mcp`
- **Auth Headers:** (none needed — the E2B key is server-side)

## Local Development

```bash
npm install
E2B_API_KEY=your_key npm run dev
```

## Architecture

```
OliviaAI → MCP SSE → This Server → E2B API → Isolated Sandbox VM
                                                  ├── Shell (bash)
                                                  ├── Filesystem
                                                  ├── Internet
                                                  ├── Node.js / Python
                                                  └── Public port access
```

Each conversation gets its own isolated sandbox. Sandboxes auto-terminate after 30 minutes of inactivity.
