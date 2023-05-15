#!/usr/bin/env node

import inquirer from "inquirer";
// @ts-ignore
import inquirerPrompt from 'inquirer-autocomplete-prompt';
import fs from "fs";
import { ChatGptClient } from "./util";
import { errorLog, successLog, warningLog } from "./ui";
import { NORMAL, ROLES } from "./role";

// 注册 autocomplete 类型
inquirer.registerPrompt('autocomplete', inquirerPrompt);

const CONFIG_DIR = `${process.env.HOME}/.chatmate`;
const KEY_FILE_PATH = `${CONFIG_DIR}/open_api_keys`;

async function main() {
  console.log("欢迎使用 Chatmate！\n");

  // 获取初始化参数
  const { openApiKey, temperature, role } = await getInitConfig();
  const client = new ChatGptClient({
    apiKey: openApiKey,
    temperature,
    role
  });
  await startConversation(client);
}

async function startConversation(client: ChatGptClient) {
  try {
    const { question } = await inquirer.prompt<{ question: string }>([
      {
        type: "input",
        name: "question",
        message: "请输入您的问题：",
      },
    ]);

    await client.createChatCompletion(question);
    await startConversation(client);
  } catch (error) {
    errorLog(error instanceof Error ? error.message : "出错啦！");
    await startConversation(client);
  }
}

async function getInitConfig(): Promise<{
  openApiKey: string;
  temperature: number;
  role: string;
}> {
  // 如果配置文件夹不存在则创建
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  const openApiKey = await getApiKey();
  // 用户输入思维发散程度和其他信息
  const { temperature, role } = await inquirer.prompt<{ temperature: number, role: string }>([
    {
      type: "number",
      name: "temperature",
      default: 0.7,
      message: "思维发散层度（0-2 之间，值越大结果越随机）",
      validate: async (value) => {
        if (value > 2 || value < 0) {
          return "请输入 0-2 之间的数";
        }

        return true;
      },
    },
    {
      type: "autocomplete",
      name: "role",
      default: NORMAL,
      message: "期望 GPT 扮演的角色（可输入关键词搜索）",
      source: (_: unknown, input: string) => {
        return ROLES.filter(item => item.act.match(input)).map(role => ({
          name: role.act,
          value: role.act
        }))
      }
      
    },
  ]);

  return {
    openApiKey,
    temperature,
    role
  }
}

async function getApiKey(): Promise<string> {
  let openApiKey = "";
  // 如果没有输入过 API key 则需要输入
  if (!fs.existsSync(KEY_FILE_PATH)) {
    const { key } = await inquirer.prompt<{ key: string }>([
      {
        type: "password",
        name: "key",
        message: "请输入您的 ChatGPT 的 API key：",
        validate: async (value) => {
          if (!value) {
            return "请输入您的 ChatGPT 的 API key!";
          }
          const client = new ChatGptClient({ apiKey: value });
          const valid = await client.checkAuth();

          return valid ? true : "请检查网络或 API key 是否正确！";
        },
      },
    ]);
    successLog("登录成功！\n");
    openApiKey = key;
    // 文件写入
    fs.writeFile(KEY_FILE_PATH, openApiKey, (err) => {
      if (err) {
        warningLog(`API key 写入存储失败！错误信息: ${err}`);
      }
      // 更改文件权限为仅可读
      fs.chmod(KEY_FILE_PATH, 0o444, (err) => {
        if (err) {
          warningLog(`更改文件权限失败！错误信息: ${err}`);
        }
      });
    });
  } else {
    openApiKey = fs.readFileSync(KEY_FILE_PATH).toString();
  }
  return openApiKey;
}

main();
