# cline-free · Cloudflare Workers 版

把 Cline（https://cline.bot）的白嫖模型能力转成 OpenAI 兼容 API，部署在 Cloudflare Workers 上，免费、无服务器、无需本地运行。

> 逆向自 https://github.com/luawei1/cline2api
>
> （Go 版代理），重写为纯 JS 的 Worker。

---

## 一、准备工作：获取 Cline 的 refreshToken ⭐（最关键）

要调用 Cline 的 API，需要一个 **refreshToken**（相当于 Cline 账号的"长期钥匙"，用它换每次请求用的 accessToken）。

本仓库提供 **四种获取方式**，任选其一：

> 💡 **已经部署好了？直接在控制台登录最省事**：打开 `https://<你的域名>/` → 「账号」页 →
> 点「登录新账号」，页面会显示授权链接和可点击的跳转按钮，授权完自动生效。
> 见下文「内置控制台」章节。注意这种方式拿到的账号是**临时的**（重启会丢），
> 控制台会把 refreshToken 给你，填进环境变量才能长期保留。

### 方式①：控制台内登录（已部署时最快）⭐

见「[在控制台里登录账号](#在控制台里登录账号v140-新增)」。适合已经部署好、想再加一个账号的场景。

### 方式②：命令行脚本（推荐，本仓库自带 `cline_oauth.py`）

脚本会启动 Cline 官方的 **WorkOS 设备授权码流程**，你在浏览器里登录一次即可，剩余全部自动：

```bash
# 1. 运行脚本，生成授权链接
python3 cline_oauth.py

# 2. 脚本会打印一个链接，类似：
#    https://authkit.cline.bot/device?user_code=XXXX-XXXX
#    在浏览器打开，用 Google / GitHub / 邮箱登录授权

# 3. 授权完成后，脚本自动轮询并打印 refreshToken
```

> 脚本内部做的（逆向自 auth.go）：
> 1. `POST api.workos.com/.../authorize/device` → 拿 device_code + 授权链接
> 2. 轮询 `api.workos.com/.../authenticate` → 授权成功后拿 WorkOS access_token
> 3. `POST api.cline.bot/api/v1/auth/register` → 用 WorkOS token 换 Cline 的 refreshToken

### 方式③：GitHub Actions 工作流（无需本地环境，手机上也能操作）⭐

仓库自带 `.github/workflows/get-token.yml` 工作流，**在手机上也能跑**：你只需在手机浏览器点开 TG 推送的授权链接完成登录，脚本在云端自动轮询，拿到的 refreshToken **只私发到你的 Telegram，绝不进 Actions 日志**。

**第一步：配置 TG 变量（强制，不配不运行）**

在仓库 **Settings → Secrets and variables → Actions** 里添加两个 secret：
- `TG_BOT_TOKEN`：你的 Telegram Bot 的 token
- `TG_CHAT_ID`：接收消息的 chat_id（你自己的 id）

> 缺任一个，工作流都会直接报错退出，不进入授权流程。

**第二步：手动触发**

1. 进入仓库 **Actions** 页 → 点击左侧 **「获取 Cline refreshToken」**
2. 点右边 **Run workflow** → 可选手动填授权等待秒数（默认 300）→ 运行
3. Telegram 会收到**授权链接 + 设备码** → 用手机/电脑浏览器打开，Google/GitHub/邮箱 登录授权
4. 授权成功 → TG 收到 **`refreshToken`**，直接复制填入 CF Worker 机密变量即可

**安全说明：**
- 🔒 `refreshToken` 与账号**邮箱都不会出现在 Actions 日志**（`::add-mask::` 双重打码 + 只推 TG）
- 🔁 工作流运行完自动**清理旧运行记录，只保留最新 1 条**
- ⏱️ 授权链接推送 TG 失败会中止，宁可失败也不把 token 写进日志

### 方式④：在原版 Go 程序里提取（如果你已经用过 cline2api）

1. 下载原版 [cline2api releases](https://github.com/luawei1/cline2api/releases) 的运行文件
2. 运行 `./cline-proxy --login`，浏览器登录 Cline
3. 打开 `~/.cline2api/.cline-accounts.json`，找到 `refreshToken` 字段，复制它

---

## 二、部署到 Cloudflare Workers

> ⚠️ **推荐方式：复制代码粘贴部署，不要用 Git 关联仓库部署。**
> 实测 GitHub 关联 CF 部署（Git 集成）容易因入口文件/构建环境问题导致部署失败，
> 且改环境变量后不会自动生效。用下方「复制代码」方式最稳、最快。

### 需要的东西

- 一个 Cloudflare 账号（免费注册：[dash.cloudflare.com](https://dash.cloudflare.com)）
- 上一步拿到的 `CLINE_REFRESH_TOKEN`

### 部署步骤（复制代码版，推荐 ✅）

1. 打开本仓库 `worker.js`，**全选复制全部代码**
2. 登录 [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **创建** → **创建 Worker**
3. 名字填 `cline2api`（可自定义）→ **部署**
4. 进入 Worker → **编辑代码** → 删除默认代码，**粘贴**刚才复制的 `worker.js` 全部内容 → **部署**（右上角）
5. **配置环境变量**（重点 ⚠️）：
   - Worker → **设置** → **变量和机密** → **添加**：
     - **机密(Secret)**：`CLINE_REFRESH_TOKEN` = 第一步拿到的 refreshToken（必填）
       - **支持多账号**：一行一个 token，见下文「多账号」章节
     - **机密(Secret)**：`API_KEY` = 你的访问密钥，例如 `sk-cline-xxx`（建议必填，可自定义）
   - ⚠️ **保存后必须再点一次「部署」触发重新编译**，变量才会生效！
6. 完成！你的 API Base URL 就是 `https://cline2api.<你的子域>.workers.dev`

> 💡 验证环境变量是否生效，访问诊断端点：
> ```bash
> curl https://cline2api.<你的子域>.workers.dev/v1/health
> ```
> 返回 `"api_key_configured":true` 表示 `API_KEY` 已生效，`account_count` 显示已配置的账号数量。
> 也可以直接浏览器打开根路径 `https://cline2api.<你的子域>.workers.dev/` 用内置控制台查看。

### 需要的东西&环境变量说明

| 变量名 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `CLINE_REFRESH_TOKEN` | 机密 Secret | ✅ | Cline 账号 refreshToken，**一行一个，支持多账号** |
| `API_KEY` | 机密 Secret | ✅ | 客户端访问密钥，自己设一个（如 `sk-cline-xxx`） |

> ⚠️ **`API_KEY` 现在是必填。** 早期版本在未配置时会回退到硬编码的
> `cline2api-default-key`，而该值是公开写在文档里的 —— 等于任何知道这个默认值的人
> 都能消耗你的 Cline 账号额度。v1.2.0 起改为 **fail-closed**：未配置 `API_KEY` 时，
> 聊天端点直接返回 401 并提示如何配置，不再回退到公开默认值。
> （`GET /` 控制台、`GET /v1/health`、`GET /v1/models` 不受影响，便于部署自检。）
>
> 变量名必须**完全一致**（全大写、无空格）。修改后**务必保存并重新部署**才会生效。

### 🖥 内置控制台（v2.0.0 像素终端风格）

部署后直接浏览器打开根路径即可使用，**无需额外前端、无需构建**：

```text
https://cline2api.<你的子域>.workers.dev/
```

界面是**左侧导航栏 + 右侧工作区**，视觉风格为**像素终端（PIXEL OPS）**：
深蓝黑底配单一青色强调、全直角、2px 描边、硬投影（位移块而非模糊）、
网格底纹与 CRT 扫描线、全站等宽字体。支持深/浅主题切换（浅色下自动关掉扫描线）。
左栏放品牌（像素 WiFi 图标 + 署名）、页面导航，以及**账号池指示器**
（每个账号一格，可用的亮起、冷却中的显示剩余分钟数，悬浮看冷却原因：额度用尽 / 空响应 /
鉴权失败；环境变量来的账号与登录得到的临时账号用不同样式区分）。五个页面：

| 页面 | 能做什么 |
|---|---|
| **对话测试** | 多轮对话（自动带上下文）、流式逐字输出、**随时停止生成**、思考过程折叠、右侧实时显示首字节/生成耗时/输出速度/token 数、导出记录、可选 system prompt 与 temperature/top_p |
| **账号** | 查看每个账号的状态卡片（来源、token 缓存、冷却）；**在网页里直接登录新的 Cline 账号**（见下） |
| **模型** | 只列出**确定免费**的模型（服务端已按白名单筛过），按**国产优先**排序（DeepSeek、智谱 GLM、通义千问等带厂商标签），可搜 ID、只看免费、只看国产；**测首字节延迟与输出速度**（单个或一键全部，测得样本后自动中止以省额度），可按速度/首字节排序、**复制模型 ID**、直接切到对话使用 |
| **日志** | **固定高度的滚动窗口**：日志再多也只在窗口内滚动，不会把页面撑长。顶部按全部/成功/失败/慢请求筛选并搜索模型名；右侧是**条目详情面板**（指标网格 + 请求体 + 原始响应，各自可复制），点行即看；「跟随最新」控制是否自动定位到最新。可导出 JSON |
| **接入配置** | 自动生成**可直接复制**的接入代码（cURL / Python / Node / Anthropic SDK / 环境变量），已填好你的地址、密钥、当前模型；含 1010、402、429 等常见错误的应对说明 |

> 📌 作者 **Patrick**，公众号 **AI实用talk**。

#### 在控制台里登录账号（v1.4.0 新增）

打开「账号」页点 **登录新账号**，页面会：

1. 向 Cline 申请一个设备授权码，**把授权链接显示出来**，并提供**可直接点击跳转的按钮**
   （不方便跳转时可以「复制链接」）；
2. 同时把**设备码**用大号字显示，附「复制设备码」按钮；
3. 你在浏览器里登录并授权后，**页面会自动检测到结果**并提示成功，不用手动回来点任何东西，
   下方有计时条显示授权剩余时间。

登录成功后该账号立即加入账号池可用，但**只在当前实例的内存里存活**：进程重启或重新部署就消失。
控制台会明确提示，并给出 refreshToken，让你填进环境变量 `CLINE_REFRESH_TOKEN`
（多账号一行一个）长期保留。想长期生效就走这一步，别只依赖控制台登录。

> 这两个登录端点（`/v1/login/start`、`/v1/login/poll`）**都要求 API_KEY**。
> 否则任何人都能借用你的 Worker 当 OAuth 代理去注册账号。

模型页的「输出速度」按上游返回的 token 数除以生成耗时计算（已扣除首字节等待时间），
单位为 token/秒；若上游未返回 token 数则退化为字符/秒。测速结果会保存在本机，
刷新页面不丢，悬浮单元格可以看到测量时间。

页面在异常时会给出可操作的提示（未配密钥、账号全在冷却、被 1010 拦截等）。
密钥、对话历史、日志与测速结果都只存在本机浏览器 localStorage，不上传别处。
控制台是**单文件自包含**的，不引用任何外部 JS/CSS，内网或离线部署也能正常打开。

> 本服务本身是**纯 API，没有 Web 前端**——访问根路径以外的未知路径会返回 404，
> 并在错误信息里列出可用端点。控制台只是自检/调试页面，不参与 API 调用。

### 🔁 多账号（额度用完自动切号）⭐

一个账号的免费额度/限流用完时，想切下一个号？不用改任何东西，**在 `CLINE_REFRESH_TOKEN` 里一行填一个 token 即可**：

```
第一个账号的refreshToken
第二个账号的refreshToken
第三个账号的refreshToken
```

**工作机制：**
- 🔄 **账号池轮询**：请求轮流使用不同账号（round-robin），分散单账号压力
- ⚡ **额度用完/限流自动切号**：某账号触发 429（`Daily free limit reached`）或空响应，
  **解析上游冷却提示**（如 `Try again in 2h 51m`），按实际时长冷却该账号并切换到下一个，同一请求换号重试
- 🚫 **失效自动跳过**：刷新失败的账号会被跳过，不阻塞
- ✅ **独立缓存**：每个账号各自的 accessToken 独立缓存，互不影响
- 🛡️ **全部冷却不空转**：所有账号均冷却时直接返回 `429` + `Retry-After`（不再打上游空转）
- 单账号时完全兼容，原样工作

**验证：** 部署后访问 `/v1/health`，返回 `account_count` 即当前账号数量，
`accounts_available` 是当前未被冷却、可立即使用的账号数。

### 验证部署

```bash
curl https://cline2api.<你的子域>.workers.dev/v1/models \
  -H "Authorization: Bearer <你的API_KEY>"
```
应返回模型列表。再发一次聊天：

```bash
curl https://cline2api.<你的子域>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer <你的API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"model":"poolside/laguna-s-2.1:free","messages":[{"role":"user","content":"你好"}]}'
```

### 本地运行（不部署也能用）⭐

想先在本机验证 token 好不好使，不用部署：

```bash
# 1. 准备配置（只需填 refreshToken）
cp .env.local.example .env.local
#    在 .env.local 里填 CLINE_REFRESH_TOKEN=<你的 refreshToken>
#    API_KEY 留空即可，启动时会自动生成并写回

# 2. 启动本地服务（等价于线上 Worker）
node local-server.js
#    浏览器打开 http://localhost:8787 即为控制台
#    自动生成的 API_KEY 会直接注入页面，不用手填

# 3. 本地自检（不需要真实账号，用假上游验证全部逻辑，68 项断言）
node selftest.mjs
```

`local-server.js` 把 Node 的 HTTP 请求转成 Web Request 交给 `worker.js` 处理，
SSE 流式同样能逐块透传，`worker.js` 本身不做任何改动。
它每次请求重新读取 `.env.local`，所以改了 token **不用重启服务**。

**关于 API_KEY**：本地首次启动会自动生成一个（形如 `sk-cline-xxxxxxxx...`）写入 `.env.local`，
并注入控制台页面，因此不用手填；若 `.env.local` 里已有值或用环境变量指定，则以你的为准。
线上部署（Cloudflare / Vercel）仍需自己设置这个变量，因为本地文件不会被部署上去。

---

## 三、部署到 Vercel（可选 ✅ 推荐备一条）

同一份代码可以**同时**部署到 Cloudflare Workers 和 Vercel，互为备份：

- `worker.js` → Cloudflare Workers 入口
- `api/index.js` → Vercel Edge Function 入口（逻辑与 `worker.js` 完全一致，仅入口/区域声明不同）
- `vercel.json` → 路由重写，把 `/v1/*` 指到 `/api/index`，**不用改**

> 💡 **什么时候值得加一条 Vercel**：CF Workers 域名对 `User-Agent` 挑得凶（非浏览器 UA 直接 `1010`），
> 而 Vercel 域名不挑 UA（curl / python / SDK 默认 UA 都能直连）。如果你的客户端不好自定义请求头，
> 用 Vercel 那条会更省事。

### 需要的东西

- 一个 Vercel 账号（Hobby 免费档即可：[vercel.com/signup](https://vercel.com/signup)）
- 上一步拿到的 `CLINE_REFRESH_TOKEN`
- **不需要**改代码、不需要 `package.json`、不需要构建命令（Framework Preset 选 `Other` 即可）

### 方式①：Vercel CLI 部署（最快）

```bash
# 1. 安装 CLI（已装可跳过）
npm i -g vercel

# 2. 登录
vercel login

# 3. 拉代码
git clone https://github.com/pingmike2/cline2api-workers.git
cd cline2api-workers

# 4. 首次关联项目（交互里选 Create new project，Framework Preset 选 Other）
vercel link

# 5. 配置环境变量（持久化到项目，多账号 refreshToken 一行一个）
vercel env add CLINE_REFRESH_TOKEN production
vercel env add API_KEY production

# 6. 部署到生产
vercel --prod
```

部署完成后地址是 `https://<项目名>.vercel.app`。

> ⚠️ 两个容易踩的点：
> - 环境变量要用 `vercel env add` 写入项目；`vercel --prod --env X=Y` 只对**当次部署**生效，不写进项目配置
> - **改过环境变量后必须重新 `vercel --prod`**，运行时才会读到新值

### 方式②：Dashboard 关联 Git（推送后自动部署）

1. 打开 [vercel.com/new](https://vercel.com/new) → **Import Git Repository** → 选 `pingmike2/cline2api-workers`
2. **Production Branch 选 `main`**（本仓库只有 main 一条分支，CF 和 Vercel 两份代码都在里面）
3. **Framework Preset 选 `Other`**，Root Directory 保持 `.`（⚠️ 不要填 `api`）→ Build / Output 全部留空
4. **Environment Variables** 添加：
   - `CLINE_REFRESH_TOKEN` = 你的 refreshToken（必填，一行一个支持多账号）
   - `API_KEY` = 你的访问密钥（必填，自己设一个，如 `sk-cline-xxx`；不设则聊天端点一律 401）
   - 环境至少勾 **Production**（想在预览环境测可再勾 Preview）
5. **Deploy**

之后 push 到 `main` 会自动部署；同样地，**改了环境变量要在 Deployments 里点一次 Redeploy** 才会生效。

### 验证部署

```bash
# 健康检查（无需鉴权）
curl https://<项目名>.vercel.app/v1/health
```

返回 `{"ok":true,"version":"2.0.3","api_key_configured":true,"account_count":1,"model":"cline-free/deepseek-v4.1-flash",...}` 即成功。

```bash
# 聊天测试
curl https://<项目名>.vercel.app/v1/chat/completions \
  -H "Authorization: Bearer ***" \
  -H "Content-Type: application/json" \
  -d '{"model":"cline-free/deepseek-v4.1-flash","messages":[{"role":"user","content":"你好"}]}'
```

### ⚠️ Vercel 部署的坑（实测）

1. **Deployment Protection 会挡住域名**：默认开启时，`项目名-账号.vercel.app`、
   `项目名-<hash>-账号.vercel.app` 这类域名会被 Vercel SSO 拦截（返回 302 跳
   `vercel.com/sso-api`），**只有生产别名 `项目名.vercel.app` 是公开可访问的**。
   如果三个域名全是 302，去 **Settings → Deployment Protection** 关掉 Vercel Authentication。
2. **只跑美区**：`api/index.js` 里写死了 `regions: ["iad1", "sfo1"]`（美国西部/东部）。
   要换区域就改这一行；去掉 `regions` 则跟随 Vercel 默认调度。
3. **Hobby 免费档有商用限制**，且无 SLA，适合自用/备用。
4. **Vercel 域名不挑 UA**（实测 curl / python-urllib 直连 200），CF Workers 域名则必须带浏览器 UA，
   否则 `error code: 1010`。两边都部署时，客户端可优先指向 Vercel 域名。

---

## 四、在 AgentScope 平台调用（模型接入）

把该 Worker 当作 OpenAI 兼容 API 接入 **AgentScope（QwenPaw / qwenpaw.agentscope.io）** 时：

### ⚠️ 关键：直接用 Workers 域名，不要用自定义域名

- **用 `https://cline2api.<你的子域>.workers.dev/v1`** 作为模型 **Base URL / API Base**。
- **不要用绑定的自定义域名**（如 `api.llm.xxx.com`）：AgentScope 平台对接时，
  自定义域名可能因证书/路由/鉴权头处理问题导致调用失败或鉴权不过，
  直接用 Workers 官方域名最稳。

### AgentScope 里怎么配（OpenAI 兼容模式）

- **API Base / Base URL**：`https://cline2api.<你的子域>.workers.dev/v1`
  （部分平台要求不带 `/v1` 的填写为 `https://cline2api.<你的子域>.workers.dev`，按平台提示试）
- **API Key**：填你设置的 `API_KEY` 值（如 `sk-cline-xxx`）
- **Model**：`deepseek/deepseek-v4-flash`（默认）或 `poolside/laguna-s-2.1:free`、`zai/glm-5.2`（付费，约 $0.0008/次）。
  `depth/deepseek-v4-flash` 是 `deepseek/deepseek-v4-flash` 的拼写别名，同款免费，任意前缀均可。

> 若 AgentScope 平台走的标准 OpenAI SDK，直接指定上述 base_url + api_key 即可。
> 若测试报 401，请确认 `API_KEY` 变量已在 CF 配置并重新部署过。

### ⚠️ 高级配置：给模型加自定义请求头（防 Workers 返回 1010）

**重要**：Cline 的 Workers 网关对**非浏览器 UA 的请求**可能直接拦截返回
**`1010`**（浏览器 / 非 Cloudflare Workers 页面访问报错）。你在 AgentScope 里配完
Base URL / API Key / Model 后，如果**一调用就报 1010 或连接失败**，十有八九是
请求头里的 `User-Agent` 太"机器"（如 curl / python-httpx / 平台默认 SDK UA）被网关挡了。

**解决办法**：在**模型的「高级设置 / 自定义请求头」**里加一个浏览器 UA：

```text
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36
```

**AgentScope 平台具体操作**：模型配置页 → 找到该模型的**高级设置 / 自定义 Headers（请求头）**区域，
新增一条请求头：
- 键（Key）：`User-Agent`
- 值（Value）：上面那串 Chrome 浏览器 UA

保存后重试即可，Workers 就会把它当成正规浏览器流量放行。

> 💡 记一下：**任何平台接这个 Worker 报 1010，第一反应就是补这个浏览器 UA 请求头**，
> 因为网关只按 UA 判是不是浏览器，跟你的 API Key 正不正确无关。加完 UA 还报 401 才去查 Key。

---

## 五、使用

```text
Base URL: https://cline2api.<你的子域>.workers.dev/v1   （或 https://<项目名>.vercel.app/v1）
API Key:  <你设置的 API_KEY>
Model:    cline-free/deepseek-v4.1-flash   （默认，免费）
```

兼容 OpenAI 客户端（`/v1/chat/completions`）和 Anthropic 客户端（`/v1/messages`，自动转换）。

### 可用模型（实测）

> 📌 `GET /v1/models` **只返回免费模型**（`:free` 后缀 + `FREE_WHITELIST` 实测确认的），
> 下表里标「付费」「已下架」的都不会出现在列表中——想用它们得按 ID 直接调用
> （调用本身能通，只是会消耗 credits 或直接失败）。

| 模型 ID | 结果 |
|---|---|
| `cline-free/deepseek-v4.1-flash` | ✅ **免费可用**（默认；逆向自官方插件 recommended-models 免费通道，无需 credits） |
| `deepseek/deepseek-v4-flash` | ✅ **免费可用**（需完整 Cline 客户端头 + 强制 stream，已修复） |
| `depth/deepseek-v4-flash` | ✅ **免费可用**（`deepseek/deepseek-v4-flash` 的拼写别名，同款，前端任一前缀均可） |
| `poolside/laguna-s-2.1:free` | ✅ **免费可用** |
| `z-ai/glm-5.3-flash` | ✅ **免费可用**（2026-09-19 修复，见下方 v1.1.8 说明） |
| `xiaomi/mimo-v2.5`、`minimax/minimax-m3` | ✅ **免费可用**（白名单登记） |
| `zai/glm-5.2` | ⚠️ **可用但付费**（不在 `/v1/models` 列表里），走 Cline 系统凭证，约 $0.0008/次 |
| `deepseek/deepseek-v4.1-flash` | ❌ **402 insufficient_credits**（付费档，余额不足；免费请用 `cline-free/` 前缀） |
| `cline-free/glm-5.2` | ❌ **已下架**（上游 404 `model not found`，2026-08-06 实测） |
| `cline-pass/*` | ❌ 403，需付费 cline-pass 订阅 |

> ⚠️ **2026-09-21 更新（v2.0.3）：模型列表恢复白名单过滤** ⭐
> - **只返回确定免费的模型**：列表放行两类——名字带 `:free` 后缀的，以及
>   `FREE_WHITELIST` 里人工实测确认免费的（`deepseek/deepseek-v4-flash`、
>   `z-ai/glm-5.3-flash`、`xiaomi/mimo-v2.5`、`minimax/minimax-m3`、
>   `poolside/laguna-s-2.1`、`cline-free/*` 等）。**其余上游模型一律不进列表**，
>   客户端拿到的都是确定能白嫖的，不会白试出 402 / 403。
>   动机：上游 `/v1/models` 完全不含价格字段，无法判断谁免费；
>   与其列出 400 个里绝大多数要付费的，不如只列实测能用的。
> - **`/v1/models` 不再返回 `cost=unknown`**：既然列表已按免费筛过，`cost` 恒为
>   `free`。新增 `channel` 字段标明这条"免费"的依据来源，便于排查：
>   `free`（官方 free 数组）/ `recommended`（官方推荐）/ `verified`（白名单实测）/
>   `free-suffix`（仅靠 `:free` 后缀）。控制台对应显示「免费 / 推荐 / 实测免费」。
> - **保留 v2.0.2 的两处正确修正**：`:batch` 后缀排除（批处理通道拿不到内容）、
>   `~` 前缀去波浪号对外（原始 ID 存 `upstream`）。因为白名单生效后
>   `~deepseek/deepseek-v4-flash-0731` 去波浪号会与本体同名，顺带加了**按 ID 去重**，
>   避免同一模型在客户端出现两次。
> - **`cline-free/*` 仍会从 `recommended-models` 的 `free` 数组补入**：这些模型不在
>   `/v1/models` 里，不补就会漏掉官方免费通道（默认模型自己也会从列表消失）。
>
> ⚠️ **2026-09-21 更新（v2.0.2）：实测校正模型过滤规则**（`:batch` / `~` 两处修正仍有效；
> 其中的"全量返回"已被 v2.0.3 改回白名单，见上）
> 用真实调用逐个验证后修正了两处判断错误：
> - **`:batch` 后缀确认排除**：实测 6/6 全部「HTTP 200 但 content 为空」，
>   走普通对话接口拿不到内容，属批处理专用通道，排除正确。
> - **`~` 前缀别名改为保留（此前误删）**：之前当作"与真实模型重复的别名"排除掉，
>   实测 4/4 全部正常返回内容。现已保留并去掉波浪号对外（`~deepseek/deepseek-pro-latest`
>   → `deepseek/deepseek-pro-latest`），**补回 18 个可用模型**。原始 ID 保留在
>   `upstream` 字段便于排查。
> - 模型总数：446（上游原始）− 74（`:batch`）= **375 个**。默认「只看免费」显示 34 个。
> - 顺带把默认「只看免费」勾选恢复（此前误改为不勾选，导致 375 条全铺出来显得又多又杂），
>   并记住用户的选择；标题改为「上游拉取 N 个 · 当前显示 M 个」，让筛选关系一目了然。
>
> ⚠️ **2026-09-21 更新（v2.0.1）：模型列表恢复全量返回**（**已被 v2.0.3 改回白名单**，见上）
> - **修掉「模型变少」的根因**：此前有一张 `FREE_WHITELIST`，只放行带 `:free` 后缀和
>   白名单里的十几个模型，把上游其余 **400+ 个模型全部隐藏**。现在改为**原样返回上游拉取到的全部模型**。
>   实测数量从 **27 个 → 357 个**（446 个原始模型，减去 74 个 `:batch` 批处理通道和
>   15 个 `~` 滚动别名）。我抽样实测了新放出的 8 个模型
>   （`deepseek/deepseek-v4.1-flash`、`z-ai/glm-5.3`、`qwen/qwen3.8-27b`、`openai/gpt-6-astra`、
>   `anthropic/claude-opus-5`、`google/gemini-3.8-flash`、`tencent/hy4-preview` 等）**全部真实可用**。
> - **价格标注不再靠猜**：上游 `/v1/models` 的对象只有 `id/object/created/owned_by`，
>   **完全不含价格字段**，当初的白名单就是因为"猜不出谁免费"才写的。现在改用官方
>   `recommended-models` 接口的**四个权威分类数组**（`free` / `recommended` / `clinePass` / `clineCloud`）
>   来标注渠道，并新增 `channel` 字段；无分类信息的模型标"未标价"，
>   不再谎称免费、也不再吓人地标成付费。控制台会显示「免费 / 推荐 / 需订阅 / 云额度 / 未标价」。
> - 顺带修正：`cline-free/*` 这类只存在于 `free` 数组、不在 `/v1/models` 里的官方免费模型，
>   之前会被漏掉，现在会正确补入模型池。
>
> ⚠️ **2026-09-21 更新（v2.0.0）：换成像素终端风格 + 项目更名 cline-free** ⭐
> - **项目更名为 cline-free**，控制台改用**像素终端（PIXEL OPS）风格**：深蓝黑底 + 单一青色强调、
>   全直角、2px 描边、硬投影（位移块而非模糊）、网格底纹 + CRT 扫描线、全站等宽字体。
>   附带深/浅双主题（浅色下自动关闭扫描线，避免白底叠暗线显脏）。
> - **新图标：像素 WiFi**，16×16 网格上 1 像素为单位的 15 条 `rect` 组成，
>   左右严格像素级对称（脚本生成 + 实测不对称像素数为 0），浏览器标签页图标同步更换。
> - **署名**：作者 **Patrick**，公众号 **AI实用talk**（左栏底部）。
> - **日志改为固定高度的滚动窗口**：日志再多也只在窗口内滚动，不会把页面撑长；
>   顶部有全部/成功/失败/慢请求筛选与搜索，右侧是**条目详情面板**（指标网格 + 请求体 +
>   原始响应，各自可复制），点击任意一行即可查看；「跟随最新」开关控制是否自动定位到最新。
> - **模型页国产优先**：内置国产厂商识别表（DeepSeek、智谱 GLM、通义千问、小米、MiniMax、
>   月之暗面、蚂蚁 inclusionAI 等），**国产模型默认排在前面**并带「DeepSeek / 智谱 GLM」等标签，
>   海外模型标其厂商名；新增「只看国产」筛选与「国产模型」计数。
> - **布局改为填满视口**：上一版页面底部有大片空白（内容按内容高度排版）。
>   现在壳层固定视口高度、各视图内部滚动，对话页左栏撑满剩余高度、右栏独立滚动。
>
> ⚠️ **2026-09-21 更新（v1.4.0）：控制台改版 + 可在页面里登录账号** ⭐
> - **控制台重新布局**：改为**左侧导航栏 + 右侧工作区**。上一版把品牌、账号池、状态
>   全挤在顶部一行，三者互相抢注意力；现在品牌与导航在左栏、账号池单独成块、
>   当前页面有自己的标题与说明。
> - **新增「账号」页，可在网页里直接登录 Cline 账号**：点「登录新账号」会申请设备授权码，
>   页面**展示授权链接**并给出**可点击跳转的按钮**（也可复制链接 / 复制设备码），
>   授权完成后页面自动轮询检测并提示成功，无需再跑 Python 脚本。
>   新增后端端点 `POST /v1/login/start` 与 `POST /v1/login/poll`（**均要求 API_KEY**，
>   否则等于开放 OAuth 代理）。
> - **登录得到的账号是临时的**：只存在当前实例内存，重启或重新部署后消失，控制台会明确提示，
>   并给出 refreshToken 供你填进环境变量长期保留。账号卡片会标注「来源：登录（临时）/环境变量」。
> - **设计系统收敛**：字号从 12 种零散取值收敛为 6 级阶梯，圆角锁定一套，
>   单一强调色（青绿）全局一致；并修掉一处把 Markdown 粗体写进 HTML、导致页面直接显示
>   `**文字**` 的问题。
> - **修移动端横向溢出**：窄屏下左栏导航被裁掉（只能看到前 3 项）、配置页被撑到 1018px。
>   原因是 `overflow-y: auto` 会隐式把 `overflow-x` 也变成 auto 从而裁剪内容，
>   以及 `.split` 断点（960px）晚于左栏占宽。已改为换行布局并把断点提到 1100px。
> - **本地服务支持热重载**：改完 `worker.js`（尤其跑过 `build-console.mjs` 之后）会自动重新加载。
>   这个坑很隐蔽：Node 会缓存 ESM 导入，重新构建后旧进程仍返回旧页面，排查时极易误判成"改动无效"。
>
> ⚠️ **2026-09-20 更新（v1.3.0）：控制台重新设计 + 测速 / 复制 ID / 日志增强** ⭐
> - **控制台整体重做**：统一设计变量与单一强调色（Cline 青绿），页头新增**账号池指示器**
>   （每个账号一格，可用与冷却一眼可见，悬浮看剩余冷却时间与原因），四个页面全部重新排版。
>   动效只保留有语义的（状态切换、进度、确认反馈），并尊重 `prefers-reduced-motion`。
> - **API_KEY 不用再手填**：本地运行 `node local-server.js` 会**自动生成**密钥，写入
>   `.env.local` 并注入控制台页面；已有自定义值或环境变量时不会覆盖。
>   线上部署仍需在环境变量里设置（本地文件不会被部署）。
> - **模型页新增输出速度（token/秒）**：点「测试」真实调用一次，测出**首字节延迟**与
>   **输出速度**（按上游返回的 token 数 ÷ 生成耗时，已扣除首字节等待），
>   拿到足够样本后立即中止以少耗额度。表头可按速度/首字节排序，顶部汇总平均速度、
>   最快速度、最快首字节。**测速结果会保存，刷新页面不丢**（悬浮显示测量时间）。
> - **模型页新增「复制 ID」**：一键复制模型 ID，方便直接粘进客户端配置。
> - **日志页大幅增强**：顶部汇总（请求总数、成功率、成功/失败、平均首字节、平均总耗时、
>   平均速度、输出 token 合计）；可按成功/失败/慢请求筛选并搜索模型名；
>   每条可展开查看**首字节、生成耗时、总耗时、输入/输出/思考 token、输出字符、结束原因、
>   上下文条数**，以及完整**请求体**与**原始响应**（各自可复制）；支持导出 JSON。
>   日志与筛选状态都会持久化。
> - **修正一处文档不实说明**：`worker.js` 顶部原写「API_KEY 不设置则每次部署随机生成并打印到日志」，
>   但**该逻辑从未实现过**，当时实际行为是回退到公开的 `cline2api-default-key`。
>   现已改为 fail-closed，并在注释中说明；本地运行则自动生成，不再需要手填。
>
> ⚠️ **2026-09-20 更新（v1.2.1）：控制台升级为实用工作台** ⭐
> - **多轮对话**：控制台不再是单次问答，自动携带上下文，流式逐字输出，可**随时停止生成**，
>   思考过程（reasoning）折叠展示，每条回复显示 TTFT / 总耗时 / token 数，可导出 Markdown。
> - **接入配置页**：自动生成可直接复制的接入代码（cURL / Python / Node / Anthropic SDK /
>   环境变量），地址、密钥、当前模型全部自动填好，不用再手抄 base_url。
> - **模型页**：免费/付费标注、按 ID 搜索、只看免费筛选、一键测试单个或全部模型
>   （测量首字节延迟，拿到首块即中止以省额度）、一键把某模型切到对话使用。
> - **调试页**：最近 30 次请求日志（状态/TTFT/耗时）、最后一次原始请求体与 SSE 响应，便于排查。
> - **错误智能提示**：把 401 / 402 / 429 / 1010 / 404 等错误翻译成可操作的建议
>   （例如 1010 → 提示补浏览器 UA 或换 Vercel 域名）。
> - **修复控制台模型误标为付费**：原先前端按模型名猜免费与否，导致
>   `deepseek/deepseek-v4-flash`、`z-ai/glm-5.3-flash`、`poolside/laguna-s-2.1`、
>   `minimax/minimax-m3`、`xiaomi/mimo-v2.5`、`deepseek/deepseek-v4-flash-0731`
>   **这 6 个实际免费的模型被标成「付费」**。现在 `/v1/models` 直接返回服务端已知的
>   `cost` / `free` 字段（附在标准响应上，普通客户端会忽略），前端据此标注。
> - **前端源码独立成文件**：控制台改到 `console.src.html` 维护，由 `build-console.mjs`
>   自动转义后注入 `worker.js`，不再需要在大段模板字符串里小心翼翼地编辑。
>
> ⚠️ **2026-09-20 更新（v1.2.0）：修复 4 个 bug + 内置控制台 + 本地运行** ⭐
> - **流式响应被完整缓冲（性能 bug）**：旧实现在转发客户端前会 `await resp.clone().text()`
>   把上游整个流读完，导致**首个字节要等模型全部生成完才到达**（实测 TTFT ≈ 总耗时，
>   即"假流式"）。现已改为成功响应立即转发，实测 TTFT 从 100% 降到约 38%
>   （300 字长文：首字节 2.9s / 完成 7.7s）。
> - **账号池每个请求都被重建（额度/冷却逻辑 bug）**：上游 `/auth/refresh` 会轮换
>   `refreshToken`，代码会把新 token 存回账号对象；而旧的重建判据是"池内 token 与环境变量
>   是否逐位相同"，因此每次请求都判定"账号变了"→ 重建整个池，**连带清空 accessToken 缓存
>   和冷却状态**。后果：每个请求多打一次上游鉴权接口；单账号额度用尽（429）时会拿同一个号
>   重试满 5 次才失败，而非立即切号。现改为按**环境变量原文**判断重建，缓存与冷却得以保留。
> - **默认 API Key 后门（安全问题）**：未配置 `API_KEY` 时旧实现回退到硬编码的
>   `cline2api-default-key`，而该值公开写在文档里 → 知道它的人都能白用你的账号额度。
>   现改为 **fail-closed**：未配置时聊天端点直接 401 并提示如何配置。
> - **Anthropic 流式协议不完整**：旧实现缺少 `message_start` / `content_block_start`，
>   工具调用被塞成无对应 `tool_use` 块的 `input_json_delta`，对协议校验严格的 Anthropic SDK
>   会解析失败。现已按协议补全全部事件，工具调用与非流式 `tool_use` 块也不再丢。
> - **新增内置控制台**：浏览器打开根路径即可自检（健康状态 / 模型列表 / 试聊天 / TTFT 显示），
>   无需额外前端与构建。
> - **新增本地运行**：`node local-server.js` 不部署也能跑（读 `.env.local`）；
>   `node selftest.mjs` 用假上游验证全部逻辑（38 项断言）。
> - **`api/index.js` 改为自动生成**：`node build-vercel.mjs` 从 `worker.js` 生成，
>   不再需要人工同步两份代码。
>
> ⚠️ **2026-09-19 更新（v1.1.8）：剥离 `max_tokens`，解锁更多免费模型** ⭐
> - **根因**：上游对免费模型的请求体只要带 `max_tokens` 字段，一律返回
>   500 `{"error":"empty response content"}`——与请求头无关（指纹头齐全也照炸），
>   是请求体字段触发。不带该字段即 200。
> - **修复**：worker 构造上游 body 时不再注入 `max_tokens`（客户端传了也直接忽略）。
>   已知代价：上游按自己节奏生成，客户端无法靠 `max_tokens` 提前截断输出。
> - **收益**：`z-ai/glm-5.3-flash`（免费、带 reasoning）实测 200 可用；
>   其余 `:free` 后缀模型同理受益——只要上游模型列表里标注免费的，理论上都能通，
>   以 `GET /v1/models` 实际返回为准。GUI 的"测试模型"功能（固定发 `max_tokens:1`）
>   之前必 500，现在也能正常测延迟了。

> ⚠️ **2026-09-16 更新：接入 DS V4.1 Flash 免费通道** ⭐
> - **`cline-free/` 前缀 = Cline 官方插件免费通道**。官方插件（VS Code / JetBrains）通过
>   `GET https://api.cline.bot/api/v1/ai/cline/recommended-models` 拉取模型列表，返回体里的
>   **`free` 数组**就是免 credits 的模型，其中 `cline-free/deepseek-v4.1-flash` 为当前主力。
> - **关键区别**：不带前缀的 `deepseek/deepseek-v4.1-flash` 是**付费档**（余额不足直接 402
>   `insufficient_credits`）；只有 `cline-free/deepseek-v4.1-flash` 走官方免费额度。
> - worker 每次刷新模型列表时会**同时拉取 `recommended-models`**，把 `free` 数组合并进模型池，
>   官方日后调整免费模型可自动跟进，无需改代码。
> - `forceStream`（非流式强制走上游 stream）已扩展到 `cline-free/` 与 `cline-pass/` 前缀。

> ⚠️ **2026-08-06 更新**：
> - **`cline-free/glm-5.2` 上游已下架**：该免费模型名在 Cline 上游返回 404 `model not found`（非请求头问题，
>   与 deepseek 同款 Cline 指纹头仍返回 200）。同模型的付费通道 `zai/glm-5.2` 可用（约 $0.0008/次，
>   走 Cline 系统凭证），`cline-pass/glm-5.2` 需订阅返回 403。
> - 若你的 AgentScope 里还配着 `cline-free/glm-5.2`，请改配 `deepseek/deepseek-v4-flash`（免费）或 `zai/glm-5.2`（付费）。
>
> ⚠️ **2026-08-05 修复记录**：
> - **403 "only available via Cline product surfaces"**：worker 请求头太精简，被官方识别为第三方调用。
>   修复：补齐完整 Cline 客户端指纹头（`User-Agent: Cline/3.0.47`、`HTTP-Referer`、`X-CLIENT-TYPE: cline-sdk`、
>   `X-CLIENT-VERSION`、`X-PLATFORM` 等），`deepseek/deepseek-v4-flash` 和 `cline-free/glm-5.2` 恢复可用。
> - **非流式 500 "empty response content"**：上游对免费通道（deepseek + cline-free）的非流式请求限流，但流式正常。
>   修复：客户端要非流式时，worker 强制上游走 stream，聚合 chunks 后返回非流式响应。
> - **429 "Daily free limit reached"**：不是 bug，是**账号每日免费额度**用完（`Try again in Xh Xm`）。
>   这是 Cline 官方对免费模型的日配额，等冷却结束自动恢复；多账号可缓解（`CLINE_REFRESH_TOKEN` 多行填多个 token）。
> - **多账号 429 自动切号**：429 限流时自动解析上游冷却时长（如 `Try again in 2h 51m`），
>   冷却该账号并切换到下一个可用账号重试同一请求；所有账号均冷却时直接返回上游响应，不空转。

---

## 六、项目结构

```
.
├── worker.js               # Cloudflare Workers 入口（唯一逻辑源，控制台 HTML 内联其中）
├── console.src.html        # 控制台页面源码（改前端改这个，别改 worker.js 里那份）
├── build-console.mjs       # 把 console.src.html 注入 worker.js ⭐
├── api/index.js            # Vercel Edge Function 入口（由 build-vercel.mjs 自动生成，勿手改）
├── build-vercel.mjs        # 从 worker.js 生成 api/index.js（保证两端逻辑一致）
├── local-server.js         # 本地运行入口（node local-server.js，不部署也能跑）⭐
├── selftest.mjs            # 自检脚本（node selftest.mjs，56 项断言，用假上游验证）⭐
├── vercel.json             # Vercel 路由重写：/v1/* → /api/index
├── wrangler.toml           # CF 命令行部署配置（用复制代码方式可忽略）
├── cline_oauth.py          # 获取 CLINE_REFRESH_TOKEN 的脚本 ⭐
├── .env.local.example      # 本地运行配置模板（复制为 .env.local 后填 token）
├── .env.local              # 本地运行的 token 配置（已在 .gitignore 中，不会提交）
├── .github/workflows/
│   └── get-token.yml       # 手动运行的工作流：在 TG 上获取 refreshToken
├── README.md               # 本文件
└── README-vercel.md        # Vercel 版补充说明（历史文档，主体见本文件第三章）
```

### 改了代码之后要跑什么

```bash
# 只改了 worker.js（后端逻辑）：同步 Vercel 入口
node build-vercel.mjs

# 只改了 console.src.html（控制台前端）：注入 worker.js，再同步 Vercel
node build-console.mjs && node build-vercel.mjs

# 改完随手验证（不需要真实账号）
node selftest.mjs
```

> ✅ **两份入口不会再不一致了**：`api/index.js` 由 `build-vercel.mjs` 从 `worker.js`
> 自动生成（只替换入口声明块，其余逻辑原样拷贝）。
>
> ✅ **控制台前端可正常编辑**：源码放在 `console.src.html`，由 `build-console.mjs`
> 自动转义（`\`、反引号、`${`）后注入 `worker.js` 的模板字符串。
> 若你只部署 Cloudflare（不需要 Vercel），可跳过 `build-vercel.mjs`。

## 七、获取 refreshToken 常见问题

**Q: 谁能看到我的 refreshToken？**
→ 只有你。它存在 CF Workers 的**机密变量**里（加密存储，代码里看不到、日志里不显示）。不要把 `wrangler.toml` 里的变量跟真实 refreshToken 混写，机密务必用 `wrangler secret` 或 Dashboard 的"机密"类型。

**Q: refreshToken 会过期吗？**
→ 会，但 Cline 的 refreshToken 有效期较长。如果将来请求返回 401/403 token 失效，重新跑 `cline_oauth.py` 拿新的即可。

**Q: 免费额度够用吗？**
→ `cline-free/deepseek-v4.1-flash`（默认）、`deepseek/deepseek-v4-flash`、`poolside/laguna-s-2.1:free` 和 `z-ai/glm-5.3-flash` 都是免费模型。
   deepseek 有**每日免费额度**（用尽返回 429 "Daily free limit reached"，数小时后恢复）；
   多账号可缓解（`CLINE_REFRESH_TOKEN` 多行填多个 token，额度用尽自动切号）。
   `zai/glm-5.2` 为付费模型（约 $0.0008/次），走 Cline 系统凭证，无每日额度限制。

---

## 许可

本项目基于 [luawei1/cline2api](https://github.com/luawei1/cline2api)（Go 版）逆向重写，遵循其原许可证：

**MIT License** © 2026 [luawei1](https://github.com/luawei1)（原版）& [pingmike2](https://github.com/pingmike2)（Workers 版）· 详见 [LICENSE](LICENSE)

Workers 版改动部分同样以 MIT 协议开源。
