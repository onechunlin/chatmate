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

export type MessageParam = ChatCompletionMessageParam;

const spinner = ora({
  prefixText: chalk.gray("\n请求数据中，请稍后"),
  spinner: "soccerHeader",
});

export class MCPClient {
  private mcp: Client;
  private openAi: OpenAI;
  private transport: StdioClientTransport | null = null;
  private tools: ChatCompletionFunctionTool[] = [];

  constructor() {
    const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
    if (!DEEPSEEK_API_KEY) {
      throw new Error("DEEPSEEK_API_KEY is not set");
    }

    this.openAi = new OpenAI({
      baseURL: "https://api.deepseek.com",
      apiKey: DEEPSEEK_API_KEY,
    });
    this.mcp = new Client({ name: "mcp-client-cli", version: "1.0.0" });
  }

  async connectToServer(serverScriptPath: string) {
    try {
      const isJs = serverScriptPath.endsWith(".js");
      const isPy = serverScriptPath.endsWith(".py");
      if (!isJs && !isPy) {
        throw new Error("Server script must be a .js or .py file");
      }
      const command = isPy
        ? process.platform === "win32"
          ? "python"
          : "python3"
        : process.execPath;

      this.transport = new StdioClientTransport({
        command,
        args: [serverScriptPath],
      });
      await this.mcp.connect(this.transport);

      const toolsResult = await this.mcp.listTools();
      this.tools = toolsResult.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));
      logger.warn(
        "Connected to server with tools:",
        this.tools.map((tool) => tool.function.name)
      );
    } catch (e) {
      logger.error("Failed to connect to MCP server: ", e);
      throw e;
    }
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
        tools: this.tools,
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
          const result = await this.mcp.callTool({
            name: toolName,
            arguments: toolArgs,
          });
          finalText.push(
            `[Calling tool ${toolName} with args ${JSON.stringify(toolArgs)}]`
          );

          messages.push({
            role: "user",
            content: result.content as string,
          });

          const response = await this.openAi.chat.completions.create({
            model: "deepseek-chat",
            messages,
            stream: false,
          });

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
        const processingSpinner = ora({
          text: `处理查询: "${message.slice(0, 30)}${
            message.length > 30 ? "..." : ""
          }"`,
          spinner: "dots",
        });
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
    await this.mcp.close();
  }
}
