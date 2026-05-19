import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import cors from "cors";
import { Sandbox } from "e2b";
import express from "express";
import { z } from "zod";

const app = express();
app.use(cors());
app.use(express.json());

// Store active sandboxes per session
const sandboxes = new Map<string, Sandbox>();

// Default sandbox timeout: 30 minutes
const SANDBOX_TIMEOUT = 30 * 60 * 1000;

async function getOrCreateSandbox(sessionId: string): Promise<Sandbox> {
  let sandbox = sandboxes.get(sessionId);
  if (sandbox) {
    return sandbox;
  }

  console.log(`[Sandbox] Creating new sandbox for session: ${sessionId}`);
  const apiKey = process.env.E2B_API_KEY || "e2b_2eda6576301e44d63daa4f3198633eb321b07ec6";
  sandbox = await Sandbox.create({
    apiKey,
    timeoutMs: SANDBOX_TIMEOUT,
  });
  sandboxes.set(sessionId, sandbox);
  console.log(`[Sandbox] Created sandbox ${sandbox.sandboxId} for session ${sessionId}`);
  return sandbox;
}

// Cleanup sandbox when done
async function destroySandbox(sessionId: string): Promise<void> {
  const sandbox = sandboxes.get(sessionId);
  if (sandbox) {
    await sandbox.kill();
    sandboxes.delete(sessionId);
    console.log(`[Sandbox] Destroyed sandbox for session: ${sessionId}`);
  }
}

