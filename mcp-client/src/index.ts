import dotenv from "dotenv";
dotenv.config();

import { MCPClient } from "./mcp.js";
import { loadMCPConfig } from "./config.js";

async function main() {
  const mcpClient = new MCPClient();

  try {
    // 加载配置
    const config = loadMCPConfig();

    console.log("Loading MCP configuration...");
    console.log(
      `Found ${
        Object.keys(config.mcpServers).length
      } server(s) in configuration`
    );

    await mcpClient.connectToServers(config);
    await mcpClient.chatLoop();
  } catch (error) {
    console.error(
      "Error:",
      error instanceof Error ? error.message : String(error)
    );
    process.exit(1);
  } finally {
    await mcpClient.cleanup();
    process.exit(0);
  }
}

main();
