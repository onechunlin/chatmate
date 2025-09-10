import OpenAI from "openai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import inquirer from "inquirer";
import {
  ChatCompletionChunk,
  ChatCompletionFunctionTool,
  ChatCompletionMessageParam,
} from "openai/resources";
import ora from "ora";
import logger from "./logger.js";
import chalk from "chalk";
import { ServerConfig, MCPConfig } from "./config.js";
import { Stream } from "openai/streaming";

export type MessageParam = ChatCompletionMessageParam;

type BasicToolCall = Required<
  Omit<ChatCompletionChunk.Choice.Delta.ToolCall, "index" | "id">
>;

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
  private conversationHistory: MessageParam[] = []; // 添加对话历史

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

  private async handleStreamResponse(
    response: Stream<ChatCompletionChunk>
  ): Promise<{
    content: string;
    toolCalls: BasicToolCall[];
  }> {
    let currentContent = "";
    const pendingToolCalls: BasicToolCall[] = [];

    // 处理流式响应
    for await (const chunk of response) {
      const delta = chunk.choices[0]?.delta;

      if (delta.content) {
        currentContent += delta.content;
        process.stdout.write(delta.content); // 实时输出内容
      }

      if (delta.tool_calls) {
        // 优化的工具调用信息收集
        for (const toolCall of delta.tool_calls) {
          const index = toolCall.index;

          // 初始化工具调用对象
          if (!pendingToolCalls[index]) {
            pendingToolCalls[index] = {
              type: toolCall.type || "function",
              function: { name: "", arguments: "" },
            } as BasicToolCall;
          }

          // 累积拼接工具调用信息（流式传输可能分割数据）
          const currentTool = pendingToolCalls[index];

          // 拼接工具名称（可能分多个chunk传输）
          if (toolCall.function?.name) {
            currentTool.function.name += toolCall.function.name;
          }

          // 拼接参数字符串（可能分多个chunk传输）
          if (toolCall.function?.arguments) {
            currentTool.function.arguments += toolCall.function.arguments;
          }
        }
      }
    }

    console.log(); // 换行
    return {
      content: currentContent,
      toolCalls: pendingToolCalls.filter(Boolean), // 过滤掉空元素
    };
  }

  private async handleToolCall(toolCall: BasicToolCall): Promise<string> {
    if (!toolCall.function || !toolCall.function.name) {
      throw new Error("Invalid tool call data");
    }
    const toolName = toolCall.function.name;
    const toolArgs = JSON.parse(toolCall.function.arguments || "{}");

    console.log(chalk.blue(`\n🔧 调用工具: ${toolName}`));
    console.log(chalk.gray(`参数: ${JSON.stringify(toolArgs, null, 2)}`));

    const result = await this.callTool(toolName, toolArgs);
    return result;
  }

  private async generateFollowUpResponse(toolResult: string): Promise<string> {
    // 创建临时消息数组用于工具调用
    const tempMessages: MessageParam[] = [
      ...this.conversationHistory,
      {
        role: "user",
        content: toolResult,
      },
    ];

    console.log(chalk.blue("\n🤖 生成回答中..."));

    // 再次调用模型，加入工具调用结果 - 也使用流式输出
    const followUpResponse = await this.openAi.chat.completions.create({
      model: "deepseek-chat",
      messages: tempMessages,
      stream: true,
    });

    let followUpContent = "";
    for await (const chunk of followUpResponse) {
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) {
        followUpContent += delta.content;
        process.stdout.write(delta.content); // 实时输出内容
      }
    }

    console.log(); // 换行
    return followUpContent;
  }

  async processQuery(query: string) {
    try {
      // 添加用户消息到对话历史
      this.conversationHistory.push({
        role: "user",
        content: query,
      });

      const response = await this.openAi.chat.completions.create({
        model: "deepseek-chat",
        messages: this.conversationHistory, // 使用完整的对话历史
        tools: this.allTools,
        tool_choice: "auto",
        stream: true, // 启用流式输出
      });

      const finalText: string[] = [];

      // 处理流式响应
      const streamResult = await this.handleStreamResponse(response);

      // 如果有内容输出，添加到对话历史
      if (streamResult.content) {
        finalText.push(streamResult.content);
        this.conversationHistory.push({
          role: "assistant",
          content: streamResult.content,
        });
      }

      // 处理工具调用
      if (streamResult.toolCalls.length > 0) {
        const toolCall = streamResult.toolCalls[0];
        const toolName = toolCall.function.name;
        const toolArgs = JSON.parse(toolCall.function.arguments || "{}");

        const result = await this.handleToolCall(toolCall);

        finalText.push(
          `[Calling tool ${toolName} with args ${JSON.stringify(toolArgs)}]`
        );

        const followUpContent = await this.generateFollowUpResponse(result);
        finalText.push(followUpContent);

        // 只添加最终回复到对话历史，简化历史记录
        this.conversationHistory.push({
          role: "assistant",
          content: finalText.join("\n"),
        });
      }

      return finalText.join("\n");
    } catch (error) {
      logger.error("Error processing query:", error);
      throw error;
    }
  }

  clearConversationHistory() {
    this.conversationHistory = [];
    logger.info("Conversation history cleared");
  }

  getConversationHistory(): MessageParam[] {
    return [...this.conversationHistory]; // 返回副本，避免外部修改
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
        console.log(chalk.blue("\n🤖 AI 回答:"));

        try {
          const response = await this.processQuery(message);
          console.log(chalk.green("\n✅ 回答完成"));
        } catch (error) {
          console.log(chalk.red("\n❌ 处理失败"));
          logger.error("查询处理失败:", error);
        }

        console.log("\n" + chalk.gray("=".repeat(50)) + "\n");
      }
    } catch (error) {
      logger.log("Chat loop quit:", error);
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
    this.clearConversationHistory();
  }
}