// Create MCP server
function createServer() {
  const server = new McpServer({
    name: "olivia-sandbox",
    version: "1.0.0",
  });

  // ─── TOOL: exec_command ───────────────────────────────────────────────────────
  server.tool(
    "exec_command",
    "Execute a shell command in the sandbox. Returns stdout, stderr, and exit code. Use for running any CLI command (npm, node, curl, git, python, etc.).",
    {
      command: z.string().describe("The shell command to execute"),
      workdir: z.string().optional().describe("Working directory (default: /home/user)"),
      timeout_ms: z.number().optional().describe("Command timeout in milliseconds (default: 60000)"),
      session_id: z.string().optional().describe("Session ID to reuse a sandbox (default: 'default')"),
    },
    async ({ command, workdir, timeout_ms, session_id }) => {
      const sid = session_id || "default";
      const sandbox = await getOrCreateSandbox(sid);

      try {
        const result = await sandbox.commands.run(command, {
          cwd: workdir || "/home/user",
          timeoutMs: timeout_ms || 60000,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  stdout: result.stdout,
                  stderr: result.stderr,
                  exitCode: result.exitCode,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error executing command: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─── TOOL: write_file ─────────────────────────────────────────────────────────
  server.tool(
    "write_file",
    "Write content to a file in the sandbox. Creates parent directories automatically.",
    {
      path: z.string().describe("Absolute file path in the sandbox"),
      content: z.string().describe("File content to write"),
      session_id: z.string().optional().describe("Session ID (default: 'default')"),
    },
    async ({ path, content, session_id }) => {
      const sid = session_id || "default";
      const sandbox = await getOrCreateSandbox(sid);

      try {
        // Ensure parent directory exists
        const dir = path.substring(0, path.lastIndexOf("/"));
        if (dir) {
          await sandbox.commands.run(`mkdir -p "${dir}"`);
        }
        await sandbox.files.write(path, content);

        return {
          content: [
            {
              type: "text" as const,
              text: `File written successfully: ${path}`,
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error writing file: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─── TOOL: read_file ──────────────────────────────────────────────────────────
  server.tool(
    "read_file",
    "Read the content of a file in the sandbox.",
    {
      path: z.string().describe("Absolute file path to read"),
      session_id: z.string().optional().describe("Session ID (default: 'default')"),
    },
    async ({ path, session_id }) => {
      const sid = session_id || "default";
      const sandbox = await getOrCreateSandbox(sid);

      try {
        const content = await sandbox.files.read(path);

        return {
          content: [
            {
              type: "text" as const,
              text: String(content),
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error reading file: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─── TOOL: list_directory ─────────────────────────────────────────────────────
  server.tool(
    "list_directory",
    "List files and directories at the given path in the sandbox.",
    {
      path: z.string().optional().describe("Directory path to list (default: /home/user)"),
      session_id: z.string().optional().describe("Session ID (default: 'default')"),
    },
    async ({ path, session_id }) => {
      const sid = session_id || "default";
      const sandbox = await getOrCreateSandbox(sid);
      const targetPath = path || "/home/user";

      try {
        const result = await sandbox.commands.run(`ls -la "${targetPath}"`);

        return {
          content: [
            {
              type: "text" as const,
              text: result.stdout || result.stderr,
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error listing directory: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─── TOOL: upload_file_to_sandbox ─────────────────────────────────────────────
  server.tool(
    "upload_file_to_sandbox",
    "Upload a file from a URL into the sandbox filesystem. Useful for downloading images, assets, or data files.",
    {
      url: z.string().describe("Public URL to download the file from"),
      destination_path: z.string().describe("Where to save the file in the sandbox"),
      session_id: z.string().optional().describe("Session ID (default: 'default')"),
    },
    async ({ url, destination_path, session_id }) => {
      const sid = session_id || "default";
      const sandbox = await getOrCreateSandbox(sid);

      try {
        const dir = destination_path.substring(0, destination_path.lastIndexOf("/"));
        if (dir) {
          await sandbox.commands.run(`mkdir -p "${dir}"`);
        }
        const result = await sandbox.commands.run(
          `curl -sL -o "${destination_path}" "${url}"`
        );

        if (result.exitCode !== 0) {
          throw new Error(result.stderr || "Download failed");
        }

        // Verify file exists
        const check = await sandbox.commands.run(`ls -la "${destination_path}"`);

        return {
          content: [
            {
              type: "text" as const,
              text: `File downloaded successfully:\n${check.stdout}`,
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error uploading file: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─── TOOL: get_public_url ─────────────────────────────────────────────────────
  server.tool(
    "get_public_url",
    "Get a public URL for a port running in the sandbox. Use after starting a web server to get an accessible URL.",
    {
      port: z.number().describe("The port number the server is listening on"),
      session_id: z.string().optional().describe("Session ID (default: 'default')"),
    },
    async ({ port, session_id }) => {
      const sid = session_id || "default";
      const sandbox = await getOrCreateSandbox(sid);

      try {
        const host = sandbox.getHost(port);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  url: `https://${host}`,
                  port,
                  message: `Server on port ${port} is accessible at https://${host}`,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error getting public URL: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─── TOOL: install_packages ───────────────────────────────────────────────────
  server.tool(
    "install_packages",
    "Install npm or pip packages in the sandbox.",
    {
      packages: z.string().describe("Space-separated package names (e.g., 'express react' or 'flask pandas')"),
      manager: z.enum(["npm", "pip"]).optional().describe("Package manager to use (default: npm)"),
      session_id: z.string().optional().describe("Session ID (default: 'default')"),
    },
    async ({ packages, manager, session_id }) => {
      const sid = session_id || "default";
      const sandbox = await getOrCreateSandbox(sid);
      const pm = manager || "npm";

      try {
        const cmd = pm === "npm" ? `npm install ${packages}` : `pip install ${packages}`;
        const result = await sandbox.commands.run(cmd, {
          cwd: "/home/user",
          timeoutMs: 120000,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  stdout: result.stdout.slice(-2000),
                  stderr: result.stderr.slice(-1000),
                  exitCode: result.exitCode,
                  success: result.exitCode === 0,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error installing packages: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─── TOOL: sandbox_status ─────────────────────────────────────────────────────
  server.tool(
    "sandbox_status",
    "Check the status of the current sandbox session. Shows sandbox ID, uptime, and available resources.",
    {
      session_id: z.string().optional().describe("Session ID (default: 'default')"),
    },
    async ({ session_id }) => {
      const sid = session_id || "default";
      const sandbox = sandboxes.get(sid);

      if (!sandbox) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "no_sandbox",
                  message: "No active sandbox for this session. One will be created on first command.",
                  active_sessions: sandboxes.size,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      try {
        const uptimeResult = await sandbox.commands.run("uptime && free -h && df -h /");

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "running",
                  sandbox_id: sandbox.sandboxId,
                  active_sessions: sandboxes.size,
                  system_info: uptimeResult.stdout,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Sandbox exists but may be unresponsive: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─── TOOL: destroy_sandbox ────────────────────────────────────────────────────
  server.tool(
    "destroy_sandbox",
    "Destroy the current sandbox session and free resources. Use when done with a task.",
    {
      session_id: z.string().optional().describe("Session ID (default: 'default')"),
    },
    async ({ session_id }) => {
      const sid = session_id || "default";

      try {
        await destroySandbox(sid);
        return {
          content: [
            {
              type: "text" as const,
              text: `Sandbox session '${sid}' destroyed successfully.`,
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error destroying sandbox: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  return server;
}

// ─── Express + SSE Transport ──────────────────────────────────────────────────

const transports = new Map<string, SSEServerTransport>();

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    server: "olivia-sandbox-mcp",
    version: "1.0.0",
    active_sandboxes: sandboxes.size,
    tools: [
      "exec_command",
      "write_file",
      "read_file",
      "list_directory",
      "upload_file_to_sandbox",
      "get_public_url",
      "install_packages",
      "sandbox_status",
      "destroy_sandbox",
    ],
  });
});

app.get("/sse", (req, res) => {
  const server = createServer();
  const transport = new SSEServerTransport("/messages", res);
  const sessionId = transport.sessionId;
  transports.set(sessionId, transport);

  res.on("close", () => {
    transports.delete(sessionId);
  });

  server.connect(transport);
});

app.post("/messages", (req, res) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports.get(sessionId);

  if (!transport) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  transport.handlePostMessage(req, res);
});

// ─── Stateless JSON-RPC POST /mcp endpoint (for OliviaAI's MCP client) ────────
// OliviaAI sends direct POST requests with JSON-RPC body and expects
// either a JSON response or SSE "data:" lines back.

// Per-request server instance for stateless mode
app.post("/mcp", async (req, res) => {
  const { jsonrpc, id, method, params } = req.body;

  if (!method) {
    res.status(400).json({ jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid request: missing method" } });
    return;
  }

  // Handle initialize
  if (method === "initialize") {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const result = {
      protocolVersion: "2024-11-05",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "olivia-sandbox", version: "1.0.0" },
    };

    res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`);
    res.end();
    return;
  }

  // Handle tools/list
  if (method === "tools/list") {
    const server = createServer();
    // Get tools by creating a temporary in-memory transport
    const tools = [
      {
        name: "exec_command",
        description: "Execute a shell command in the sandbox. Returns stdout, stderr, and exit code. Use for running any CLI command (npm, node, curl, git, python, etc.).",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string", description: "The shell command to execute" },
            workdir: { type: "string", description: "Working directory (default: /home/user)" },
            timeout_ms: { type: "number", description: "Command timeout in milliseconds (default: 60000)" },
            session_id: { type: "string", description: "Session ID to reuse a sandbox (default: 'default')" },
          },
          required: ["command"],
        },
      },
      {
        name: "write_file",
        description: "Write content to a file in the sandbox. Creates parent directories automatically.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute file path in the sandbox" },
            content: { type: "string", description: "File content to write" },
            session_id: { type: "string", description: "Session ID (default: 'default')" },
          },
          required: ["path", "content"],
        },
      },
      {
        name: "read_file",
        description: "Read the content of a file in the sandbox.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute file path to read" },
            session_id: { type: "string", description: "Session ID (default: 'default')" },
          },
          required: ["path"],
        },
      },
      {
        name: "list_directory",
        description: "List files and directories at the given path in the sandbox.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Directory path to list (default: /home/user)" },
            session_id: { type: "string", description: "Session ID (default: 'default')" },
          },
          required: [],
        },
      },
      {
        name: "upload_file_to_sandbox",
        description: "Upload a file from a URL into the sandbox filesystem. Useful for downloading images, assets, or data files.",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", description: "Public URL to download the file from" },
            destination_path: { type: "string", description: "Where to save the file in the sandbox" },
            session_id: { type: "string", description: "Session ID (default: 'default')" },
          },
          required: ["url", "destination_path"],
        },
      },
      {
        name: "get_public_url",
        description: "Get a public URL for a port running in the sandbox. Use after starting a web server to get an accessible URL.",
        inputSchema: {
          type: "object",
          properties: {
            port: { type: "number", description: "The port number the server is listening on" },
            session_id: { type: "string", description: "Session ID (default: 'default')" },
          },
          required: ["port"],
        },
      },
      {
        name: "install_packages",
        description: "Install npm or pip packages in the sandbox.",
        inputSchema: {
          type: "object",
          properties: {
            packages: { type: "string", description: "Space-separated package names (e.g., 'express react' or 'flask pandas')" },
            manager: { type: "string", enum: ["npm", "pip"], description: "Package manager to use (default: npm)" },
            session_id: { type: "string", description: "Session ID (default: 'default')" },
          },
          required: ["packages"],
        },
      },
      {
        name: "sandbox_status",
        description: "Check the status of the current sandbox session. Shows sandbox ID, uptime, and available resources.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: { type: "string", description: "Session ID (default: 'default')" },
          },
          required: [],
        },
      },
      {
        name: "destroy_sandbox",
        description: "Destroy the current sandbox session and free resources. Use when done with a task.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: { type: "string", description: "Session ID (default: 'default')" },
          },
          required: [],
        },
      },
    ];

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result: { tools } })}\n\n`);
    res.end();
    return;
  }

  // Handle tools/call
  if (method === "tools/call") {
    const { name, arguments: args } = params || {};
    const sessionId = args?.session_id || "default";

    try {
      const sandbox = await getOrCreateSandbox(sessionId);
      let result: any;

      switch (name) {
        case "exec_command": {
          const cmdResult = await sandbox.commands.run(args.command, {
            cwd: args.workdir || "/home/user",
            timeoutMs: args.timeout_ms || 60000,
          });
          result = { content: [{ type: "text", text: JSON.stringify({ stdout: cmdResult.stdout, stderr: cmdResult.stderr, exitCode: cmdResult.exitCode }, null, 2) }] };
          break;
        }
        case "write_file": {
          const dir = args.path.substring(0, args.path.lastIndexOf("/"));
          if (dir) await sandbox.commands.run(`mkdir -p "${dir}"`);
          await sandbox.files.write(args.path, args.content);
          result = { content: [{ type: "text", text: `File written successfully: ${args.path}` }] };
          break;
        }
        case "read_file": {
          const content = await sandbox.files.read(args.path);
          result = { content: [{ type: "text", text: String(content) }] };
          break;
        }
        case "list_directory": {
          const lsResult = await sandbox.commands.run(`ls -la "${args.path || "/home/user"}"`);
          result = { content: [{ type: "text", text: lsResult.stdout || lsResult.stderr }] };
          break;
        }
        case "upload_file_to_sandbox": {
          const dir2 = args.destination_path.substring(0, args.destination_path.lastIndexOf("/"));
          if (dir2) await sandbox.commands.run(`mkdir -p "${dir2}"`);
          const dlResult = await sandbox.commands.run(`curl -sL -o "${args.destination_path}" "${args.url}"`);
          if (dlResult.exitCode !== 0) throw new Error(dlResult.stderr || "Download failed");
          const check = await sandbox.commands.run(`ls -la "${args.destination_path}"`);
          result = { content: [{ type: "text", text: `File downloaded successfully:\n${check.stdout}` }] };
          break;
        }
        case "get_public_url": {
          const host = sandbox.getHost(args.port);
          result = { content: [{ type: "text", text: JSON.stringify({ url: `https://${host}`, port: args.port, message: `Server on port ${args.port} is accessible at https://${host}` }, null, 2) }] };
          break;
        }
        case "install_packages": {
          const pm = args.manager || "npm";
          const cmd = pm === "npm" ? `npm install ${args.packages}` : `pip install ${args.packages}`;
          const installResult = await sandbox.commands.run(cmd, { cwd: "/home/user", timeoutMs: 120000 });
          result = { content: [{ type: "text", text: JSON.stringify({ stdout: installResult.stdout.slice(-2000), stderr: installResult.stderr.slice(-1000), exitCode: installResult.exitCode, success: installResult.exitCode === 0 }, null, 2) }] };
          break;
        }
        case "sandbox_status": {
          const uptimeResult = await sandbox.commands.run("uptime && free -h && df -h /");
          result = { content: [{ type: "text", text: JSON.stringify({ status: "running", sandbox_id: sandbox.sandboxId, active_sessions: sandboxes.size, system_info: uptimeResult.stdout }, null, 2) }] };
          break;
        }
        case "destroy_sandbox": {
          await destroySandbox(sessionId);
          result = { content: [{ type: "text", text: `Sandbox session '${sessionId}' destroyed successfully.` }] };
          break;
        }
        default:
          result = { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
      }

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`);
      res.end();
    } catch (error: any) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      const errResult = { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result: errResult })}\n\n`);
      res.end();
    }
    return;
  }

  // Unknown method
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } })}\n\n`);
  res.end();
});

// Also support SSE transport at /mcp for clients that use GET
app.get("/mcp", (req, res) => {
  const server = createServer();
  const transport = new SSEServerTransport("/mcp/messages", res);
  const sessionId = transport.sessionId;
  transports.set(sessionId, transport);

  res.on("close", () => {
    transports.delete(sessionId);
  });

  server.connect(transport);
});

app.post("/mcp/messages", (req, res) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports.get(sessionId);

  if (!transport) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  transport.handlePostMessage(req, res);
});

const PORT = parseInt(process.env.PORT || "3001", 10);

app.listen(PORT, () => {
  console.log(`\n🧪 Olivia Sandbox MCP Server v1.0.0`);
  console.log(`   Health:    http://localhost:${PORT}/health`);
  console.log(`   SSE:       http://localhost:${PORT}/sse`);
  console.log(`   MCP:       http://localhost:${PORT}/mcp`);
  console.log(`\n   Tools: exec_command, write_file, read_file, list_directory,`);
  console.log(`          upload_file_to_sandbox, get_public_url, install_packages,`);
  console.log(`          sandbox_status, destroy_sandbox`);
  console.log(`\n   E2B API Key: ${process.env.E2B_API_KEY ? "✓ configured" : "✗ MISSING (set E2B_API_KEY)"}`);
  console.log("");
});
