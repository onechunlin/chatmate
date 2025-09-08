import { readFileSync } from "fs";
import { resolve } from "path";

export interface ServerConfig {
  command: string;
  args: string[];
}

export interface MCPConfig {
  mcpServers: Record<string, ServerConfig>;
}

export function loadMCPConfig(configPath?: string): MCPConfig {
  const defaultPath = resolve(process.cwd(), "mcp.json");
  const path = configPath || defaultPath;

  try {
    const configFile = readFileSync(path, "utf-8");
    return JSON.parse(configFile);
  } catch (error) {
    throw new Error(`Failed to load MCP config from ${path}: ${error}`);
  }
}
