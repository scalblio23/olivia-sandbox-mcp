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
  sandbox = await Sandbox.create({
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

// Also support /mcp endpoint for compatibility with OliviaAI's MCP client
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
