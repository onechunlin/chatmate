# Chatmate

集成AI和MCP的聊天伙伴

## 开发

### MCP Server

#### 构建 MCP Server

```bash
cd mcp-server
npm i
npm run build
```

构建完之后，命令行会提示 MCP 命令和参数

#### 调试 MCP Server

- 方式1：使用 inspector（推荐）
  + 启动 mcp 调试器
  + 填写 mcp 命令和参数
```bash
npx @modelcontextprotocol/inspector
```

- 方式2：使用 Cursor 等编辑器配置 Mcp Server