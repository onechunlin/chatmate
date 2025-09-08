import OpenAI from "openai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import inquirer from "inquirer";
import {
  ChatCompletionFunctionTool,
  ChatCompletionMessageParam,
} from "openai/resources";
import ora from "ora";
import logger from "./logger.js";
import chalk from "chalk";
import { ServerConfig, MCPConfig } from "./config.js";

export type MessageParam = ChatCompletionMessageParam;

interface ServerConnection {
  name: string;
  client: Client;
  transport: StdioClientTransport;
  tools: ChatCompletionFunctionTool[];
}

const processingSpinner = ora({
  text: "加载中...",
  spinner: "dots",
});

export class MCPClient {
  private openAi: OpenAI;
  private serverConnections: Map<string, ServerConnection> = new Map();
  private allTools: ChatCompletionFunctionTool[] = [];

  constructor() {
    const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
    if (!DEEPSEEK_API_KEY) {
      throw new Error("DEEPSEEK_API_KEY is not set");
    }

    this.openAi = new OpenAI({
      baseURL: "https://api.deepseek.com",
      apiKey: DEEPSEEK_API_KEY,
    });
  }

  async connectToServers(config: MCPConfig) {
    const serverNames = Object.keys(config.mcpServers);

    for (const serverName of serverNames) {
      try {
        const serverConfig = config.mcpServers[serverName];
        await this.connectToSingleServer(serverName, serverConfig);
      } catch (error) {
        logger.error(`Failed to connect to server '${serverName}':`, error);
        // 继续连接其他服务器，不因一个失败而停止
      }
    }

    if (this.serverConnections.size === 0) {
      throw new Error("Failed to connect to any MCP servers");
    }

    logger.success(
      `Successfully connected to ${this.serverConnections.size} MCP server(s)`
    );
  }

  private async connectToSingleServer(
    serverName: string,
    serverConfig: ServerConfig
  ) {
    const client = new Client({
      name: `mcp-client-${serverName}`,
      version: "1.0.0",
    });
    const transport = new StdioClientTransport({
      command: serverConfig.command,
      args: serverConfig.args,
    });

    await client.connect(transport);

    const toolsResult = await client.listTools();
    const tools = toolsResult.tools.map((tool) => ({
      type: "function" as const,
      function: {
        name: `${serverName}_${tool.name}`, // 使用下划线而不是冒号
        description: `[${serverName}] ${tool.description}`,
        parameters: tool.inputSchema,
      },
    }));

    const connection: ServerConnection = {
      name: serverName,
      client,
      transport,
      tools,
    };

    this.serverConnections.set(serverName, connection);
    this.allTools.push(...tools);

    logger.warn(
      `Connected to server '${serverName}' with tools:`,
      tools.map((tool) => tool.function.name)
    );
  }

  private async callTool(toolName: string, toolArgs: any): Promise<string> {
    // 解析工具名称，获取服务器名和实际工具名
    const underscoreIndex = toolName.indexOf("_");
    let serverName: string;
    let actualToolName: string;

    if (underscoreIndex !== -1) {
      serverName = toolName.substring(0, underscoreIndex);
      actualToolName = toolName.substring(underscoreIndex + 1);
    } else {
      // fallback to first server if no prefix found
      serverName = Array.from(this.serverConnections.keys())[0];
      actualToolName = toolName;
    }

    const connection = this.serverConnections.get(serverName);
    if (!connection) {
      throw new Error(`Server '${serverName}' not found`);
    }

    const result = await connection.client.callTool({
      name: actualToolName,
      arguments: toolArgs,
    });

    return result.content as string;
  }

  async processQuery(query: string) {
    try {
      const messages: MessageParam[] = [
        {
          role: "user",
          content: query,
        },
      ];

      const response = await this.openAi.chat.completions.create({
        model: "deepseek-chat",
        messages,
        tools: this.allTools,
        tool_choice: "auto",
        stream: false,
      });
      const finalText: string[] = [];

      for (const choice of response.choices) {
        const assistantMessage = choice.message;
        const toolCalls =
          assistantMessage.tool_calls as ChatCompletionFunctionTool[];
        if (assistantMessage.content) {
          finalText.push(assistantMessage.content);
        } else if (toolCalls?.length && toolCalls[0].function) {
          const functionTool = toolCalls[0].function;
          const toolName = functionTool.name;
          // @ts-ignore
          const functionArgs = functionTool.arguments;
          const toolArgs =
            typeof functionArgs === "string"
              ? JSON.parse(functionArgs)
              : functionArgs;

          processingSpinner.text = `调用工具${toolName}`;
          processingSpinner.start();
          const result = await this.callTool(toolName, toolArgs);
          processingSpinner.stop();

          finalText.push(
            `[Calling tool ${toolName} with args ${JSON.stringify(toolArgs)}]`
          );

          messages.push({
            role: "user",
            content: result,
          });

          processingSpinner.text = "总结回答";
          processingSpinner.start();
          // 再次调用模型，加入工具调用结果
          const response = await this.openAi.chat.completions.create({
            model: "deepseek-chat",
            messages,
            stream: false,
          });
          processingSpinner.stop();

          finalText.push(response.choices[0].message.content || "");
        }
      }

      return finalText.join("\n");
    } catch (error) {
      logger.error("Error processing query:", error);
      throw error;
    }
  }

  async chatLoop() {
    try {
      logger.success("\nMCP Client Started!");

      while (true) {
        const answer = await inquirer.prompt({
          type: "input",
          name: "message",
          message: chalk.yellow("您的问题:"),
        });

        const message = answer.message;
        processingSpinner.text = `处理查询: "${message.slice(0, 30)}${
          message.length > 30 ? "..." : ""
        }"`;
        processingSpinner.start();
        try {
          const response = await this.processQuery(message);
          processingSpinner.succeed("查询处理完成");
          logger.info("\n" + response);
        } catch (error) {
          processingSpinner.fail("查询处理失败");
          throw error;
        }
      }
    } catch (error) {
      logger.error("Chat loop error:", error);
    }
  }

  async cleanup() {
    // 关闭所有服务器连接
    for (const [serverName, connection] of this.serverConnections) {
      try {
        await connection.client.close();
        logger.info(`Disconnected from server: ${serverName}`);
      } catch (error) {
        logger.error(
          `Error closing connection to server '${serverName}':`,
          error
        );
      }
    }
    this.serverConnections.clear();
    this.allTools = [];
  }
}
