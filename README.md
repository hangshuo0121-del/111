# Web Agent

一个零依赖的网页版 Agent 原型，支持 API key 登录、移动端/桌面端聊天、文件附件、流式回复和结果下载。

## 运行

```bash
node server.js
```

打开：

```text
http://localhost:8787
```

手机在同一网络访问时，把 `localhost` 换成这台电脑的局域网 IP。

## API Key

默认在浏览器里输入 OpenAI API key。服务端不会把 key 写入磁盘，只在请求 OpenAI 时使用。

也支持 New API / OpenAI 兼容中转：

- 可以在登录窗口直接粘贴 `newapi_channel_conn` JSON，页面会自动填入 Key 和 API 地址。
- 也可以手动填写 API 地址，并把接口类型改成 `OpenAI 兼容 / New API`。
- 部署在 Render 这类公网服务器上时，API 地址必须是公网 HTTPS 地址。`http://localhost:3000` 只适合把本项目和 New API 都跑在同一台电脑上的本地调试。
- 本地调试如需访问 `localhost` 或内网 API 地址，启动服务时设置 `ALLOW_PRIVATE_API_BASE=1`。

也可以在服务器环境变量里设置：

```bash
OPENAI_API_KEY=sk-... node server.js
```

常用环境变量：

```bash
PORT=8787
HOST=0.0.0.0
DEFAULT_MODEL=gpt-5.5
OPENAI_BASE_URL=https://api.openai.com
OPENAI_API_MODE=responses
API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_BASE_URL=https://api.anthropic.com
ANTHROPIC_MAX_TOKENS=4096
ALLOW_PRIVATE_API_BASE=1
```

## 部署提示

### 免费公网部署：Render

这个仓库已经包含 `render.yaml`，可以直接部署到 Render 免费 Web Service。Render 会自动给你一个 HTTPS 地址，例如：

```text
https://personal-web-agent.onrender.com
```

实际地址会以 Render 创建成功后显示的为准。如果 `personal-web-agent` 被别人占用，Render 会让你换一个服务名。

部署步骤：

1. 把这个项目推到 GitHub、GitLab 或 Bitbucket。
2. 打开 https://dashboard.render.com/ 并注册/登录。
3. 选择 `New` -> `Blueprint`。
4. 连接这个仓库，确认 `render.yaml`。
5. 点击部署。

部署成功后，用 Render 显示的 `onrender.com` 地址访问即可。第一次打开免费服务可能会有一分钟左右冷启动。

### 生产安全提示

默认在浏览器里输入 OpenAI API key。服务端不会把 key 写入磁盘，只在请求 OpenAI 时使用。

如果你想让所有设备都不用重复输入 key，可以在 Render 的环境变量里设置 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY` 或 `API_KEY`。这样更方便，但任何拿到网页地址的人都可能消耗你的额度，所以公网使用前建议再加一层访问密码或账号系统。

真正独立的自定义域名，比如 `.com`、`.net`，通常不是永久免费。后续如果你买了域名，可以在 Render 里添加 Custom Domain，Render 会自动配置 HTTPS。
