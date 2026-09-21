/**
 * cline2api - Cloudflare Workers 版
 *
 * 逆向自 https://github.com/luawei1/cline2api (Go 版反向代理)
 *
 * 核心逻辑：
 *  1. 每次请求用 refreshToken 换 accessToken（缓存到内存，过期自动刷新）
 *  2. 把 OpenAI / Anthropic 请求转发到 https://api.cline.bot/api/v1/chat/completions
 *  3. SSE 流式响应剥掉上游 {data:{...}} 包装，透传给客户端
 *
 * 环境变量：
 *  - CLINE_REFRESH_TOKEN (必需)  Cline 账号的 refreshToken，一行一个支持多账号
 *  - API_KEY           (必需)  客户端访问密钥；未配置时聊天端点一律返回 401（fail-closed）
 *
 * 关于 API_KEY 的说明（澄清一处上游文档错误）：
 *   早期注释写的「不设置则每次部署随机生成并打印到日志」从未实现过，
 *   当时实际行为是回退到硬编码的公开默认值 cline2api-default-key，
 *   等于把账号额度开放给任何知道该默认值的人。现在改为 fail-closed：
 *   没配 API_KEY 就拒绝，绝不回退到公开默认值。
 *   （本地运行 node local-server.js 时会自动生成并写入 .env.local，无需手填。）
 *
 * 用法（OpenAI 兼容）：
 *   curl https://你的worker/v1/chat/completions \
 *     -H "Authorization: Bearer <API_KEY>" \
 *     -H "Content-Type: application/json" \
 *     -d '{"model":"cline/deepseek-v4-flash","messages":[{"role":"user","content":"hi"}]}'
 */

const CLINE_API_BASE = "https://api.cline.bot/api/v1";

// WorkOS 设备授权流程（与 cline_oauth.py 同源），用于控制台里点按钮登录账号
const WORKOS_DEVICE = "https://api.workos.com/user_management/authorize/device";
const WORKOS_AUTH = "https://api.workos.com/user_management/authenticate";
const CLINE_REGISTER = "https://api.cline.bot/api/v1/auth/register";
const WORKOS_CLIENT_ID = "client_01K3A541FN8TA3EPPHTD2325AR";

// 账号池：支持多个 Cline 账号，每个账号独立缓存 accessToken
// CLINE_REFRESH_TOKEN 环境变量可包含多行，每行一个 refreshToken，
// 额度用尽(空响应)时自动轮换下一个账号。
// 结构：{ refreshToken, accessToken, expiry, cooldownUntil }
let accounts = [];
// 运行时通过控制台登录追加的账号。只存在当前实例内存里，**重启或部署后消失**，
// 因此登录成功后必须把 refreshToken 存进部署环境变量才算真正落地。
let dynamicAccounts = [];
let accountIndex = 0;          // round-robin 游标
let currentAccount = null;     // 当前正在使用的账号（串行队列下安全）

// 模型列表：原样使用 Cline /v1/models 返回的完整模型 ID。
// 不人为添加 cline/ 前缀；Telegram 会完整显示这些 ID，避免不同供应商模型名被截断后混淆。
const MODELS = [
  { id: "cline-free/deepseek-v4.1-flash", upstream: "cline-free/deepseek-v4.1-flash", provider: "cline", cost: "free" },
  { id: "deepseek/deepseek-v4-flash", upstream: "deepseek/deepseek-v4-flash", provider: "deepseek", cost: "free" },
  { id: "poolside/laguna-s-2.1:free", upstream: "poolside/laguna-s-2.1:free", provider: "poolside", cost: "free" },
  { id: "cline-pass/glm-5.2", upstream: "cline-pass/glm-5.2", provider: "zai", cost: "pass" },
  { id: "cline-pass/deepseek-v4-flash", upstream: "cline-pass/deepseek-v4-flash", provider: "deepseek", cost: "pass" },
  { id: "cline-pass/qwen3.7-max", upstream: "cline-pass/qwen3.7-max", provider: "qwen", cost: "pass" },
  { id: "zai/glm-5.3-flash", upstream: "zai/glm-5.3-flash", provider: "zai", cost: "free" },
];

// ============ 动态模型列表 ============
// 优先从 Cline 官方 /v1/models 拉取, 失败回退到上面内置列表。
// 每 10 分钟刷新一次缓存。

// 免费模型白名单：人工实测确认免费、但名字里没有免费标记的模型。
//
// 为什么需要它：上游 /v1/models 每个对象只有 id/object/created/owned_by 四个
// 字段，**完全不含价格信息**，无法从响应里判断谁免费。所以模型列表只放行两类：
//   1) 名字里带 :free 后缀的（上游明确的免费标记）
//   2) 下面这张白名单里实测确认免费的
// 其余一律不进列表——列表只列"确定能白嫖"的，客户端不会拿到 402/403 白试。
//
// 维护方式：实测确认免费就加进来，发现失效（404 / 402）就删掉。
const FREE_WHITELIST = [
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-flash-0731",
  "z-ai/glm-5.3-flash",
  "z-ai/glm-5.2:free",
  "xiaomi/mimo-v2.5",
  "minimax/minimax-m3",
  "poolside/laguna-s-2.1",
  "cline-free/deepseek-v4.1-flash",
  "cline-free/muse-spark-1.3-contributor",
  "cline-free/solar-pro4",
];

let modelsCache = null;
let modelsCacheTime = 0;
const MODELS_TTL = 10 * 60 * 1000; // 10 分钟

async function refreshModels() {
  try {
    const now = Date.now();
    if (modelsCache && now - modelsCacheTime < MODELS_TTL) {
      return modelsCache;
    }
    const resp = await fetch(CLINE_API_BASE + "/models", {
      headers: { "User-Agent": "Mozilla/5.0 (cline2api)" },
    });
    if (!resp.ok) {
      console.log("[models] 官方拉取失败 HTTP", resp.status, "回退内置列表");
      return MODELS;
    }
    const data = await resp.json();
    if (!data || !Array.isArray(data.data) || data.data.length === 0) {
      return MODELS;
    }
    // 只放行**确定免费**的模型，其余全部丢弃（见 FREE_WHITELIST 注释）。
    // 判据只有两条：
    //   1) 名字里带 :free 后缀 —— 上游明确的免费标记
    //   2) FREE_WHITELIST 里人工实测确认免费的
    // 上游 400+ 个模型里绝大多数既不满足 1 也不在 2，一律不进列表。
    //
    //   :batch 后缀 —— 额外排除。这类是上游的批处理专用通道，实测 6/6 全部
    //     "HTTP 200 但 content 为空"，即使名字带 :free 也走不通普通对话接口。
    //
    //   ~ 前缀 —— 仅对通过筛选的模型生效：波浪号在 URL/配置里容易被转义或
    //     误处理，所以去掉后对外，原始 ID 留在 upstream 字段便于排查。
    const baseList = data.data
      .filter((m) => {
        const id = (m.id || "").replace(/^~/, "");
        if (!id) return false;
        if (id.endsWith(":batch")) return false;
        return id.includes(":free") || FREE_WHITELIST.includes(id);
      })
      .map((m) => {
        const raw = m.id || "";
        const id = raw.replace(/^~/, "");
        const prefix = id.split("/")[0] || "cline";
        return { id, upstream: raw, provider: prefix, cost: "free", alias: raw !== id };
      })
      // 去重：~ 别名去波浪号后可能与本体同名（列表里同时有 deepseek/x 和
      // ~deepseek/x 时），保留先出现的那条，避免同一模型在客户端出现两次
      .filter((m, i, arr) => arr.findIndex((x) => x.id === m.id) === i);
    // 合并官方分类：补入 free 数组里独有的模型（cline-free/* 不在 /v1/models 里，
    // 若不做这步会漏掉官方免费通道，而它正是默认模型所在），并标注渠道来源
    const { byId: recKind, list: freeExtra } = await refreshFreeModels();
    for (const m of baseList) {
      const kind = recKind[m.id];
      if (kind === "free" || kind === "recommended") {
        m.channel = kind === "free" ? "free" : "recommended";
      } else if (FREE_WHITELIST.includes(m.id)) {
        // 官方分类里没有，但人工实测确认免费 → 标为 verified，便于区分来源
        m.channel = "verified";
      } else {
        // 官方分类也没覆盖（纯靠 :free 后缀进来的）
        m.channel = "free-suffix";
      }
    }
    for (const fm of freeExtra) {
      const hit = baseList.find((b) => b.id === fm.id);
      if (hit) {
        hit.channel = "free";
        if (!hit.label && fm.label) hit.label = fm.label;
      } else {
        fm.channel = "free";
        baseList.push(fm);
      }
    }
    modelsCache = baseList;
    modelsCacheTime = now;
    console.log("[models] 动态拉取成功:", modelsCache.length, "个免费模型（白名单 " + FREE_WHITELIST.length + " 项 + :free 后缀）");
    return modelsCache;
  } catch (e) {
    console.log("[models] 拉取异常:", String(e).slice(0, 100), "回退内置列表");
    return MODELS;
  }
}


// =====================================================================
// Cline 官方模型分类（逆向自插件 recommended-models 接口）
// 官方插件用 https://api.cline.bot/api/v1/ai/cline/recommended-models 取模型，
// 该接口返回四个**权威分类数组**：
//   recommended  官方推荐（默认走免费额度）
//   free         明确免费，走官方免费额度、不需要 credits
//   clinePass    需 cline-pass 订阅
//   clineCloud   走 Cline 云端额度
// 这是唯一可靠的"价格/渠道"来源——上游 /v1/models 的对象只有
// id/object/created/owned_by，完全不含价格字段，所以不能靠猜。
// =====================================================================
async function refreshFreeModels() {
  try {
    const resp = await fetch(CLINE_API_BASE + "/ai/cline/recommended-models", {
      headers: { "User-Agent": "Mozilla/5.0 (cline2api)" },
    });
    if (!resp.ok) return { byId: {}, list: [] };
    const data = await resp.json();

    // 把四个数组映射成 "id -> 分类"，供 /v1/models 标注每个模型
    const byId = {};
    const take = (arr, kind) => {
      if (!Array.isArray(arr)) return;
      for (const m of arr) {
        if (m && m.id) byId[m.id] = kind;
      }
    };
    take(data.free, "free");
    take(data.recommended, "recommended");
    take(data.clinePass, "pass");
    take(data.clineCloud, "cloud");

    // free 数组里的模型要**额外并入**模型池：其中 cline-free/* 不在 /v1/models 里，
    // 若只做标注就会漏掉官方免费通道（这正是主力模型）。
    const list = (Array.isArray(data.free) ? data.free : [])
      .filter((m) => m && m.id)
      .map((m) => ({
        id: m.id,
        upstream: m.id,
        provider: m.id.split("/")[0] || "cline",
        cost: "free",
        label: m.name || "",
      }));

    return { byId, list };
  } catch (e) {
    return { byId: {}, list: [] };
  }
}

// 默认模型：Cline 免费 DeepSeek V4.1 Flash 通道（cline-free/ 官方免费额度，无需 credits）
// 逆向自官方插件 recommended-models free 列表：cline-free/deepseek-v4.1-flash
const DEFAULT_MODEL = "cline-free/deepseek-v4.1-flash";
const VERSION = "2.0.3";

// ===== 入口 =====
// Cloudflare Workers 入口。Vercel 入口由 build-vercel.mjs 依据下面的
// #region entry 标记自动生成，改动时保持这两个标记存在即可（勿手改 api/index.js）。
// #region entry
export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
};
// #endregion entry

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  // CORS 预检
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    });
  }

  // 健康诊断端点（无需鉴权，用于排查环境变量是否生效）
  // 字段同时提供 README 用的 api_key_configured/account_count 与旧名 authenticated/accounts
  if (request.method === "GET" && (path === "/v1/health" || path === "/health")) {
    const pool = parseAccounts(env);
    const now = Date.now();
    const keyConfigured = !!(env.API_KEY && env.API_KEY.trim());
    return jsonResponse({
      ok: true,
      version: VERSION,
      api_key_configured: keyConfigured,
      account_count: pool.length,
      // 兼容旧字段名（README 早期版本用的是这两个）
      authenticated: keyConfigured,
      accounts: pool.length,
      accounts_available: pool.filter((a) => !a.cooldownUntil || a.cooldownUntil <= now).length,
      // 每个账号的状态明细，供控制台展示账号池（不含任何 token 内容）
      account_details: pool.map((a, i) => ({
        index: i,
        available: !a.cooldownUntil || a.cooldownUntil <= now,
        cooldown_seconds: a.cooldownUntil > now ? Math.ceil((a.cooldownUntil - now) / 1000) : 0,
        cooldown_reason: a.cooldownReason || null,
        token_cached: !!(a.accessToken && now < a.expiry),
        // 运行时登录的账号在重启后会消失，控制台需要据此提示用户去存环境变量
        runtime: !!a.runtime,
        email: a.email || "",
      })),
      runtime_accounts: accounts && accounts.filter((a) => a.runtime).length || 0,
      model: DEFAULT_MODEL,
      models_cached: modelsCache ? modelsCache.length : 0,
    }, 200);
  }

  // 内置控制台（无前端依赖、无需构建，浏览器直接可用）
  if (request.method === "GET" && (path === "/" || path === "/index.html" || path === "/console")) {
    return new Response(CONSOLE_HTML, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  // GET /v1/models — 免鉴权（GUI 验证需拉模型列表）
  if (request.method === "GET" && (path === "/v1/models" || path === "/models")) {
    return handleModels();
  }

  // 账号登录（WorkOS 设备授权码流程）：在控制台里点按钮完成授权，无需跑 python 脚本。
  // ⚠️ 必须鉴权：否则任何人都能把这个 Worker 当 OAuth 中转站用。
  if (request.method === "POST") {
    if (path === "/v1/login/start") return handleLoginStart(request, env);
    if (path === "/v1/login/poll") return handleLoginPoll(request, env);
  }

  // POST 聊天端点
  if (request.method === "POST") {
    if (path === "/v1/chat/completions" || path === "/chat/completions") {
      return handleChat(request, env);
    }
    if (path === "/v1/messages" || path === "/messages") {
      return handleAnthropic(request, env);
    }
  }

  return jsonResponse({
    error: {
      message:
        "Not found: " + request.method + " " + path +
        "。本服务是纯 API，可用端点：GET / (控制台)、GET /v1/health、GET /v1/models、" +
        "POST /v1/chat/completions、POST /v1/messages",
      type: "not_found",
    },
  }, 404);
}

// ---------------------------------------------------------------------------
// Token 管理
// ---------------------------------------------------------------------------

// 从环境变量解析账号池：CLINE_REFRESH_TOKEN 每行一个
// ⚠️ 重建判据必须用「环境变量原文」比较，不能逐位比较池内 refreshToken：
//    上游 /auth/refresh 会轮换 refreshToken，代码会把新 token 写回账号对象，
//    此时池内 token != 环境变量 token，若按 token 比较会导致「每次请求都重建池」，
//    连带把 accessToken 缓存和 cooldownUntil 冷却状态一起清空 →
//    ① 每个请求都多打一次 /auth/refresh；② 冷却失效、429 时不切号空转重试。
let accountsRawEnv = null;   // 上次解析用的环境变量原文
let accountPoolDirty = false; // 运行时登录追加过账号，需要重建

function parseAccounts(env) {
  const raw = env.CLINE_REFRESH_TOKEN || "";
  const tokens = raw.split("\n").map((s) => s.trim()).filter((s) => s.length > 8);

  // 环境变量里的账号 + 运行时通过控制台登录追加的账号
  const dyn = dynamicAccounts.filter((d) => d && d.refreshToken && d.refreshToken.length > 8);

  if (tokens.length === 0 && dyn.length === 0) {
    accounts = [];
    accountsRawEnv = raw;
    accountPoolDirty = false;
    return accounts;
  }

  // 只有环境变量原文变化（增删/调整账号）或运行时追加过账号时才重建，
  // 以保留 accessToken 缓存与 cooldownUntil 冷却状态。
  if (accountsRawEnv !== raw || accountPoolDirty || accounts.length !== tokens.length + dyn.length) {
    const old = accounts;
    const build = (rt, prev) => {
      if (prev && prev.originToken === rt) return prev;
      return {
        refreshToken: rt,
        originToken: rt, // 用于判定账号身份（上游会轮换 refreshToken）
        accessToken: null,
        expiry: 0,
        cooldownUntil: 0,
      };
    };
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
      out.push(build(tokens[i], old[i]));
    }
    // 运行时账号接在环境变量账号之后，同 token 不重复计入
    for (let j = 0; j < dyn.length; j++) {
      if (tokens.includes(dyn[j].refreshToken)) continue;
      const prev = old[tokens.length + j];
      const acct = build(dyn[j].refreshToken, prev);
      acct.email = dyn[j].email || "";
      acct.runtime = true; // 标记为运行时账号（重启会丢）
      out.push(acct);
    }
    accounts = out;
    accountsRawEnv = raw;
    accountPoolDirty = false;
  }
  return accounts;
}

// 取得当前账号的 accessToken（独立缓存，失效/冷却则刷新）
async function getAccountToken(account) {
  const now = Date.now();
  // 冷却期内不可用
  if (account.cooldownUntil > now) {
    throw new Error("account_cooldown");
  }
  if (account.accessToken && now < account.expiry) {
    return account.accessToken;
  }
  const resp = await fetch(CLINE_API_BASE + "/auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      refreshToken: account.refreshToken,
      grantType: "refresh_token",
    }),
  });
  if (!resp.ok) {
    // 刷新失败：冷却 60s，交给上层切号
    account.cooldownUntil = now + 60 * 1000;
    account.cooldownReason = "auth";
    throw new Error("refresh_failed");
  }
  const data = await resp.json();
  const accessToken = data?.data?.accessToken;
  if (!accessToken) {
    account.cooldownUntil = now + 60 * 1000;
    account.cooldownReason = "auth";
    throw new Error("refresh_no_token");
  }
  account.accessToken = accessToken;
  // Cline 会在刷新时轮换 refreshToken；必须保存新 token，避免下一次刷新 invalid_grant。
  if (typeof data?.data?.refreshToken === "string" && data.data.refreshToken.trim()) {
    account.refreshToken = data.data.refreshToken.trim();
  }
  // 过期时间：优先服务端，兜底 10 分钟，留 60s 余量
  const expiresAt = data?.data?.expiresAt;
  let expiry = now + 10 * 60 * 1000;
  if (typeof expiresAt === "number") {
    expiry = expiresAt;
  } else if (typeof expiresAt === "string") {
    const t = Date.parse(expiresAt);
    if (!isNaN(t)) expiry = t;
  }
  account.expiry = expiry - 60000;
  return accessToken;
}

// 轮询选择一个可用账号，返回该账号对象（并设置 currentAccount）
// 返回 null 表示所有账号都在冷却中
function pickAccount(pool) {
  const now = Date.now();
  if (pool.length === 0) return null;
  // 优先复用当前可用账号（避免同一次请求内频繁切号）
  if (currentAccount && pool.includes(currentAccount) &&
      (!currentAccount.cooldownUntil || currentAccount.cooldownUntil <= now)) {
    return currentAccount;
  }
  for (let k = 0; k < pool.length; k++) {
    const acc = pool[accountIndex % pool.length];
    accountIndex = (accountIndex + 1) % pool.length;
    if (!acc.cooldownUntil || acc.cooldownUntil <= now) {
      currentAccount = acc;
      return acc;
    }
  }
  return null; // 全部冷却中
}

async function getAccessToken(env) {
  const pool = parseAccounts(env);
  if (pool.length === 0) {
    throw new Error("缺少 CLINE_REFRESH_TOKEN 环境变量");
  }
  const now = Date.now();
  // 从轮询游标开始，逐个尝试可用账号（跳过冷却中的）
  const start = accountIndex % pool.length;
  for (let i = 0; i < pool.length; i++) {
    const acc = pool[(start + i) % pool.length];
    if (acc.cooldownUntil && acc.cooldownUntil > now) {
      console.log(`[account] 跳过账号 #${(start + i) % pool.length}（冷却中，剩余 ${Math.round((acc.cooldownUntil - now) / 1000)}s）`);
      continue;
    }
    try {
      const token = await getAccountToken(acc);
      accountIndex = ((start + i) + 1) % pool.length; // 游标后移，实现轮询
      currentAccount = acc;
      return token;
    } catch (e) {
      continue; // 刷新失败，试下一个号
    }
  }

  // 所有账号都在冷却中。区分两种冷却原因：
  //  * quota/limit（额度用尽、429、空响应）→ 清冷却再打上游毫无意义，上游只会再拒一次，
  //    白白消耗一次请求；应直接把"全冷却"信息回给客户端，等冷却结束再试。
  //  * auth（刷新失败/401）→ 可能是瞬时网络抖动，值得清冷却重试一次。
  const allQuotaCooling = pool.every((a) => a.cooldownReason === "limit" || a.cooldownReason === "empty");
  if (allQuotaCooling) {
    const earliest = Math.min(...pool.map((a) => a.cooldownUntil || now));
    const err = new Error("all_accounts_cooling");
    err.retryAfterMs = Math.max(earliest - now, 0);
    err.accountCount = pool.length;
    throw err;
  }

  // 兜底：清掉最早账号的冷却，最后试一次，仍失败则抛出
  const acc = pool[0];
  currentAccount = acc;
  acc.cooldownUntil = 0;
  acc.cooldownReason = null;
  acc.accessToken = null;
  acc.expiry = 0;
  try {
    return await getAccountToken(acc);
  } catch (e) {
    throw new Error("所有账号刷新 token 均失败");
  }
}

// Cline 客户端指纹请求头（官方靠这些头识别"是不是 Cline 客户端"）
// 缺少会被 403: "deepseek/deepseek-v4-flash is only available via Cline product surfaces"
// token 显式传参（原先读模块级 currentToken，切号时可能串到别的账号）
function clineHeaders(sessionId, token) {
  return {
    Authorization: "Bearer workos:" + token,
    "Content-Type": "application/json",
    "User-Agent": "Cline/3.0.47",
    "HTTP-Referer": "https://cline.bot",
    "X-Title": "Cline",
    "X-IS-MULTIROOT": "false",
    "X-CLIENT-TYPE": "cline-sdk",
    "X-CLIENT-VERSION": "3.0.47",
    "X-PLATFORM": "terminal",
    "X-PLATFORM-VERSION": "3.0.47",
    "X-CORE-VERSION": "0.0.66",
    "X-Task-ID": sessionId,
  };
}

async function clineFetch(env, path, bodyObj, sessionId, retried = false) {
  const token = await getAccessToken(env);
  const headers = clineHeaders(sessionId, token);
  const resp = await fetch(CLINE_API_BASE + path, {
    method: "POST",
    headers,
    body: JSON.stringify(bodyObj),
  });
  if (resp.status === 401 && !retried) {
    // token 失效：标记当前账号冷却，强制重试（会用别的账号/刷新）
    if (currentAccount) {
      currentAccount.cooldownUntil = Date.now() + 60 * 1000;
      currentAccount.cooldownReason = "auth";
      currentAccount.accessToken = null;
      currentAccount.expiry = 0;
    }
    return clineFetch(env, path, bodyObj, sessionId, true);
  }
  return resp;
}

// ---------------------------------------------------------------------------
// 并发限流队列：上游免费通道并发超过 1 就返回空响应，这里强制串行 + 间隔
// ---------------------------------------------------------------------------

let queueTail = Promise.resolve(); // 全局串行队列尾巴
const MIN_GAP_MS = 800;            // 两次上游请求最小间隔

function enqueue(fn) {
  // 前一个任务结束后，等待间隔，再执行 fn
  const run = queueTail.then(() => sleep(MIN_GAP_MS)).then(fn);
  // 不管成功失败都继续链，避免队列断裂
  queueTail = run.catch(() => {});
  return run;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 解析上游 429/限流响应里的等待时间，返回毫秒
// 支持格式: "Try again in 2h 51m" / "Try again in 30m" / "Try again in 1h" / "Try again in 15s"
function parseCooldown(body, status) {
  const m = (body || "").match(/try again in (?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/i);
  if (m) {
    const h = parseInt(m[1] || 0, 10);
    const min = parseInt(m[2] || 0, 10);
    const s = parseInt(m[3] || 0, 10);
    const ms = (h * 3600 + min * 60 + s) * 1000;
    if (ms > 0) return Math.min(ms, 6 * 3600 * 1000); // 上限 6 小时
  }
  // 429 默认 5 分钟；空响应默认 60 秒
  if (status === 429) return 5 * 60 * 1000;
  return 60 * 1000;
}

// 带重试的 clineFetch：429限流/空响应/5xx 自动切换账号 + 指数退避重试
// 一个号额度用完或限流(429 Daily free limit reached)时：
//   - 冷却该账号（冷却时长按上游提示，如 2h51m）
//   - 自动轮换到下一个号重试同一请求
// 所有账号都冷却时，直接返回原始响应（不空转）
async function clineFetchWithRetry(env, path, bodyObj, sessionId, isStream = false, maxRetries = 4) {
  let lastResp = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // 通过队列串行执行，避免并发空响应
    const resp = await enqueue(() => clineFetch(env, path, bodyObj, sessionId));
    lastResp = resp;

    // ⚠️ 关键：成功响应必须原样立刻返回，绝不能在这里 clone().text() 读 body。
    //    旧实现在转发前 `await resp.clone().text()` 把整个流读完，
    //    导致流式请求的首字节要等到模型全部生成完才到达客户端（实测 TTFT≈总耗时），
    //    流式退化成"假流式"。限流/错误判定只需在非 2xx 时读 body（体量很小）。
    if (resp.ok) {
      return resp;
    }

    // 非 2xx：读 body 用于判定"额度/限流"信号（需要切号）
    // 1. 429（Daily free limit reached / rate limit）
    // 2. 5xx 且含 empty response content
    let bodyText = "";
    try {
      bodyText = await resp.clone().text();
    } catch (e) {}
    const isLimitHit =
      resp.status === 429 ||
      (resp.status >= 500 && bodyText.includes("empty response content"));

    if (isLimitHit) {
      const cooldownMs = parseCooldown(bodyText, resp.status);
      if (currentAccount) {
        currentAccount.cooldownUntil = Date.now() + cooldownMs;
        currentAccount.cooldownReason = "limit";
        currentAccount.accessToken = null;
        currentAccount.expiry = 0;
        console.log(`[account-switch] 账号额度/限流，冷却 ${Math.round(cooldownMs / 1000)}s，切换到下一个`);
      }
      // 还有可用账号 → 短退避后重试（会切到下一个号）
      const pool = parseAccounts(env);
      const hasOther = pool.some((a) => !a.cooldownUntil || a.cooldownUntil <= Date.now());
      if (!hasOther) {
        console.log(`[retry] 所有账号均冷却，直接返回上游响应`);
        return resp; // 不空转，把 429/错误返回给客户端
      }
      await sleep(500 + Math.floor(Math.random() * 500));
      continue;
    }

    // 其他错误（403/400/401 等）不重试，直接返回
    return resp;
  }
  // 重试次数用完，返回最后一次响应
  return lastResp;
}

// ---------------------------------------------------------------------------
// 账号登录（WorkOS 设备授权码流程）
// 逆向自 cline_oauth.py / cline2api auth.go，逻辑一致，只是搬到 Worker 里，
// 让控制台可以点按钮完成登录，不必装 Python 跑脚本。
//
// 流程：start 拿 device_code + 授权链接 → 用户浏览器授权 →
//       poll 轮询换 WorkOS token → 注册换 Cline refreshToken。
// ⚠️ 两个端点都要求 API_KEY：未鉴权就等于开放 OAuth 代理，会被滥用。
// ---------------------------------------------------------------------------

async function handleLoginStart(request, env) {
  const auth = getApiKey(request, env);
  if (!auth.ok) return authError(auth.reason);

  try {
    const resp = await fetch(WORKOS_DEVICE, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: WORKOS_CLIENT_ID }).toString(),
    });
    if (!resp.ok) {
      const t = await resp.text();
      return jsonResponse({
        error: { message: "启动授权失败（HTTP " + resp.status + "）", type: "login_error", detail: t.slice(0, 300) },
      }, 502);
    }
    const d = await resp.json();
    const url = d.verification_uri_complete || d.verification_uri;
    if (!d.device_code || !url) {
      return jsonResponse({ error: { message: "上游返回的授权信息不完整", type: "login_error" } }, 502);
    }
    return jsonResponse({
      ok: true,
      device_code: d.device_code,
      user_code: d.user_code || "",
      verification_uri: url,
      interval: Math.max(d.interval || 5, 5),
      expires_in: d.expires_in || 300,
    }, 200);
  } catch (e) {
    return jsonResponse({ error: { message: "启动授权异常：" + (e && e.message || e), type: "login_error" } }, 500);
  }
}

async function handleLoginPoll(request, env) {
  const auth = getApiKey(request, env);
  if (!auth.ok) return authError(auth.reason);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: { message: "Invalid JSON body", type: "parse_error" } }, 400);
  }
  const deviceCode = (body.device_code || "").trim();
  if (!deviceCode) {
    return jsonResponse({ error: { message: "缺少 device_code", type: "login_error" } }, 400);
  }

  try {
    // WorkOS 用 HTTP 400 + {error:"authorization_pending"} 表示"用户还没授权"，
    // 这是正常等待态，不是错误（cline_oauth.py 早期版本在这里误报过）。
    const resp = await fetch(WORKOS_AUTH, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: WORKOS_CLIENT_ID,
      }).toString(),
    });
    const w = await resp.json().catch(() => ({}));

    if (w.error === "authorization_pending") {
      return jsonResponse({ ok: true, status: "pending" }, 200);
    }
    if (w.error === "slow_down") {
      return jsonResponse({ ok: true, status: "slow_down" }, 200);
    }
    if (w.error) {
      const expired = w.error === "expired_token";
      return jsonResponse({
        ok: false,
        status: "failed",
        error: {
          message: expired ? "授权码已过期，请重新点击登录。" : "授权失败：" + (w.error_description || w.error),
          type: "login_error",
          reason: w.error,
        },
      }, 200);
    }
    if (!w.access_token) {
      return jsonResponse({ ok: true, status: "pending" }, 200);
    }

    // 用 WorkOS token 换 Cline refreshToken
    const reg = await fetch(CLINE_REGISTER, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessToken: w.access_token, refreshToken: w.refresh_token }),
    });
    const rj = await reg.json().catch(() => ({}));
    const rt = rj && rj.data && rj.data.refreshToken;
    if (!rt) {
      return jsonResponse({
        ok: false,
        status: "failed",
        error: { message: "注册失败：上游未返回 refreshToken", type: "login_error", detail: JSON.stringify(rj).slice(0, 300) },
      }, 200);
    }
    const email = ((rj.data && rj.data.userInfo) || {}).email || "";

    // 追加到运行时账号池：本次实例立即生效，无需重启
    if (!dynamicAccounts.some((a) => a.refreshToken === rt)) {
      dynamicAccounts.push({ refreshToken: rt, accessToken: null, expiry: 0, cooldownUntil: 0, email });
      accountPoolDirty = true; // 让 parseAccounts 重建，纳入新账号
    }
    console.log("[login] 新增账号成功，当前运行时账号数:", dynamicAccounts.length);

    return jsonResponse({ ok: true, status: "success", email: email, refresh_token: rt }, 200);
  } catch (e) {
    return jsonResponse({
      ok: false, status: "failed",
      error: { message: "轮询异常：" + (e && e.message || e), type: "login_error" },
    }, 500);
  }
}



// ---------------------------------------------------------------------------
// OpenAI 协议
// ---------------------------------------------------------------------------

async function handleChat(request, env) {
  // API Key 鉴权
  const auth = getApiKey(request, env);
  if (!auth.ok) {
    return authError(auth.reason);
  }

  let params;
  try {
    params = await request.json();
  } catch (e) {
    return jsonResponse({ error: { message: "Invalid JSON body", type: "parse_error" } }, 400);
  }

  const isStream = !!params.stream;
  const sessionId = "sess_" + Date.now();
  const model = params.model || DEFAULT_MODEL;
  const modelConfig = (await refreshModels()).find((m) => m.id === model);
  const upstreamModel = modelConfig?.upstream || model;

  // 构造上游 body（外部模型 ID 与 Cline 上游模型 ID 分离）
  const body = {
    model: upstreamModel,
    session_id: sessionId,
    reasoning_effort: params.reasoning_effort || params.reasoningEffort || "high",
    messages: params.messages || [],
  };
  // ⚠️ 上游风控: 免费模型请求体带 max_tokens 字段一律 500 "empty response content"，
  //    剥掉该字段再转发（max_tokens 不影响生成本质，只影响客户端显示）。
  //    注意: 上游生成 finish_reason=stop 时 completion 可能很长，客户端无法提前截断，属已知代价。
  // ⚠️ 免费 DeepSeek 通道：非流式请求被上游限流(500 empty response content)，
  //    流式请求正常。所以客户端要非流式时，强制上游走 stream，再聚合返回。
  const forceStream = !isStream && (upstreamModel.startsWith("deepseek/") || upstreamModel.startsWith("cline-free/") || upstreamModel.startsWith("cline-pass/"));
  if (isStream || forceStream) body.stream = true;
  // 透传可选参数
  for (const k of ["temperature", "top_p", "tools", "tool_choice", "stop", "presence_penalty", "frequency_penalty", "response_format", "user", "n", "seed"]) {
    if (params[k] !== undefined) body[k] = params[k];
  }

  try {
    const resp = await clineFetchWithRetry(env, "/chat/completions", body, sessionId, true);
    if (!resp.ok) {
      const errText = await resp.text();
      return jsonResponse({ error: { message: "upstream error: " + errText.slice(0, 300), type: "api_error" } }, resp.status);
    }
    if (isStream) {
      // 客户端要流式：直接透传 SSE
      return streamResponse(resp, model);
    }
    if (forceStream) {
      // 客户端要非流式 + 上游是流式：聚合 chunks 再返回
      // ⚠️ 免费通道(deepseek/cline-free)会概率性返回「HTTP200但content全程为空」的流
      //    （100个chunk全是reasoning，无正式content）。这里做内容检测：空则切号重试。
      const retried = await nonStreamWithContentCheck(env, "/chat/completions", body, sessionId, resp);
      if (retried.error) return retried.error;
      retried.data.model = model;
      return jsonResponse(retried.data, 200);
    }
    // 非流式 + 非 deepseek：原逻辑
    const raw = await resp.json();
    const normalized = unwrapData(raw);
    normalized.model = model;
    return jsonResponse(normalized, 200);
  } catch (e) {
    return errorResponse(e);
  }
}

// 把上游 SSE 流聚合成 OpenAI 非流式响应对象
// 用于"客户端要非流式，但上游只能流式"的情况（deepseek 免费通道）
// 额外处理：上游 200 但 content 全空（只有 reasoning）→ 视为坏响应，切号重试
// 由调用方传入"已获取的上游响应"，这里负责聚合 + content 检测 + 空则重试。
async function nonStreamWithContentCheck(env, path, bodyObj, sessionId, firstResp) {
  const maxAttempts = 3; // 最多试 3 次（覆盖多账号切换）
  let lastData = null;
  let resp = firstResp;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (!resp) {
      // 需要重新发起上游请求（空响应重试时）
      resp = await clineFetchWithRetry(env, path, bodyObj, sessionId, true);
    }
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      return { error: jsonResponse({ error: { message: "upstream error: " + errText.slice(0, 300), type: "api_error" } }, resp.status) };
    }
    const ct = resp.headers.get("content-type") || "";
    let normalized = null;
    if (ct.includes("text/event-stream")) {
      normalized = await streamToNonStream(resp);
    } else {
      const raw = await resp.json().catch(() => null);
      if (raw) normalized = unwrapData(raw);
    }
    if (!normalized) {
      return { error: jsonResponse({ error: { message: "upstream returned non-SSE body", type: "api_error" } }, 502) };
    }
    lastData = normalized;
    const msg = normalized?.choices?.[0]?.message || {};
    const content = (msg.content || "").trim();
    const reasoning = (msg.reasoning || "").trim();
    // ⚠️ reasoning 兜底标记：content 为空时 streamToNonStream 会把 reasoning 拼进 content，
    //    这里要识别出来，不能把它当成"好响应"。
    const isReasoningFallback = msg.reasoning_used_as_content === true;
    if (content && !isReasoningFallback) {
      return { data: normalized }; // 有正式 content → 好响应
    }
    // content 为空（或只有兜底 reasoning）：如果只有 reasoning，标记当前账号冷却并重试
    if (reasoning || isReasoningFallback) {
      if (currentAccount) {
        currentAccount.cooldownUntil = Date.now() + 30 * 1000; // 短冷却 30s
        currentAccount.cooldownReason = "empty";
        currentAccount.accessToken = null;
        currentAccount.expiry = 0;
        console.log(`[empty-content] 账号 ${attempt} 返回空 content，冷却 30s，重试第 ${attempt + 2} 次`);
      }
      await sleep(300 + Math.floor(Math.random() * 300));
      resp = null; // 下次循环重新请求（切到下一个号）
      continue;
    }
    // 完全空（连 reasoning 都没有）→ 也重试
    console.log(`[empty-response] 账号 ${attempt} 完全空响应，重试第 ${attempt + 2} 次`);
    await sleep(300 + Math.floor(Math.random() * 300));
    resp = null;
  }
  // 重试用完仍空：返回最后一次（至少带 reasoning，让客户端看到点东西）
  return { data: lastData };
}

async function streamToNonStream(upstream) {
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let content = "";
  let reasoning = "";
  let finishReason = null;
  let model = "";
  let id = "";
  let usage = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "" || payload === "[DONE]") continue;
      try {
        const obj = JSON.parse(payload);
        const normalized = unwrapData(obj);
        const choice = normalized?.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (delta.content) content += delta.content;
        if (delta.reasoning) reasoning += delta.reasoning;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        if (normalized.id) id = normalized.id;
        if (normalized.model) model = normalized.model;
        if (normalized.usage) usage = normalized.usage;
      } catch {}
    }
  }

  const msg = { role: "assistant", content };
  if (reasoning) msg.reasoning = reasoning;
  // ⚠️ 兜底：免费通道偶尔整个流只有 reasoning 没有 content（HTTP 200 但空）。
  //    聚合后发现 content 仍为空且 reasoning 非空时，把 reasoning 拼进 content，
  //    保证客户端（qwenpaw 等）至少能收到可见内容，不会"静默不回复"。
  if (!content && reasoning) {
    msg.content = reasoning;
    msg.reasoning_used_as_content = true;
  }
  return {
    id: id || "gen_" + Date.now(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || DEFAULT_MODEL,
    choices: [{
      index: 0,
      message: msg,
      finish_reason: finishReason || "stop",
      logprobs: null,
      native_finish_reason: finishReason || "stop",
    }],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// ---------------------------------------------------------------------------
// Anthropic Messages API → 转 OpenAI 格式再转发
// ---------------------------------------------------------------------------

async function handleAnthropic(request, env) {
  const auth = getApiKey(request, env);
  if (!auth.ok) {
    return authError(auth.reason);
  }

  let req;
  try {
    req = await request.json();
  } catch (e) {
    return jsonResponse({ error: { message: "Invalid JSON body", type: "parse_error" } }, 400);
  }

  const isStream = !!req.stream;
  const sessionId = "sess_" + Date.now();
  const requestedModel = req.model || DEFAULT_MODEL;
  const modelConfig = (await refreshModels()).find((m) => m.id === requestedModel);
  const upstreamModel = modelConfig?.upstream || requestedModel;

  // Anthropic → OpenAI 消息转换
  const messages = [];
  if (req.system) {
    const sysContent = typeof req.system === "string" ? req.system : JSON.stringify(req.system);
    messages.push({ role: "system", content: sysContent });
  }
  for (const m of req.messages || []) {
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    messages.push({ role: m.role, content });
  }

  const body = {
    model: upstreamModel,
    session_id: sessionId,
    reasoning_effort: "high",
    messages,
  };
  // ⚠️ 上游风控: 免费模型请求体带 max_tokens 字段一律 500，剥离（同 chat/completions 路径）
  // ⚠️ 免费 DeepSeek 通道：非流式被上游限流，强制上游 stream 再聚合
  const forceStream = !isStream && (upstreamModel.startsWith("deepseek/") || upstreamModel.startsWith("cline-free/") || upstreamModel.startsWith("cline-pass/"));
  if (isStream || forceStream) body.stream = true;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.top_p !== undefined) body.top_p = req.top_p;
  if (req.tools) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description || "", parameters: t.input_schema || {} },
    }));
  }

  try {
    const resp = await clineFetchWithRetry(env, "/chat/completions", body, sessionId, true);
    if (!resp.ok) {
      const errText = await resp.text();
      return jsonResponse({ error: { message: "upstream error: " + errText.slice(0, 300), type: "api_error" } }, resp.status);
    }
    if (isStream) {
      // 上游是 OpenAI SSE，转成 Anthropic SSE 格式
      return streamResponseAnthropic(resp, requestedModel);
    }
    if (forceStream) {
      // 客户端要非流式 + 上游是流式：聚合后再转 Anthropic
      // ⚠️ 同样做 content 检测：免费通道会概率性返回"200但content全空"的流，空则切号重试
      const retried = await nonStreamWithContentCheck(env, "/chat/completions", body, sessionId, resp);
      if (retried.error) return retried.error;
      return jsonResponse(openAItoAnthropic(retried.data), 200);
    }
    const raw = await resp.json();
    const normalized = unwrapData(raw);
    // OpenAI → Anthropic
    return jsonResponse(openAItoAnthropic(normalized), 200);
  } catch (e) {
    return errorResponse(e);
  }
}

// ---------------------------------------------------------------------------
// 响应处理
// ---------------------------------------------------------------------------

// 剥掉上游 {data:{...}} 包装（上游有时包一层 data）
function unwrapData(obj) {
  if (obj && obj.data && typeof obj.data === "object") {
    const d = obj.data;
    if (d.choices || d.id || d.usage) return d;
  }
  return obj;
}

// OpenAI SSE 流式透传（剥 data 包装）
async function streamResponse(upstream, externalModel) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let buf = "";
  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // 按行处理
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line.startsWith("data:")) {
            const payload = line.slice(5).trim();
            if (payload === "" || payload === "[DONE]") {
              await writer.write(encoder.encode(line + "\n\n"));
              continue;
            }
            try {
              const obj = JSON.parse(payload);
              const normalized = unwrapData(obj);
              if (normalized && externalModel) normalized.model = externalModel;
              await writer.write(encoder.encode("data: " + JSON.stringify(normalized) + "\n\n"));
            } catch {
              await writer.write(encoder.encode(line + "\n"));
            }
          } else {
            await writer.write(encoder.encode(line + "\n"));
          }
        }
      }
    } catch (e) {
      // ignore
    } finally {
      try { await writer.close(); } catch {}
    }
  })();

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...corsHeaders(),
    },
  });
}

// Anthropic SSE：把上游 OpenAI chunk 转成 Anthropic 格式
async function streamResponseAnthropic(upstream, externalModel) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const msgId = "msg_" + Date.now();
  const send = (event, data) =>
    writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

  // ⚠️ Anthropic SSE 协议要求按顺序发：message_start → content_block_start →
  //    content_block_delta* → content_block_stop → message_delta → message_stop。
  //    旧实现直接甩 content_block_delta，缺 message_start/content_block_start，
  //    对协议校验严格的 Anthropic SDK / 客户端会解析失败。
  let buf = "";
  let started = false;        // 是否已发 message_start
  let textBlockOpen = false;  // 文本块是否已 start
  let toolBlockIndex = null;  // 当前工具块序号
  let stopReason = "end_turn";
  let outputTokens = 0;

  const ensureStarted = async () => {
    if (started) return;
    started = true;
    await send("message_start", {
      type: "message_start",
      message: {
        id: msgId,
        type: "message",
        role: "assistant",
        model: externalModel || DEFAULT_MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  };
  const openTextBlock = async () => {
    if (textBlockOpen) return;
    await ensureStarted();
    textBlockOpen = true;
    toolBlockIndex = null;
    await send("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
  };
  const closeTextBlock = async () => {
    if (!textBlockOpen) return;
    textBlockOpen = false;
    await send("content_block_stop", { type: "content_block_stop", index: 0 });
  };

  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "" || payload === "[DONE]") continue;
          let normalized;
          try {
            normalized = unwrapData(JSON.parse(payload));
          } catch {
            continue;
          }
          const choice = normalized?.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta || {};

          if (choice.finish_reason) {
            stopReason = choice.finish_reason === "tool_calls" ? "tool_use"
              : choice.finish_reason === "length" ? "max_tokens"
              : "end_turn";
          }
          if (normalized?.usage?.completion_tokens) {
            outputTokens = normalized.usage.completion_tokens;
          }

          if (delta.reasoning) {
            // Anthropic 无对应字段，作为 thinking 块透出（客户端不认也可忽略）
            await ensureStarted();
            await send("content_block_delta", {
              type: "content_block_delta",
              index: 0,
              delta: { type: "thinking_delta", thinking: delta.reasoning },
            });
          }

          if (delta.content) {
            await openTextBlock();
            await send("content_block_delta", {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: delta.content },
            });
          }

          // 工具调用：上游是 OpenAI 增量分片格式（首片含 id/name，后续片是
          // arguments 片段）。Anthropic 需要 input_json_delta.partial_json 只装
          // 参数片段本身，且必须成对出现 content_block_start(type=tool_use)。
          if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
            await closeTextBlock();
            await ensureStarted();
            for (const tc of delta.tool_calls) {
              if (tc.id || tc.function?.name) {
                // 新工具块开始
                if (toolBlockIndex !== null) {
                  await send("content_block_stop", { type: "content_block_stop", index: toolBlockIndex });
                }
                toolBlockIndex = 1;
                await send("content_block_start", {
                  type: "content_block_start",
                  index: toolBlockIndex,
                  content_block: { type: "tool_use", id: tc.id || "toolu_" + Date.now(), name: tc.function?.name || "", input: {} },
                });
                if (tc.function?.arguments) {
                  await send("content_block_delta", {
                    type: "content_block_delta",
                    index: toolBlockIndex,
                    delta: { type: "input_json_delta", partial_json: tc.function.arguments },
                  });
                }
              } else if (tc.function?.arguments && toolBlockIndex !== null) {
                await send("content_block_delta", {
                  type: "content_block_delta",
                  index: toolBlockIndex,
                  delta: { type: "input_json_delta", partial_json: tc.function.arguments },
                });
              }
            }
          }
        }
      }

      // 收尾：确保协议事件完整成对
      await ensureStarted();
      await closeTextBlock();
      if (toolBlockIndex !== null) {
        await send("content_block_stop", { type: "content_block_stop", index: toolBlockIndex });
      }
      await send("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: outputTokens },
      });
      await send("message_stop", { type: "message_stop" });
    } catch (e) {
    } finally {
      try { await writer.close(); } catch {}
    }
  })();

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...corsHeaders(),
    },
  });
}

// OpenAI 非流式 → Anthropic 非流式
function openAItoAnthropic(openAI) {
  const choice = openAI?.choices?.[0];
  const message = choice?.message || {};
  const content = [];
  const text = message.content;
  if (typeof text === "string" && text) {
    content.push({ type: "text", text });
  }
  // 工具调用：Anthropic 用 tool_use 块，arguments 需解析成对象
  for (const tc of message.tool_calls || []) {
    let input = {};
    try {
      input = JSON.parse(tc.function?.arguments || "{}");
    } catch {
      input = {};
    }
    content.push({
      type: "tool_use",
      id: tc.id || "toolu_" + Date.now(),
      name: tc.function?.name || "",
      input,
    });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });
  const finish = choice?.finish_reason;
  const stopReason = finish === "tool_calls" ? "tool_use" : finish === "length" ? "max_tokens" : "end_turn";
  return {
    id: openAI?.id || "msg_" + Date.now(),
    type: "message",
    role: "assistant",
    model: openAI?.model || "",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: openAI?.usage?.prompt_tokens || 0,
      output_tokens: openAI?.usage?.completion_tokens || 0,
    },
  };
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

async function handleModels() {
  const list = await refreshModels();
  const payload = list.map((m) => ({
    id: m.id,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: "cline",
    // 附加字段（非 OpenAI 标准，普通客户端会忽略）：
    // 正常路径下列表只放行确定免费的模型（:free 后缀或 FREE_WHITELIST），所以
    // cost 恒为 "free"；channel 标明这个"免费"是哪来的，便于排查：
    //   free        官方 recommended-models 的 free 数组
    //   recommended 官方 recommended 数组（也走免费额度）
    //   verified    官方分类未覆盖、人工实测确认免费（FREE_WHITELIST）
    //   free-suffix 仅靠 :free 后缀进来的
    // 注意：上游拉取失败会回退内置 MODELS，其中含 cline-pass 项，故 free 需按
    // cost 实际取值计算，不能硬编码 true。
    cost: m.cost || "free",
    free: (m.cost || "free") === "free",
    channel: m.channel || null,
    label: m.label || null,
    // 上游的原始 ID：~ 别名会被去掉波浪号后再对外，这里保留原名便于排查
    upstream: m.upstream || m.id,
    alias: !!m.alias,
  }));
  return jsonResponse({ object: "list", data: payload }, 200, { "X-Cline2api-Version": VERSION });
}

// 鉴权：fail-closed
// ⚠️ 旧实现在未配置 API_KEY 时回退到硬编码的 "cline2api-default-key"，
//    而该值是公开写在 README 里的 —— 等于任何知道这个默认值的人都能用你的
//    Cline 账号（消耗你的免费额度）。这里改为：未配置 API_KEY 时直接拒绝并给出
//    可操作的提示，绝不回退到公开默认值。
//    /v1/health 与 /v1/models 不受影响（不消耗账号额度，且便于部署自检）。
function getApiKey(request, env) {
  const expected = (env.API_KEY || "").trim();

  const auth = request.headers.get("Authorization") || "";
  let provided = null;
  if (auth.startsWith("Bearer ")) {
    provided = auth.slice(7).trim();
  } else {
    const xKey = request.headers.get("x-api-key");
    if (xKey) provided = xKey.trim();
  }

  if (!expected) {
    if (provided) {
      // 用户传了 key 但服务端没配：明确告诉他原因，而不是默默放行
      return { ok: false, reason: "server_no_key" };
    }
    return { ok: false, reason: "server_no_key" };
  }
  if (!provided) return { ok: false, reason: "missing_client_key" };
  return provided === expected ? { ok: true } : { ok: false, reason: "wrong_client_key" };
}

function authError(reason) {
  const messages = {
    server_no_key:
      "服务端未配置 API_KEY，已拒绝请求（为避免账号被他人使用，不再回退到公开默认密钥）。" +
      "请在部署环境的变量/机密里设置 API_KEY，例如：wrangler secret put API_KEY（Cloudflare）或 vercel env add API_KEY production（Vercel），保存后重新部署。",
    missing_client_key: "缺少 API Key。请用 Authorization: Bearer <你的API_KEY> 或 x-api-key 头传递。",
    wrong_client_key: "API Key 不正确。",
  };
  return jsonResponse({ error: { message: messages[reason] || "鉴权失败", type: "auth_error", reason } }, 401);
}

// ---------------------------------------------------------------------------
// 内置控制台页面（根路径 /）
// 本项目本身没有前端，也不需要构建：这是一个自包含的单文件 HTML，
// 用于部署后自检（看健康状态、拉模型列表、直接试聊天）。
// ⚠️ 内嵌 JS 里避免使用反引号与 ${ }，因为它们会终止外层模板字符串。
// ---------------------------------------------------------------------------

// #region console-html
// ⚠️ 本块由 build-console.mjs 从 console.src.html 生成，请勿手改。
//    要改控制台请编辑 console.src.html，然后运行：node build-console.mjs
const CONSOLE_HTML = `<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- cline-free · 控制台
     单文件前端（无外部依赖、无构建），由 build-console.mjs 注入 worker.js。
     风格：像素终端（PIXEL OPS）——深蓝黑底 + 单一青色强调 + 直角 + 硬投影 +
     网格底纹与 CRT 扫描线 + 全等宽字体。参考 workbuddy-free 的视觉语言。
     ▲ 本文件里的 JS 不要用模板字符串插值（\${}），构建脚本会转义，用了会失效。 -->
<title>cline-free · 控制台</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%230b0e14'/%3E%3Cg fill='%232ad4e8'%3E%3Crect x='5' y='7' width='6' height='1'/%3E%3Crect x='3' y='8' width='3' height='1'/%3E%3Crect x='10' y='8' width='3' height='1'/%3E%3Crect x='2' y='9' width='2' height='1'/%3E%3Crect x='12' y='9' width='2' height='1'/%3E%3Crect x='1' y='10' width='1' height='1'/%3E%3Crect x='4' y='10' width='8' height='1'/%3E%3Crect x='14' y='10' width='1' height='1'/%3E%3Crect x='3' y='11' width='2' height='1'/%3E%3Crect x='11' y='11' width='2' height='1'/%3E%3Crect x='6' y='12' width='4' height='1'/%3E%3Crect x='5' y='13' width='2' height='1'/%3E%3Crect x='9' y='13' width='2' height='1'/%3E%3Crect x='7' y='14' width='2' height='1'/%3E%3Crect x='7' y='15' width='2' height='1'/%3E%3C/g%3E%3C/svg%3E">
<style>
/* ══ 设计令牌 ══════════════════════════════════════════════════════════
   像素终端语言：直角、2px 描边、硬投影（位移块而非模糊）、网格底纹 + 扫描线、
   全站等宽字体 + tabular-nums 对齐数值。 */
:root {
  color-scheme: dark;
  --bg:#0b0e14; --surface:#11161f; --surface-2:#171d28; --raise:#1d2533;
  --line:#2d3849; --line-soft:#212a38;
  --ink:#dce7f2; --ink-2:#94a5ba; --ink-3:#61738a;
  --accent:#2ad4e8; --accent-ink:#04161a; --accent-soft:rgba(42,212,232,.12);
  --ok:#46d67f; --ok-soft:rgba(70,214,127,.12);
  --warn:#f5b544; --warn-soft:rgba(245,181,68,.12);
  --bad:#ff5d6c; --bad-soft:rgba(255,93,108,.12);
  --cn:#ffb454; --cn-soft:rgba(255,180,84,.12);   /* 国产模型标记色 */
  --inset:rgba(0,0,0,.28);
  --shadow:4px 4px 0 0 rgba(0,0,0,.5);
  --shadow-sm:3px 3px 0 0 rgba(0,0,0,.45);
  --shadow-lg:8px 8px 0 0 rgba(0,0,0,.6);
  --grid:rgba(42,212,232,.045); --grid-step:34px;
  --scan:rgba(0,0,0,.24); --scan-opacity:.5;
  --mono:ui-monospace,"Cascadia Mono","JetBrains Mono","SF Mono",Consolas,"Courier New",monospace;
  --nav-w:212px;
  --z-sticky:20; --z-fx:200;
}
[data-theme="light"] {
  color-scheme: light;
  --bg:#e9edf3; --surface:#fff; --surface-2:#f1f4f9; --raise:#fff;
  --line:#b7c2d3; --line-soft:#d9e1ea;
  --ink:#0c1119; --ink-2:#43536a; --ink-3:#78899e;
  --accent:#0b7f96; --accent-ink:#fff; --accent-soft:rgba(11,127,150,.1);
  --ok:#0f7a48; --ok-soft:rgba(15,122,72,.1);
  --warn:#96600a; --warn-soft:rgba(150,96,10,.1);
  --bad:#c02b34; --bad-soft:rgba(192,43,52,.09);
  --cn:#9a5a06; --cn-soft:rgba(154,90,6,.1);
  --inset:rgba(12,17,25,.06);
  --shadow:4px 4px 0 0 rgba(12,17,25,.16);
  --shadow-sm:3px 3px 0 0 rgba(12,17,25,.14);
  --shadow-lg:8px 8px 0 0 rgba(12,17,25,.2);
  --grid:rgba(11,127,150,.06);
  --scan-opacity:0;  /* 浅色下关扫描线：白底叠暗线会显脏 */
}
* { box-sizing:border-box; margin:0; padding:0; }
[hidden] { display:none !important; }
html,body { height:100%; }
body {
  background:var(--bg); color:var(--ink);
  font:13px/1.6 var(--mono); -webkit-font-smoothing:antialiased;
  overflow:hidden;   /* 由 .main 内部滚动，保证日志窗口固定高度 */
}
/* 全屏纹理：网格 + 扫描线，置顶且不拦事件 */
body::before {
  content:""; position:fixed; inset:0; z-index:var(--z-fx); pointer-events:none;
  background-image:
    linear-gradient(var(--grid) 1px,transparent 1px),
    linear-gradient(90deg,var(--grid) 1px,transparent 1px);
  background-size:var(--grid-step) var(--grid-step);
}
body::after {
  content:""; position:fixed; inset:0; z-index:var(--z-fx); pointer-events:none;
  background:repeating-linear-gradient(0deg,var(--scan) 0 1px,transparent 1px 3px);
  opacity:var(--scan-opacity);
}
::selection { background:var(--accent); color:var(--accent-ink); }
:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
* { scrollbar-width:thin; scrollbar-color:var(--line) transparent; }
::-webkit-scrollbar { width:12px; height:12px; }
::-webkit-scrollbar-track { background:var(--surface-2); }
::-webkit-scrollbar-thumb { background:var(--line); border:2px solid var(--surface-2); }
::-webkit-scrollbar-thumb:hover { background:var(--accent); }

/* ══ 壳层 ══ */
.shell { display:grid; grid-template-columns:var(--nav-w) 1fr; height:100dvh; position:relative; z-index:1; }
.main { min-width:0; display:flex; flex-direction:column; height:100dvh; overflow:hidden; }

/* ══ 左侧导航 ══ */
.nav { background:var(--surface); border-right:2px solid var(--line); display:flex; flex-direction:column; }
.brand { padding:15px 14px 13px; border-bottom:2px solid var(--line); }
.brand .name { font-weight:700; letter-spacing:.1em; font-size:12.5px; text-transform:uppercase; display:flex; align-items:center; gap:8px; }
.brand .logo { width:18px; height:18px; flex:none; fill:var(--accent); shape-rendering:crispEdges; }
.brand .sub { color:var(--ink-3); font-size:10.5px; margin-top:4px; letter-spacing:.14em; }
.nav ul { list-style:none; padding:9px 9px; flex:1; overflow-y:auto; }
.nav a {
  display:flex; align-items:center; gap:9px; padding:7px 10px; margin-bottom:3px;
  color:var(--ink-2); text-decoration:none; font-size:12.5px;
  border:2px solid transparent; letter-spacing:.02em; cursor:pointer;
}
.nav a:hover { background:var(--surface-2); color:var(--ink); border-color:var(--line-soft); }
.nav a.on { background:var(--accent-soft); color:var(--accent); font-weight:700; border-color:var(--accent); box-shadow:inset 4px 0 0 0 var(--accent); }
.nav a svg { width:15px; height:15px; flex:none; opacity:.9; }
.nav a .cnt { margin-left:auto; font-size:10.5px; color:var(--ink-3); font-variant-numeric:tabular-nums; }
.nav a.on .cnt { color:var(--accent); }
.nav .sig { padding:10px 14px; border-top:2px solid var(--line); font-size:11px; color:var(--ink-3); }
.nav .sig .row { display:flex; align-items:center; gap:7px; }
.nav .sig .credit { margin-top:6px; letter-spacing:.06em; }
.nav .sig .credit b { color:var(--ink-2); }
.nav .sig .mp { margin-top:3px; color:var(--ink-3); }
.nav .sig .mp b { color:var(--accent); }

/* 账号池（左栏） */
.pool { padding:10px 14px; border-top:2px solid var(--line); }
.pool .hd { display:flex; align-items:baseline; gap:6px; margin-bottom:8px; }
.pool .hd .t { font-size:10.5px; color:var(--ink-3); letter-spacing:.08em; text-transform:uppercase; }
.pool .hd .v { margin-left:auto; font-size:11.5px; font-variant-numeric:tabular-nums; }
.pool .hd .v.ok { color:var(--ok); } .pool .hd .v.warn { color:var(--warn); } .pool .hd .v.bad { color:var(--bad); }
.cells { display:flex; gap:4px; flex-wrap:wrap; }
.cell {
  width:20px; height:20px; border:2px solid var(--line); background:var(--bg);
  display:grid; place-items:center; font-size:10px; color:var(--ink-3);
  font-variant-numeric:tabular-nums; cursor:default;
}
.cell.live { border-color:var(--ok); color:var(--ok); background:var(--ok-soft); }
.cell.cool { border-color:var(--warn); color:var(--warn); background:var(--warn-soft); }
.cell.tmp { box-shadow:inset 0 -3px 0 var(--accent); }
.pool .empty { font-size:11px; color:var(--ink-3); line-height:1.5; }

/* ══ 顶栏 ══ */
.topbar {
  display:flex; align-items:center; gap:12px; padding:11px 20px;
  border-bottom:2px solid var(--line); background:var(--surface);
  position:sticky; top:0; z-index:var(--z-sticky); flex:none; flex-wrap:wrap;
}
.topbar h2 { font-size:13px; font-weight:700; letter-spacing:.1em; text-transform:uppercase; }
.topbar .sep { color:var(--accent); font-weight:700; }
.topbar .meta { color:var(--ink-3); font-size:11.5px; }
.topbar .grow { flex:1; }
.fact { display:inline-flex; align-items:center; gap:6px; font-size:11px; color:var(--ink-3); }
.fact .sq { width:8px; height:8px; flex:none; background:var(--ink-3); }
.fact .sq.ok { background:var(--ok); } .fact .sq.warn { background:var(--warn); } .fact .sq.bad { background:var(--bad); }

/* ══ 视图 ══ */
.views { flex:1; min-height:0; position:relative; }
.view { position:absolute; inset:0; overflow-y:auto; padding:18px 20px 40px; display:flex; flex-direction:column; gap:16px; }
.view[hidden] { display:none !important; }
.view.flush { padding:0; gap:0; overflow:hidden; }

/* ══ 面板 box ══ */
.box { background:var(--surface); border:2px solid var(--line); box-shadow:var(--shadow); }
.box > header {
  display:flex; align-items:center; gap:10px; padding:9px 14px;
  border-bottom:2px solid var(--line); background:var(--surface-2); flex-wrap:wrap;
}
.box > header h3 { font-size:12px; font-weight:700; letter-spacing:.06em; display:flex; align-items:center; gap:8px; }
.box > header h3::before {
  content:""; width:8px; height:8px; flex:none; background:var(--accent);
  clip-path:polygon(0 0,100% 0,100% 55%,55% 55%,55% 100%,0 100%);
}
.box > header .grow { flex:1; }
.box > header .note { color:var(--ink-3); font-size:11px; }
.box .pad { padding:14px; }
.box .pad0 { padding:0; }

/* 网格布局：紧凑填充，不留大片空白 */
.grid2 { display:grid; grid-template-columns:1fr 1fr; gap:16px; align-items:start; }
.grid3 { display:grid; grid-template-columns:repeat(3,1fr); gap:16px; align-items:start; }
/* 对话页：左栏撑满剩余高度，右栏独立滚动，避免底部留白。
   需要一路 min-height:0，否则 flex/grid 子项按内容高度计算，撑不开。 */
.grid-chat { display:grid; grid-template-columns:1fr 320px; gap:16px; flex:1; min-height:0; align-items:stretch; }
.grid-chat > * { min-height:0; }
.grid-chat .aside { display:flex; flex-direction:column; gap:16px; min-height:0; overflow-y:auto; }
@media (max-width:1200px){ .grid-chat{ grid-template-columns:1fr; flex:none; } .grid-chat .aside{ overflow:visible; } }
@media (max-width:900px){ .grid2,.grid3{ grid-template-columns:1fr; } }

/* ══ 控件 ══ */
button {
  font:inherit; font-size:12.5px; letter-spacing:.02em; color:var(--ink);
  background:var(--surface-2); border:2px solid var(--line); padding:6px 12px; cursor:pointer;
  box-shadow:var(--shadow-sm);
  transition:transform .07s steps(2), box-shadow .07s steps(2), background .12s, border-color .12s, color .12s;
}
button:hover:not(:disabled){ border-color:var(--accent); color:var(--accent); }
button:active:not(:disabled){ transform:translate(3px,3px); box-shadow:0 0 0 0 transparent; }
button:disabled{ opacity:.45; cursor:default; }
button.primary{ background:var(--accent); border-color:var(--accent); color:var(--accent-ink); font-weight:700; }
button.primary:hover:not(:disabled){ filter:brightness(1.12); color:var(--accent-ink); }
button.ghost{ background:transparent; }
button.danger{ color:var(--bad); }
button.danger:hover:not(:disabled){ border-color:var(--bad); color:var(--bad); }
button.xs{ padding:2px 8px; font-size:11px; box-shadow:2px 2px 0 0 rgba(0,0,0,.4); }
button.xs:active:not(:disabled){ transform:translate(2px,2px); }
button.done{ background:var(--ok); border-color:var(--ok); color:#04160a; }
input,select,textarea {
  font:inherit; font-size:12.5px; color:var(--ink); background:var(--bg);
  border:2px solid var(--line); padding:6px 9px; width:100%;
}
input:focus,select:focus,textarea:focus{ outline:none; border-color:var(--accent); }
input::placeholder,textarea::placeholder{ color:var(--ink-3); }
textarea{ resize:vertical; line-height:1.55; }
select{
  appearance:none; -webkit-appearance:none; cursor:pointer; padding-right:26px;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%2361738a' stroke-width='1.6'/%3E%3C/svg%3E");
  background-repeat:no-repeat; background-position:right 8px center;
}
label.lb{ display:block; font-size:11px; color:var(--ink-3); margin-bottom:5px; letter-spacing:.04em; }
.chk{ display:inline-flex; align-items:center; gap:6px; font-size:12px; color:var(--ink-2); cursor:pointer; user-select:none; }
.chk input{ width:auto; accent-color:var(--accent); }

/* ══ 提示条 ══ */
.notes{ display:flex; flex-direction:column; gap:10px; }
.note{
  display:flex; align-items:center; gap:10px; padding:9px 12px; font-size:12px;
  border:2px solid; box-shadow:var(--shadow-sm);
}
.note .grow{ flex:1; }
.note.info{ background:var(--accent-soft); border-color:var(--accent); color:var(--accent); }
.note.warn{ background:var(--warn-soft); border-color:var(--warn); color:var(--warn); }
.note.bad{ background:var(--bad-soft); border-color:var(--bad); color:var(--bad); }
.note.ok{ background:var(--ok-soft); border-color:var(--ok); color:var(--ok); }

/* ══ 对话 ══ */
.thread{ overflow-y:auto; padding:14px; display:flex; flex-direction:column; gap:12px; min-height:240px; }
.thread .empty{ color:var(--ink-3); text-align:center; padding:44px 16px; font-size:12px; }
.turn{ display:grid; grid-template-columns:26px 1fr; gap:10px; }
.turn .who{
  width:26px; height:26px; display:grid; place-items:center; font-size:10px; font-weight:700;
  border:2px solid var(--line); color:var(--ink-3); background:var(--bg);
}
.turn.me .who{ border-color:var(--accent); color:var(--accent); background:var(--accent-soft); }
.turn.ai .who{ border-color:var(--ok); color:var(--ok); background:var(--ok-soft); }
.turn.err .who{ border-color:var(--bad); color:var(--bad); background:var(--bad-soft); }
.turn .txt{ white-space:pre-wrap; word-break:break-word; font-size:12.5px; line-height:1.65; }
.turn .stats{ margin-top:6px; font-size:10.5px; color:var(--ink-3); font-variant-numeric:tabular-nums; display:flex; flex-wrap:wrap; gap:0 10px; }
.turn .stats .hi{ color:var(--accent); } .turn .stats .lo{ color:var(--warn); }
details.rz{ margin-top:6px; }
details.rz > summary{ font-size:11px; color:var(--ink-3); cursor:pointer; list-style:none; display:inline-block; border-bottom:1px dashed var(--line); }
details.rz > summary::-webkit-details-marker{ display:none; }
details.rz > summary:hover{ color:var(--accent); border-color:var(--accent); }
details.rz pre{
  margin-top:7px; padding:9px 11px; white-space:pre-wrap; word-break:break-word;
  font:11.5px/1.65 var(--mono); color:var(--ink-2); background:var(--bg);
  border:2px solid var(--line-soft); border-left:3px solid var(--accent);
  max-height:260px; overflow:auto;
}
.gen{ color:var(--accent); }
.gen::before{ content:"▌"; animation:blink .9s steps(2) infinite; margin-right:5px; }
@keyframes blink { 50%{ opacity:0; } }

/* ══ 账号 ══ */
.accts{ display:grid; grid-template-columns:repeat(auto-fill,minmax(216px,1fr)); gap:12px; }
.acct{ background:var(--surface-2); border:2px solid var(--line); padding:11px 12px; box-shadow:var(--shadow-sm); }
.acct.live{ border-color:var(--ok); } .acct.cool{ border-color:var(--warn); }
.acct .top{ display:flex; align-items:center; gap:8px; margin-bottom:7px; }
.acct .ix{ width:22px; height:22px; display:grid; place-items:center; font-size:10.5px; font-weight:700; border:2px solid var(--line); color:var(--ink-3); }
.acct.live .ix{ border-color:var(--ok); color:var(--ok); }
.acct.cool .ix{ border-color:var(--warn); color:var(--warn); }
.acct .ml{ font-size:11.5px; color:var(--ink-2); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.acct .st{ font-size:11px; }
.acct.live .st{ color:var(--ok); } .acct.cool .st{ color:var(--warn); }
.acct dl{ margin-top:8px; padding-top:8px; border-top:1px solid var(--line-soft); display:grid; gap:3px; }
.acct dl div{ display:flex; justify-content:space-between; gap:8px; font-size:10.5px; }
.acct dl .k{ color:var(--ink-3); } .acct dl .v{ color:var(--ink-2); font-variant-numeric:tabular-nums; }

/* 登录 */
.login[hidden]{ display:none !important; }
.code{
  font-size:24px; font-weight:700; letter-spacing:.12em; color:var(--accent);
  text-align:center; padding:11px; margin:10px 0; background:var(--accent-soft);
  border:2px solid var(--accent); user-select:all; font-variant-numeric:tabular-nums;
}
.linkrow{ display:flex; gap:7px; align-items:center; background:var(--bg); border:2px solid var(--line); padding:7px 10px; margin:9px 0; }
.linkrow .u{ flex:1; min-width:0; font-size:11px; color:var(--accent); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.steps{ padding-left:18px; font-size:12px; color:var(--ink-2); line-height:1.9; }
.meter{ height:6px; background:var(--bg); border:2px solid var(--line); overflow:hidden; margin-top:10px; }
.meter i{ display:block; height:100%; width:0; background-image:repeating-linear-gradient(90deg,var(--accent) 0 3px,transparent 3px 5px); transition:width .5s steps(12); }

/* ══ 接入配置 ══ */
.kv dt{ font-size:11px; color:var(--ink-3); margin-top:10px; }
.kv dt:first-child{ margin-top:0; }
.kv dd{ display:flex; gap:7px; align-items:center; }
.kv dd input{ font-size:11.5px; }
.snip-tabs{ display:flex; gap:5px; flex-wrap:wrap; margin-bottom:10px; }
.snip-tabs button{ padding:3px 10px; font-size:11.5px; }
.snip-tabs button.on{ background:var(--accent); border-color:var(--accent); color:var(--accent-ink); font-weight:700; }
pre.snip{ background:var(--bg); border:2px solid var(--line); padding:12px 14px; overflow:auto; max-height:380px; font:11.5px/1.7 var(--mono); white-space:pre; }
ul.facts{ list-style:none; display:grid; gap:9px; }
ul.facts li{ font-size:11.5px; color:var(--ink-2); line-height:1.7; padding-left:13px; position:relative; }
ul.facts li::before{ content:""; position:absolute; left:0; top:7px; width:5px; height:5px; background:var(--accent); }
ul.facts code{ font-size:11px; color:var(--accent); background:var(--accent-soft); padding:1px 5px; }

/* ══ 模型 ══ */
.mactions{ display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
/* 指标格：用 flex 让每行格子等宽铺满，避免出现空格子或半行留白 */
.stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(112px,1fr)); gap:2px; background:var(--line-soft); border:2px solid var(--line-soft); }
.stats:empty::after { content:"等待首次请求…"; display:block; background:var(--surface); padding:12px 11px; color:var(--ink-3); font-size:11px; }
.stats > div{ background:var(--surface); padding:9px 11px; }

/* 侧栏里的指标：两列固定，成对铺满，不会只剩一个格子 */
.stats.pairs { grid-template-columns:1fr 1fr; }
.stats .k{ font-size:10px; color:var(--ink-3); letter-spacing:.06em; text-transform:uppercase; margin-bottom:2px; }
.stats .v{ font-size:15px; font-weight:700; font-variant-numeric:tabular-nums; }
.stats .v.ok{ color:var(--ok); } .stats .v.cn{ color:var(--cn); }
.bar{ height:6px; background:var(--bg); border:2px solid var(--line); overflow:hidden; }
.bar i{ display:block; height:100%; width:0; background-image:repeating-linear-gradient(90deg,var(--accent) 0 3px,transparent 3px 5px); }
/* 模型表：固定高度的滚动窗口（白名单放行后仍有几十个模型，页面不能被撑长） */
.tblwrap{ overflow:auto; max-height:calc(100vh - 330px); min-height:220px; border:2px solid var(--line-soft); }
table.m{ width:100%; border-collapse:collapse; font-size:12px; min-width:760px; }
table.m th{
  text-align:left; font-size:10.5px; color:var(--ink-3); letter-spacing:.07em; text-transform:uppercase;
  padding:7px 9px; border-bottom:2px solid var(--line); white-space:nowrap; background:var(--surface-2);
  cursor:default; position:sticky; top:0; z-index:1;
}
table.m th.sort{ cursor:pointer; }
table.m th.sort:hover{ color:var(--accent); }
table.m th .ar{ color:var(--accent); }
table.m td{ padding:8px 9px; border-bottom:1px solid var(--line-soft); vertical-align:middle; }
table.m tr:last-child td{ border-bottom:none; }
table.m tbody tr:hover{ background:var(--surface-2); }
table.m tr.cn td:first-child{ box-shadow:inset 3px 0 0 var(--cn); }
.mid{ font-size:11.5px; word-break:break-all; }
.num{ font-size:11.5px; font-variant-numeric:tabular-nums; white-space:nowrap; }
.acts{ white-space:nowrap; text-align:right; }
.tag{ font-size:10px; padding:1px 6px; border:2px solid; white-space:nowrap; }
.tag.cn{ color:var(--cn); border-color:var(--cn); background:var(--cn-soft); }
.tag.ov{ color:var(--ink-3); border-color:var(--line); }
.tag.free{ color:var(--ok); border-color:var(--ok); background:var(--ok-soft); }
.tag.paid{ color:var(--warn); border-color:var(--warn); background:var(--warn-soft); }
.spd{ display:flex; flex-direction:column; gap:3px; min-width:70px; }
.spd .n{ font-size:11.5px; color:var(--accent); font-variant-numeric:tabular-nums; }
.spd .n.na{ color:var(--ink-3); }
.spd .h{ height:3px; background:var(--accent); } .spd .h.na{ background:var(--line); }
.empty{ text-align:center; padding:32px 16px; color:var(--ink-3); font-size:12px; }

/* ══ 日志：固定高度滚动窗口 ══ */
.logwrap{ flex:1; min-height:0; display:grid; grid-template-columns:1fr 340px; gap:0; }
@media (max-width:1100px){ .logwrap{ grid-template-columns:1fr; } .logdetail{ border-left:none !important; border-top:2px solid var(--line); max-height:44vh; } }
.logbody{ display:flex; flex-direction:column; min-height:0; min-width:0; }
.logbar{ display:flex; align-items:center; gap:8px; padding:8px 12px; border-bottom:2px solid var(--line); background:var(--surface-2); flex-wrap:wrap; flex:none; }
.chips{ display:inline-flex; gap:5px; flex-wrap:wrap; }
.chip{ padding:2px 9px; font-size:11px; box-shadow:2px 2px 0 0 rgba(0,0,0,.4); }
.chip.on{ background:var(--accent); border-color:var(--accent); color:var(--accent-ink); font-weight:700; }
.chip .n{ margin-left:5px; font-variant-numeric:tabular-nums; opacity:.8; }
/* 固定高度的滚动窗口：日志再多也只在这里滚，不撑开页面 */
.logwin{
  flex:1; min-height:0; overflow-y:auto; font:11.5px/1.6 var(--mono);
  background:var(--bg);
  background-image:repeating-linear-gradient(0deg,var(--grid) 0 1px,transparent 1px 4px);
}
.ln{
  display:grid; grid-template-columns:66px 1fr 78px 62px 68px 68px;
  gap:9px; align-items:center; padding:4px 11px; cursor:pointer;
  border-bottom:1px solid var(--line-soft); font-variant-numeric:tabular-nums;
}
.ln:hover{ background:var(--surface-2); }
.ln.sel{ background:var(--accent-soft); box-shadow:inset 3px 0 0 var(--accent); }
.ln .t{ color:var(--ink-3); }
.ln .md{ color:var(--ink-2); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ln .st{ font-weight:700; }
.ln .st.ok{ color:var(--ok); } .ln .st.bad{ color:var(--bad); } .ln .st.stop{ color:var(--warn); }
.ln .n{ text-align:right; color:var(--ink-3); }
.ln .n.hi{ color:var(--accent); }
@media (max-width:860px){ .ln{ grid-template-columns:60px 1fr 66px; } .ln .opt{ display:none; } }
.logdetail{ border-left:2px solid var(--line); overflow-y:auto; background:var(--surface); }
.logdetail .dh{ padding:9px 13px; border-bottom:2px solid var(--line); background:var(--surface-2); font-size:11px; color:var(--ink-3); letter-spacing:.06em; text-transform:uppercase; position:sticky; top:0; }
.logdetail .db{ padding:13px; display:grid; gap:12px; }
.metrics{ display:grid; grid-template-columns:1fr 1fr; gap:8px 12px; }
.metrics div{ display:flex; flex-direction:column; gap:1px; min-width:0; }
.metrics .k{ font-size:10px; color:var(--ink-3); text-transform:uppercase; letter-spacing:.05em; }
.metrics .v{ font-size:12px; font-variant-numeric:tabular-nums; word-break:break-all; }
.logdetail h4{ font-size:10.5px; color:var(--ink-3); text-transform:uppercase; letter-spacing:.06em; display:flex; align-items:center; gap:8px; }
.logdetail h4 .grow{ flex:1; }
.logdetail pre{ background:var(--bg); border:2px solid var(--line-soft); padding:9px 11px; overflow:auto; max-height:240px; font:11px/1.6 var(--mono); color:var(--ink-2); white-space:pre-wrap; word-break:break-word; }
.err{ font-size:11.5px; padding:9px 11px; background:var(--bad-soft); border:2px solid var(--bad); color:var(--bad); line-height:1.6; }
.hint{ font-size:11.5px; padding:9px 11px; background:var(--warn-soft); border:2px solid var(--warn); color:var(--warn); line-height:1.6; }

/* ══ 响应式 ══ */
@media (max-width:860px){
  .shell{ grid-template-columns:1fr; height:auto; }
  body{ overflow:auto; }
  .main{ height:auto; overflow:visible; }
  .nav{ border-right:none; border-bottom:2px solid var(--line); }
  .nav ul{ display:flex; flex-wrap:wrap; gap:4px; padding:8px; }
  .nav a{ margin:0; }
  .nav .sig{ display:none; }
  .pool{ border-top:2px solid var(--line); }
  .views{ position:static; }
  .view{ position:static; inset:auto; overflow:visible; padding:14px 14px 40px; }
  .view.flush{ overflow:visible; }
  .logwin{ max-height:60vh; }
}
@media (prefers-reduced-motion:reduce){ *{ transition:none !important; animation:none !important; } }

/* 打印/极窄兜底 */
@media (max-width:520px){
  .topbar h2{ font-size:12px; }
  .code{ font-size:19px; }
}
</style>
</head>
<body>
<div class="shell">

  <!-- ══ 左栏 ══ -->
  <nav class="nav">
    <div class="brand">
      <div class="name">
        <!-- 像素 WiFi：16×16 网格，三条弧 + 底部源点，左右严格对称 -->
        <svg class="logo" viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="7" width="6" height="1"/><rect x="3" y="8" width="3" height="1"/><rect x="10" y="8" width="3" height="1"/><rect x="2" y="9" width="2" height="1"/><rect x="12" y="9" width="2" height="1"/><rect x="1" y="10" width="1" height="1"/><rect x="4" y="10" width="8" height="1"/><rect x="14" y="10" width="1" height="1"/><rect x="3" y="11" width="2" height="1"/><rect x="11" y="11" width="2" height="1"/><rect x="6" y="12" width="4" height="1"/><rect x="5" y="13" width="2" height="1"/><rect x="9" y="13" width="2" height="1"/><rect x="7" y="14" width="2" height="1"/><rect x="7" y="15" width="2" height="1"/></svg>
        cline-free
      </div>
      <div class="sub" id="brandSub">控制台</div>
    </div>

    <ul id="nav">
      <li><a data-v="chat" class="on"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 2.5h10v8H8l-3 3v-3H3z"/></svg>对话测试</a></li>
      <li><a data-v="accounts"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="5.5" r="2.6"/><path d="M2.8 13.5c.6-2.6 2.7-4 5.2-4s4.6 1.4 5.2 4"/></svg>账号<span class="cnt" id="cnt-acct"></span></a></li>
      <li><a data-v="models"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 1.8 14 5v6L8 14.2 2 11V5z"/><path d="M2 5l6 3.2L14 5M8 8.2v6"/></svg>模型<span class="cnt" id="cnt-model"></span></a></li>
      <li><a data-v="logs"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2.5 3.5h11M2.5 8h11M2.5 12.5h7"/></svg>日志<span class="cnt" id="cnt-log"></span></a></li>
      <li><a data-v="config"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.6v1.9M8 12.5v1.9M1.6 8h1.9M12.5 8h1.9M3.5 3.5l1.3 1.3M11.2 11.2l1.3 1.3M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3"/></svg>接入配置</a></li>
    </ul>

    <div class="pool">
      <div class="hd"><span class="t">账号池</span><span class="v" id="poolV">-</span></div>
      <div class="cells" id="poolCells"><span class="empty">读取中</span></div>
    </div>

    <div class="sig">
      <div class="row"><span class="fact"><span class="sq" id="keySq"></span><span id="keyTxt">密钥检查中</span></span></div>
      <div class="row" style="margin-top:5px"><span id="verTxt">v-</span> <span id="cacheTxt"></span></div>
      <div class="credit">作者 <b>Patrick</b></div>
      <div class="mp">公众号 <b>AI实用talk</b></div>
    </div>
  </nav>

  <!-- ══ 主区 ══ -->
  <div class="main">
    <div class="topbar">
      <h2 id="ttl">对话测试</h2>
      <span class="sep">/</span>
      <span class="meta" id="sub">-</span>
      <span class="grow"></span>
      <button class="xs ghost" id="btnTheme" title="切换明暗主题">主题</button>
      <button class="xs ghost" id="btnRefresh" title="刷新状态与模型">刷新</button>
    </div>

    <div class="views">
      <div class="notes" id="notes" style="position:absolute;top:0;left:0;right:0;z-index:5;padding:12px 20px 0;pointer-events:none"></div>

      <!-- ── 对话 ── -->
      <section class="view" id="v-chat">
        <div class="grid-chat">
          <div class="box" style="display:flex;flex-direction:column;min-width:0">
            <header>
              <h3>对话</h3>
              <span class="grow"></span>
              <button class="xs ghost" id="btnExport">导出记录</button>
              <button class="xs ghost" id="btnClearMsgs">清空</button>
            </header>
            <div class="thread" id="thread" style="flex:1"></div>
            <div style="border-top:2px solid var(--line);padding:11px 13px;flex:none">
              <textarea id="input" rows="2" placeholder="输入消息，Enter 发送 / Shift+Enter 换行"></textarea>
              <div style="display:flex;gap:8px;align-items:center;margin-top:9px;flex-wrap:wrap">
                <button class="primary" id="btnSend">发送</button>
                <button class="ghost" id="btnStop" hidden>停止生成</button>
                <span class="grow" style="flex:1"></span>
                <span class="num" id="cmeta" style="color:var(--ink-3)"></span>
              </div>
            </div>
          </div>

          <div class="aside">
            <div class="box">
              <header><h3>模型与参数</h3></header>
              <div class="pad">
                <label class="lb" for="model">模型</label>
                <select id="model" style="margin-bottom:9px"></select>
                <label class="chk" style="margin-bottom:9px"><input type="checkbox" id="stream" checked> 流式输出</label>
                <details class="rz"><summary>生成参数（可选）</summary>
                  <div style="margin-top:9px;display:grid;gap:9px">
                    <div><label class="lb" for="sys">system prompt</label><textarea id="sys" rows="2" placeholder="留空则不发送"></textarea></div>
                    <div><label class="lb" for="temp">temperature</label><input id="temp" placeholder="留空则不发送"></div>
                    <div><label class="lb" for="topp">top_p</label><input id="topp" placeholder="留空则不发送"></div>
                    <div style="font-size:10.5px;color:var(--ink-3);line-height:1.6">max_tokens 会被服务端剥离（上游收到会报错），输出长度由模型决定。</div>
                  </div>
                </details>
              </div>
            </div>
            <div class="box">
              <header><h3>本次指标</h3></header>
              <div class="pad0"><div class="stats pairs" id="chatStats"></div></div>
            </div>
          </div>
        </div>
      </section>

      <!-- ── 账号 ── -->
      <section class="view" id="v-accounts" hidden>
        <div class="box">
          <header>
            <h3>账号池</h3>
            <span class="grow"></span>
            <button class="xs ghost" id="btnRefreshAcct">刷新</button>
            <button class="xs primary" id="btnLogin">登录新账号</button>
          </header>
          <div class="pad"><div class="accts" id="accts"></div><div class="empty" id="acctEmpty" hidden>还没有账号。点右上角「登录新账号」，或把 refreshToken 填进环境变量。</div></div>
        </div>

        <div class="box login" id="loginBox" hidden>
          <header><h3>登录 Cline 账号</h3><span class="grow"></span><button class="xs ghost" id="btnLoginCancel">取消</button></header>
          <div class="pad" id="loginBody"></div>
        </div>

        <div class="box">
          <header><h3>关于账号持久化</h3></header>
          <div class="pad">
            <ul class="facts">
              <li>控制台登录得到的 refreshToken 只存在<b>当前实例内存</b>，进程重启或重新部署后消失。</li>
              <li>要长期生效，把 refreshToken 填进部署环境变量 <code>CLINE_REFRESH_TOKEN</code>（多账号一行一个），保存后重新部署。</li>
              <li>登录来的账号会在卡片上标注「临时」，与环境变量里的常驻账号区分。</li>
            </ul>
          </div>
        </div>
      </section>

      <!-- ── 模型 ── -->
      <section class="view" id="v-models" hidden>
        <div class="box">
          <header>
            <h3>模型列表</h3>
            <span class="grow"></span>
            <span class="note" id="mNote"></span>
            <button class="xs ghost" id="btnReloadModels">重新拉取</button>
          </header>
          <div class="pad">
            <div class="mactions" style="margin-bottom:11px">
              <div style="flex:1;min-width:170px"><label class="lb" for="mfilter">筛选模型 ID</label><input id="mfilter" placeholder="如 deepseek、qwen、:free"></div>
              <label class="chk" style="padding-bottom:6px"><input type="checkbox" id="mfree" checked> 只看免费</label>
              <label class="chk" style="padding-bottom:6px"><input type="checkbox" id="mcn"> 只看国产</label>
              <button class="primary" id="btnTestAll" style="margin-bottom:1px">测试全部</button>
              <button class="ghost" id="btnStopTest" style="margin-bottom:1px" hidden>停止</button>
            </div>
            <div class="stats" id="mStats" style="margin-bottom:11px"></div>
            <div class="bar" id="mBar" hidden style="margin-bottom:11px"><i></i></div>
            <div class="tblwrap">
              <table class="m">
                <thead><tr>
                  <th class="sort" data-s="region" style="width:9%">地区</th>
                  <th class="sort" data-s="id" style="width:33%">模型 ID</th>
                  <th style="width:9%">类型</th>
                  <th class="sort" data-s="speed" style="width:16%">输出速度</th>
                  <th class="sort" data-s="ttft" style="width:10%">首字节</th>
                  <th style="width:23%"></th>
                </tr></thead>
                <tbody id="mRows"></tbody>
              </table>
            </div>
            <div class="empty" id="mEmpty" hidden>没有符合条件的模型。</div>
          </div>
        </div>
      </section>

      <!-- ── 日志：固定高度滚动窗口 ── -->
      <section class="view flush" id="v-logs" hidden>
        <div class="box" style="border:none;box-shadow:none;display:flex;flex-direction:column;height:100%;min-height:0">
          <header style="flex:none">
            <h3>请求日志</h3>
            <span class="grow"></span>
            <span class="note" id="logNote">最近 60 条</span>
            <button class="xs ghost" id="btnExportLogs">导出 JSON</button>
            <button class="xs ghost danger" id="btnClearLogs">清空</button>
          </header>
          <div class="logwrap">
            <div class="logbody">
              <div class="logbar">
                <span class="chips">
                  <button class="chip on" data-f="all">全部<span class="n" id="cAll">0</span></button>
                  <button class="chip" data-f="ok">成功<span class="n" id="cOk">0</span></button>
                  <button class="chip" data-f="fail">失败<span class="n" id="cFail">0</span></button>
                  <button class="chip" data-f="slow">慢请求<span class="n" id="cSlow">0</span></button>
                </span>
                <span class="grow" style="flex:1"></span>
                <input id="lfilter" placeholder="搜索模型" style="width:140px">
                <button class="xs" id="btnFollow" title="开启后新日志自动滚到最新">跟随最新：开</button>
              </div>
              <div class="logwin" id="logwin"></div>
            </div>
            <div class="logdetail">
              <div class="dh">条目详情</div>
              <div class="db" id="logDetail"><div class="empty">点击左侧任意一行查看完整指标与原始报文。</div></div>
            </div>
          </div>
        </div>
      </section>

      <!-- ── 接入配置 ── -->
      <section class="view" id="v-config" hidden>
        <div class="grid2">
          <div class="box">
            <header><h3>连接信息</h3></header>
            <div class="pad">
              <dl class="kv">
                <dt>Base URL</dt><dd><input id="baseurl" readonly><button class="xs ghost" data-copy="baseurl">复制</button></dd>
                <dt>API Key</dt><dd><input id="key" type="password" autocomplete="off" placeholder="本地运行会自动生成"><button class="xs ghost" data-copy="key">复制</button></dd>
                <dt>当前模型</dt><dd><input id="curmodel" readonly><button class="xs ghost" data-copy="curmodel">复制</button></dd>
              </dl>
              <p style="font-size:10.5px;color:var(--ink-3);line-height:1.7;margin-top:11px">密钥只保存在本机浏览器。本地运行时由 local-server.js 自动生成并注入，无需手填；线上部署请在环境变量里设置。</p>
            </div>
          </div>
          <div class="box">
            <header><h3>接入须知</h3></header>
            <div class="pad">
              <ul class="facts">
                <li>同时兼容 OpenAI（<code>/v1/chat/completions</code>）与 Anthropic（<code>/v1/messages</code>），两边官方 SDK 都能直连。</li>
                <li>Cloudflare 的 workers.dev 域名按 User-Agent 拦请求，非浏览器 UA 可能得到 <code>1010</code>；改用 Vercel 域名或加浏览器 UA。</li>
                <li><code>402</code> 表示付费档余额不足，换带 <code>:free</code> 或 <code>cline-free/</code> 的免费模型。</li>
                <li><code>429 Daily free limit</code> 是账号当日额度用尽，等冷却或追加账号自动切号。</li>
                <li>服务端未配 <code>API_KEY</code> 时聊天端点返回 401，不会回退到公开默认密钥。</li>
              </ul>
            </div>
          </div>
        </div>
        <div class="box">
          <header><h3>客户端接入代码</h3><span class="grow"></span><span class="note">已填入上面的地址与密钥</span></header>
          <div class="pad">
            <div class="snip-tabs" id="snipTabs"></div>
            <pre class="snip" id="snip"></pre>
            <div style="display:flex;gap:9px;align-items:center;margin-top:10px;flex-wrap:wrap">
              <button class="primary" id="btnCopySnip">复制这段代码</button>
              <span class="grow" style="flex:1"></span>
              <span class="num" style="color:var(--ink-3)" id="snipNote"></span>
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</div>

<script>
/* ══════════════════════════════════════════════════════════════════
   cline-free 控制台
   约定：不使用模板字符串插值（构建脚本会转义 \${}），一律用字符串拼接。
   ══════════════════════════════════════════════════════════════════ */
var $ = function (id) { return document.getElementById(id); };
var LS = {
  key:"cf.key", model:"cf.model", msgs:"cf.msgs", params:"cf.params", tab:"cf.tab",
  logs:"cf.logs", filter:"cf.filter", sort:"cf.sort", tests:"cf.tests",
  theme:"cf.theme", follow:"cf.follow", sel:"cf.sel", freeOnly:"cf.freeOnly"
};

/* 国产模型厂商识别（按 model id 的 provider 段匹配）。
   这份表决定「国产优先」排序与「国产」标签，宁可少标也不要错标。 */
var CN_PROVIDERS = {
  "deepseek":"DeepSeek", "z-ai":"智谱 GLM", "zai":"智谱 GLM", "glm":"智谱 GLM",
  "qwen":"阿里通义", "xiaomi":"小米", "minimax":"MiniMax", "moonshot":"月之暗面",
  "inclusionai":"蚂蚁 inclusionAI", "nex-agi":"Nex AGI", "stepfun":"阶跃星辰",
  "01-ai":"零一万物", "yi":"零一万物", "baichuan":"百川", "doubao":"字节豆包",
  "hunyuan":"腾讯混元", "ernie":"百度文心", "sensetime":"商汤", "thudm":"智谱",
  "kimi":"月之暗面", "bailian":"阿里百炼", "modelscope":"魔搭"
};
/* 已知海外厂商（用于把「未知」与「明确海外」区分开） */
var OV_PROVIDERS = {
  "google":"Google", "nvidia":"NVIDIA", "poolside":"Poolside", "liquid":"Liquid AI",
  "cohere":"Cohere", "thinkingmachines":"Thinking Machines", "anthropic":"Anthropic",
  "openai":"OpenAI", "meta":"Meta", "mistralai":"Mistral", "microsoft":"Microsoft",
  "amazon":"Amazon", "dots-studio":"Dots Studio", "x-ai":"xAI"
};

var VIEWS = {
  chat:{t:"对话测试",s:"多轮对话自动带上下文"},
  accounts:{t:"账号",s:"账号池状态与登录"},
  models:{t:"模型",s:"浏览模型，测延迟与输出速度"},
  logs:{t:"日志",s:"固定窗口滚动查看历史请求"},
  config:{t:"接入配置",s:"把服务接到你的客户端"}
};

var state = {
  key:"", model:"", models:[], messages:[], chatStats:null,
  stream:true, temp:"", topp:"", sys:"",
  health:null, logs:[], filter:"all", search:"", sort:"region", sortDir:1,
  testing:false, busy:false, abort:null, snip:"curl",
  login:null, loginTimer:null, follow:true, selId:null
};

function save(k,v){ try{ localStorage.setItem(k, typeof v==="string"?v:JSON.stringify(v)); }catch(e){} }
function load(k,d){
  try{
    var raw=localStorage.getItem(k);
    if(raw===null||raw==="undefined") return d;
    try{ return JSON.parse(raw); }catch(e){ return raw; }
  }catch(e){ return d; }
}
function esc(s){
  return String(s===null||s===undefined?"":s)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}
function fmtMs(ms){
  if(ms===null||ms===undefined||isNaN(ms)) return "-";
  if(ms<1000) return Math.round(ms)+"ms";
  if(ms<60000) return (ms/1000).toFixed(2)+"s";
  return Math.floor(ms/60000)+"m"+Math.round((ms%60000)/1000)+"s";
}
function fmtNum(n,d){
  if(n===null||n===undefined||isNaN(n)||!isFinite(n)) return "-";
  return d===undefined?String(Math.round(n)):n.toFixed(d);
}
function fmtClock(ts){
  var x=new Date(ts),p=function(n){return (n<10?"0":"")+n;};
  return p(x.getHours())+":"+p(x.getMinutes())+":"+p(x.getSeconds());
}
function baseUrl(){ return location.origin+"/v1"; }
function authHeaders(){
  var h={"Content-Type":"application/json"};
  if(state.key) h["Authorization"]="Bearer "+state.key;
  return h;
}
function selectText(el){
  if(!el) return false;
  try{
    if(el.tagName==="INPUT"||el.tagName==="TEXTAREA"){ el.focus(); el.select(); if(el.setSelectionRange) el.setSelectionRange(0,el.value.length); return true; }
    var r=document.createRange(); r.selectNodeContents(el);
    var s=window.getSelection(); s.removeAllRanges(); s.addRange(r); return true;
  }catch(e){ return false; }
}
function legacyCopy(t){
  try{
    var ta=document.createElement("textarea");
    ta.value=t; ta.setAttribute("readonly","");
    ta.style.position="fixed"; ta.style.top="-1000px"; ta.style.opacity="0";
    document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0,ta.value.length);
    var ok=document.execCommand("copy"); document.body.removeChild(ta); return ok;
  }catch(e){ return false; }
}
function flash(btn,text){
  if(!btn) return;
  if(!btn.getAttribute("data-old")) btn.setAttribute("data-old",btn.textContent);
  btn.textContent=text; btn.classList.add("done");
  clearTimeout(btn._t);
  btn._t=setTimeout(function(){ btn.textContent=btn.getAttribute("data-old")||text; btn.classList.remove("done"); btn.removeAttribute("data-old"); },1300);
}
function copyText(text,btn,src){
  if(!text){ flash(btn,"无内容"); return; }
  var ok=function(){ flash(btn,"已复制"); };
  var bad=function(){ if(selectText(src)) flash(btn,"已选中 Ctrl+C"); else flash(btn,"请手动复制"); };
  if(navigator.clipboard&&navigator.clipboard.writeText&&window.isSecureContext){
    navigator.clipboard.writeText(text).then(ok,function(){ legacyCopy(text)?ok():bad(); });
  } else { legacyCopy(text)?ok():bad(); }
}
function explain(status,body){
  var b=String(body||""),low=b.toLowerCase();
  if(low.indexOf("all_accounts_cooling")>=0) return "所有账号免费额度都在冷却中。等冷却结束，或追加更多账号自动切号。";
  if(low.indexOf("server_no_key")>=0) return "服务端没有配置 API_KEY，聊天端点已拒绝请求。";
  if(low.indexOf("missing_client_key")>=0||low.indexOf("wrong_client_key")>=0||status===401) return "API Key 不正确或缺失，到「接入配置」填写。";
  if(status===429) return "被上游限流（429），多为当日免费额度用尽。";
  if(low.indexOf("insufficient_credits")>=0||status===402) return "该模型属付费档且余额不足（402），换免费模型。";
  if(low.indexOf("only available via cline product surfaces")>=0) return "上游把调用识别成第三方（403），可能是风控策略有变。";
  if(low.indexOf("model not found")>=0||status===404) return "模型不存在（404），可能已下架。";
  if(low.indexOf("empty response content")>=0) return "上游返回空响应，免费通道偶发，重试通常即可。";
  if(status===1010||low.indexOf("error code: 1010")>=0) return "被 Cloudflare 网关拦截（1010），给请求加浏览器 UA 或改用 Vercel 域名。";
  if(status>=500) return "服务端或上游出错（"+status+"），可重试。";
  return "请求失败（"+status+"）。";
}

/* ══ 视图切换 ══ */
function showTab(name){
  if(!VIEWS[name]) name="chat";
  var as=$("nav").querySelectorAll("a[data-v]");
  for(var i=0;i<as.length;i++) as[i].classList.toggle("on", as[i].getAttribute("data-v")===name);
  var vs=document.querySelectorAll(".view");
  for(var j=0;j<vs.length;j++){
    var mine=vs[j].id==="v-"+name;
    vs[j].hidden=!mine;
  }
  $("ttl").textContent=VIEWS[name].t;
  $("sub").textContent=VIEWS[name].s;
  document.title=VIEWS[name].t+" · cline-free";
  save(LS.tab,name);
  if(name==="config") renderSnip();
  if(name==="logs") renderLogs();
  if(name==="accounts") renderAccts();
}

/* ══ 健康 / 账号池 ══ */
function renderHealth(h){
  state.health=h;
  var avail=h.accounts_available||0,total=h.account_count||0,det=h.account_details||[];
  var cells=$("poolCells");
  if(!total){ cells.innerHTML='<span class="empty">未配置账号</span>'; }
  else{
    cells.innerHTML=det.map(function(a){
      var cls="cell "+(a.available?"live":"cool")+(a.runtime?" tmp":"");
      var tip="账号 #"+(a.index+1);
      if(a.email) tip+="（"+a.email+"）";
      tip+="：" +(a.available?"可用":"冷却中");
      if(!a.available&&a.cooldown_seconds){
        tip+="，剩约 "+Math.ceil(a.cooldown_seconds/60)+" 分钟";
        if(a.cooldown_reason==="limit") tip+="（额度用尽）";
        else if(a.cooldown_reason==="empty") tip+="（空响应）";
        else if(a.cooldown_reason==="auth") tip+="（鉴权失败）";
      }
      if(a.runtime) tip+="，登录得到（重启会丢）";
      else if(a.token_cached) tip+="，token 已缓存";
      var lb=a.available?String(a.index+1):(a.cooldown_seconds?Math.ceil(a.cooldown_seconds/60)+"m":"!");
      return '<span class="'+cls+'" title="'+esc(tip)+'">'+esc(lb)+"</span>";
    }).join("");
  }
  var cls=total===0?"bad":(avail===0?"warn":"ok");
  $("poolV").textContent=avail+" / "+total;
  $("poolV").className="v "+cls;
  $("cnt-acct").textContent=total?String(total):"";

  var ok=h.api_key_configured;
  $("keySq").className="sq "+(ok?"ok":"bad");
  $("keyTxt").textContent=ok?"密钥已配置":"密钥未配置";
  $("verTxt").textContent="v"+h.version;
  $("cacheTxt").textContent="· 模型缓存 "+((h.models_cached||0));

  var n="";
  if(!ok) n+='<div class="note bad"><span class="grow">服务端未配置 <b>API_KEY</b>，聊天端点会拒绝所有请求。</span></div>';
  else if(!state.key) n+='<div class="note info"><span class="grow">还没有访问密钥。本地运行会自动生成并注入。</span><button class="xs ghost" onclick="goConfig()">去填写</button></div>';
  if(total===0) n+='<div class="note bad"><span class="grow">服务端未配置 <b>CLINE_REFRESH_TOKEN</b>，无法调用上游。</span><button class="xs ghost" onclick="goAccounts()">去登录</button></div>';
  else if(avail===0) n+='<div class="note warn"><span class="grow">当前 0 个账号可用，请求会直接返回 429。</span></div>';
  if(h.runtime_accounts>0) n+='<div class="note warn"><span class="grow">有 '+h.runtime_accounts+' 个登录得到的临时账号，重启后会消失，建议存进环境变量。</span><button class="xs ghost" onclick="goAccounts()">查看</button></div>';
  var box=$("notes");
  box.innerHTML=n;
  box.style.pointerEvents=n?"auto":"none";
  if(!$("v-accounts").hidden) renderAccts();
}
function goConfig(){ showTab("config"); $("key").focus(); }
function goAccounts(){ showTab("accounts"); }

function loadHealth(){
  return fetch("/v1/health",{cache:"no-store"}).then(function(r){return r.json();}).then(renderHealth).catch(function(){
    $("keySq").className="sq bad";
    $("keyTxt").textContent="无法连接服务";
    $("poolV").textContent="-"; $("poolV").className="v bad";
  });
}

/* ══ 账号页 ══ */
function renderAccts(){
  var det=(state.health&&state.health.account_details)||[];
  var g=$("accts");
  if(!det.length){ g.innerHTML=""; $("acctEmpty").hidden=false; return; }
  $("acctEmpty").hidden=true;
  g.innerHTML=det.map(function(a){
    var cls=a.available?"live":"cool";
    var cd="-";
    if(!a.available&&a.cooldown_seconds){
      cd=Math.ceil(a.cooldown_seconds/60)+"分";
      if(a.cooldown_reason==="limit") cd+=" 额度";
      else if(a.cooldown_reason==="empty") cd+=" 空响应";
      else if(a.cooldown_reason==="auth") cd+=" 鉴权";
    }
    return '<div class="acct '+cls+'">'+
      '<div class="top"><span class="ix">'+(a.index+1)+'</span>'+
      '<span class="ml" title="'+esc(a.email||"未登录邮箱")+'">'+esc(a.email||("账号 #"+(a.index+1)))+'</span></div>'+
      '<div class="st">'+(a.available?"可用":"冷却中")+'</div>'+
      '<dl>'+
        '<div><span class="k">来源</span><span class="v">'+(a.runtime?"登录（临时）":"环境变量")+'</span></div>'+
        '<div><span class="k">token 缓存</span><span class="v">'+(a.token_cached?"有":"无")+'</span></div>'+
        '<div><span class="k">冷却</span><span class="v">'+esc(cd)+'</span></div>'+
      '</dl></div>';
  }).join("");
}

/* ── 登录 ── */
function startLogin(){
  $("loginBox").hidden=false;
  $("loginBody").innerHTML='<div class="num" style="color:var(--ink-3)">正在申请授权码…</div>';
  fetch("/v1/login/start",{method:"POST",headers:authHeaders(),body:"{}"})
    .then(function(r){ return r.json().then(function(d){ return {r:r,d:d}; }); })
    .then(function(o){
      if(!o.r.ok||!o.d.ok){
        $("loginBody").innerHTML='<div class="err"><b>无法开始登录：</b>'+esc((o.d.error&&o.d.error.message)||("HTTP "+o.r.status))+'</div>'+
          '<div style="margin-top:11px"><button class="ghost" onclick="startLogin()">重试</button></div>';
        return;
      }
      state.login={device_code:o.d.device_code,expires_in:o.d.expires_in,started:Date.now(),interval:o.d.interval};
      renderLogin(o.d);
      pollLogin();
    })
    .catch(function(e){
      $("loginBody").innerHTML='<div class="err"><b>请求异常：</b>'+esc(String(e&&e.message||e))+'</div>';
    });
}
function renderLogin(d){
  $("loginBody").innerHTML=
    '<p style="font-size:12px;color:var(--ink-2)">点下面按钮打开授权页面，登录 Cline 账号并确认。本页会自动检测结果。</p>'+
    '<div style="display:flex;gap:8px;flex-wrap:wrap;margin:11px 0 4px">'+
      '<a href="'+esc(d.verification_uri)+'" target="_blank" rel="noopener" style="text-decoration:none"><button class="primary" id="btnOpenAuth">打开授权页面</button></a>'+
      '<button class="ghost" id="btnReopen">在本页打开</button></div>'+
    '<div class="linkrow"><span class="u" title="'+esc(d.verification_uri)+'">'+esc(d.verification_uri)+'</span>'+
      '<button class="xs ghost" id="btnCopyLink">复制链接</button></div>'+
    '<p style="font-size:11px;color:var(--ink-3)">若页面要求输入设备码，即下面这串：</p>'+
    '<div class="code" id="deviceCode">'+esc(d.user_code||"------")+'</div>'+
    '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'+
      '<button class="xs ghost" id="btnCopyCode">复制设备码</button>'+
      '<span class="grow" style="flex:1"></span>'+
      '<span class="num" style="color:var(--ink-3)" id="loginStatus">等待授权…</span></div>'+
    '<div class="meter" id="loginMeter"><i></i></div>';
  $("btnReopen").addEventListener("click",function(){ window.open(d.verification_uri,"_blank","noopener"); });
  $("btnCopyLink").addEventListener("click",function(){ copyText(d.verification_uri,$("btnCopyLink"),document.querySelector(".linkrow .u")); });
  $("btnCopyCode").addEventListener("click",function(){ copyText(d.user_code||"",$("btnCopyCode"),$("deviceCode")); });
}
function pollLogin(){
  if(!state.login) return;
  clearTimeout(state.loginTimer);
  var el=Date.now()-state.login.started, tot=(state.login.expires_in||300)*1000;
  if(el>tot){ finishLogin(false,"授权超时，请重新登录。"); return; }
  var m=$("loginMeter");
  if(m) m.querySelector("i").style.width=Math.min(el/tot*100,100)+"%";
  var st=$("loginStatus");
  if(st) st.textContent="等待授权…（剩余 "+Math.max(Math.ceil((tot-el)/1000),0)+" 秒）";
  fetch("/v1/login/poll",{method:"POST",headers:authHeaders(),body:JSON.stringify({device_code:state.login.device_code})})
    .then(function(r){ return r.json(); })
    .then(function(d){
      if(!state.login) return;
      if(d.status==="pending"||d.status==="slow_down"){ state.loginTimer=setTimeout(pollLogin,(state.login.interval||5)*1000); return; }
      if(d.status==="success"){ finishLogin(true,d); return; }
      finishLogin(false,(d.error&&d.error.message)||"授权失败。");
    })
    .catch(function(){ if(state.login) state.loginTimer=setTimeout(pollLogin,6000); });
}
function finishLogin(ok,payload){
  clearTimeout(state.loginTimer);
  if(!ok){
    state.login=null;
    $("loginBody").innerHTML='<div class="err"><b>登录未完成：</b>'+esc(payload)+'</div>'+
      '<div style="margin-top:11px"><button class="ghost" onclick="startLogin()">重新登录</button></div>';
    return;
  }
  state.login=null;
  var rt=payload.refresh_token||"";
  $("loginBody").innerHTML=
    '<div class="note ok" style="margin-bottom:11px"><span class="grow">登录成功'+(payload.email?"："+esc(payload.email):"")+'，账号已加入账号池，可立即使用。</span></div>'+
    '<p style="font-size:12px;color:var(--ink-2)">该账号目前只在当前实例内存里，<b>重启或重新部署后会消失</b>。想长期保留，把下面这个 refreshToken 填进环境变量 <code>CLINE_REFRESH_TOKEN</code>：</p>'+
    '<pre class="snip" id="rtBox" style="margin:11px 0">'+esc(rt)+'</pre>'+
    '<div style="display:flex;gap:8px;flex-wrap:wrap">'+
      '<button class="primary" id="btnCopyRt">复制 refreshToken</button>'+
      '<button class="ghost" id="btnDoneLogin">完成</button></div>';
  $("btnCopyRt").addEventListener("click",function(){ copyText(rt,$("btnCopyRt"),$("rtBox")); });
  $("btnDoneLogin").addEventListener("click",function(){ $("loginBox").hidden=true; $("loginBody").innerHTML=""; });
  setTimeout(loadHealth,400);
}
function cancelLogin(){
  clearTimeout(state.loginTimer); state.login=null;
  $("loginBox").hidden=true; $("loginBody").innerHTML="";
}

/* ══ 模型 ══ */
function providerOf(id){
  var p=String(id||"").split("/")[0].toLowerCase();
  return p;
}
function regionOf(id){
  var p=providerOf(id);
  if(CN_PROVIDERS[p]) return "cn";
  if(OV_PROVIDERS[p]) return "ov";
  if(id.indexOf("cline-free/")===0) return "of";   // 官方免费通道，不归地区
  return "ov";                                      // 未知按海外处理（不冒标国产）
}
function regionName(id){
  var p=providerOf(id), r=regionOf(id);
  if(r==="cn") return CN_PROVIDERS[p]||"国产";
  if(r==="of") return "官方";
  // 已知海外厂商显示厂商名；不在两张表里的**直接显示 provider 本身**，
  // 不要谎称"海外"（上游有 60+ 个 provider，多数我们并不认识）
  return OV_PROVIDERS[p]||p;
}
function isFree(m){ return typeof m.cost==="string" ? m.cost==="free" : (/:free$/.test(m.id)||m.id.indexOf("cline-free/")===0); }
function costPill(m){
  // 服务端只放行确定免费的模型，所以正常情况下这里显示的都是「免费」类；
  // 「实测免费」用于区分来源——官方分类没覆盖、由白名单人工实测登记的模型，
  // 客户端看到它就知道这条免费依据是人工验证而不是官方标注。
  // 保留「需订阅 / 云额度」分支：上游拉取失败时会回退到内置列表，其中含 cline-pass 项。
  if(m.channel==="recommended") return '<span class="tag free">推荐</span>';
  if(m.channel==="verified") return '<span class="tag free">实测免费</span>';
  if(m.channel==="free"||m.channel==="free-suffix"||m.cost==="free") return '<span class="tag free">免费</span>';
  if(m.channel==="cline-pass"||m.cost==="pass") return '<span class="tag paid">需订阅</span>';
  if(m.channel==="cline-cloud"||m.cost==="cloud") return '<span class="tag paid">云额度</span>';
  if(m.cost==="paid") return '<span class="tag paid">付费</span>';
  return '<span class="tag ov">未标价</span>';
}
function loadModels(){
  var saved=load(LS.tests,{})||{};
  return fetch("/v1/models",{cache:"no-store"})
    .then(function(r){ return r.json(); })
    .then(function(d){
      state.models=(d.data||[]).map(function(m){
        return { id:m.id, cost:m.cost, free:m.free, channel:m.channel, label:m.label, test:state.testingIds&&state.testingIds[m.id]||saved[m.id]||null };
      });
    })
    .catch(function(){ state.models=[]; })
    .then(function(){
      $("cnt-model").textContent=state.models.length?String(state.models.length):"";
      var sel=$("model");
      if(!state.models.length){
        sel.innerHTML='<option value="">模型列表拉取失败</option>';
        $("mRows").innerHTML=""; $("mEmpty").hidden=false; $("mEmpty").textContent="模型列表拉取失败，点「重新拉取」重试。";
        renderMStats(); return;
      }
      var ids=state.models.map(function(m){return m.id;});
      sel.innerHTML=ids.map(function(id){ return '<option value="'+esc(id)+'"'+(id===state.model?" selected":"")+">"+esc(id)+"</option>"; }).join("");
      if(ids.indexOf(state.model)<0){ state.model=ids[0]; sel.value=state.model; save(LS.model,state.model); }
      renderMRows(); renderMStats();
    });
}
function visibleModels(){
  var q=$("mfilter").value.trim().toLowerCase();
  var freeOnly=$("mfree").checked, cnOnly=$("mcn").checked;
  var list=state.models.filter(function(m){
    if(freeOnly&&!isFree(m)) return false;
    if(cnOnly&&regionOf(m.id)!=="cn") return false;
    if(q&&m.id.toLowerCase().indexOf(q)<0&&regionName(m.id).toLowerCase().indexOf(q)<0) return false;
    return true;
  });
  var s=state.sort, dir=state.sortDir;
  list.sort(function(a,b){
    var r;
    // 地区排序：国产始终优先（无论升降序都先给国产，第二段才按 id）
    if(s==="region"){
      var ra=regionOf(a.id)==="cn"?0:1, rb=regionOf(b.id)==="cn"?0:1;
      if(ra!==rb) return ra-rb;
      r = a.id<b.id?-1:a.id>b.id?1:0;
      return r*dir;
    }
    if(s==="speed"){
      var av=typeof a.test?.tps==="number"?a.test.tps:-1, bv=typeof b.test?.tps==="number"?b.test.tps:-1;
      if(av!==bv) return (av-bv)*dir;
    } else if(s==="ttft"){
      var at=a.test&&a.test.ttft!=null?a.test.ttft:Infinity, bt=b.test&&b.test.ttft!=null?b.test.ttft:Infinity;
      if(at!==bt) return (at-bt)*dir;
    }
    r = a.id<b.id?-1:a.id>b.id?1:0;
    return r*dir;
  });
  return list;
}
function renderMRows(){
  var list=visibleModels(), maxTps=0;
  for(var k=0;k<state.models.length;k++){ var t=state.models[k].test; if(t&&t.tps>maxTps) maxTps=t.tps; }
  $("mRows").innerHTML=list.map(function(m){
    var t=m.test, spd, ttft, isCn=regionOf(m.id)==="cn";
    if(!t){
      spd='<div class="spd"><span class="n na">未测试</span><span class="h na" style="width:0"></span></div>';
      ttft='<span class="num" style="color:var(--ink-3)">-</span>';
    } else if(t.ok){
      var pct=maxTps>0&&t.tps?Math.max(3,Math.round(t.tps/maxTps*100)):0;
      spd='<div class="spd"><span class="n">'+fmtNum(t.tps,1)+' tok/s</span><span class="h" style="width:'+pct+'%"></span></div>';
      ttft='<span class="num">'+fmtMs(t.ttft)+"</span>";
    } else {
      spd='<div class="spd"><span class="n" style="color:var(--bad)">失败</span><span class="h" style="width:0;background:var(--bad)"></span></div>';
      ttft='<span class="num" style="color:var(--ink-3)">-</span>';
    }
    var btn='<button class="xs ghost" data-test="'+esc(m.id)+'">'+(t&&t.busy?"测试中":t?"重测":"测试")+"</button>";
    var title="";
    if(t&&t.at){ var mi=Math.round((Date.now()-t.at)/60000); title=' title="上次测量：'+(mi<1?"刚刚":mi+" 分钟前")+'"'; }
    var regTag = isCn ? '<span class="tag cn">'+esc(regionName(m.id))+"</span>"
                      : (regionOf(m.id)==="of" ? '<span class="tag free">官方</span>' : '<span class="tag ov">'+esc(regionName(m.id))+"</span>");
    return '<tr class="'+(isCn?"cn":"")+'">'+
      "<td>"+regTag+"</td>"+
      '<td class="mid">'+esc(m.id)+"</td>"+
      "<td>"+costPill(m)+"</td>"+
      "<td"+title+">"+spd+"</td>"+
      "<td>"+ttft+"</td>"+
      '<td class="acts">'+btn+" "+
        '<button class="xs ghost" data-copyid="'+esc(m.id)+'">复制 ID</button> '+
        '<button class="xs ghost" data-use="'+esc(m.id)+'">用于对话</button></td></tr>';
  }).join("");
  var emp=$("mEmpty");
  if(!list.length){ emp.hidden=false; emp.textContent=state.models.length?"没有符合筛选条件的模型。":"模型列表为空。"; }
  else emp.hidden=true;
  // 列表本身已按免费白名单筛过，所以默认「只看免费」几乎不减少条数；
  // 这里仍区分总数与显示数，是为了让「只看国产」与搜索的筛选结果一目了然
  var cnAll=state.models.filter(function(m){return regionOf(m.id)==="cn";}).length;
  $("mNote").textContent="可用免费模型 "+state.models.length+" 个（国产 "+cnAll+"）· 当前显示 "+list.length+" 个";
}
function renderMStats(){
  var tot=state.models.length;
  var free=state.models.filter(isFree).length;
  var cn=state.models.filter(function(m){return regionOf(m.id)==="cn";}).length;
  var tested=state.models.filter(function(m){return m.test&&m.test.ok;});
  var tpss=tested.map(function(m){return m.test.tps;}).filter(function(v){return typeof v==="number"&&isFinite(v)&&v>0;});
  var ttfts=tested.map(function(m){return m.test.ttft;}).filter(function(v){return typeof v==="number"&&isFinite(v);});
  var avg=function(a){ return a.length? a.reduce(function(x,y){return x+y;},0)/a.length : null; };
  // 服务端已按免费白名单筛过，所以"总数"就等于可用免费模型数。
  // 上游拉取失败会回退到内置列表（含 cline-pass 等非免费项），届时两者不等，
  // 这种情况额外标出非免费条数，免得让人以为列表里全是免费可用的。
  var paid=tot-free;
  $("mStats").innerHTML=[
    cell("可用免费模型",String(free),"ok"),
    cell("国产模型",String(cn),"cn"),
    cell("已测通",tested.length+" / "+tot),
    cell("平均速度",avg(tpss)!==null?fmtNum(avg(tpss),1)+" tok/s":"-",avg(tpss)!==null?"ok":""),
    cell("最快首字节",ttfts.length?fmtMs(Math.min.apply(null,ttfts)):"-")
  ].concat(paid>0?[cell("非免费（回退列表）",String(paid),"")]:[]).join("");
}
function cell(k,v,cls){ return '<div><div class="k">'+esc(k)+'</div><div class="v '+(cls||"")+'">'+esc(v)+"</div></div>"; }

function testModel(id){
  var m=null;
  for(var i=0;i<state.models.length;i++) if(state.models[i].id===id){ m=state.models[i]; break; }
  if(!m||(m.test&&m.test.busy)) return;
  m.test={busy:true,ok:false,ttft:null,tps:null};
  renderMRows();
  var ctrl=new AbortController();
  var timer=setTimeout(function(){ try{ctrl.abort();}catch(e){} },40000);
  var t0=performance.now(), ttft=null, chars=0, tokens=null, usage=null, early=false;
  var body={model:id,stream:true,messages:[{role:"user",content:"从 1 数到 25，用英文逗号分隔，只输出数字本身。"}]};
  var reqBody=JSON.stringify(body,null,2);

  fetch("/v1/chat/completions",{method:"POST",headers:authHeaders(),body:JSON.stringify(body),signal:ctrl.signal})
    .then(function(r){
      if(!r.ok){
        return r.text().then(function(txt){
          clearTimeout(timer);
          m.test={ok:false,ttft:null,tps:null,error:"HTTP "+r.status,hint:explain(r.status,txt)};
          renderMRows(); renderMStats();
          addLog({kind:"test",model:id,stream:true,ok:false,status:r.status,error:"HTTP "+r.status+" "+txt.slice(0,400),hint:explain(r.status,txt),requestBody:reqBody,responseRaw:txt.slice(0,4000)});
          persistTest(id,m.test);
        });
      }
      var reader=r.body.getReader(), dec=new TextDecoder(), buf="";
      function pump(){
        return reader.read().then(function(s){
          if(s.done) return null;
          buf+=dec.decode(s.value,{stream:true});
          var ix;
          while((ix=buf.indexOf("\\n"))>=0){
            var line=buf.slice(0,ix); buf=buf.slice(ix+1);
            if(line.indexOf("data:")!==0) continue;
            var p=line.slice(5).trim();
            if(!p||p==="[DONE]") continue;
            try{
              var o=JSON.parse(p), c=o.choices&&o.choices[0], dl=(c&&c.delta)||{};
              if(ttft===null&&(dl.content||dl.reasoning)) ttft=performance.now()-t0;
              if(dl.content) chars+=dl.content.length;
              if(o.usage) usage=o.usage;
            }catch(e){}
          }
          if(usage||chars>=120){ early=true; try{ctrl.abort();}catch(e){} return null; }
          return pump();
        });
      }
      return pump().then(function(){
        clearTimeout(timer);
        var totalMs=performance.now()-t0;
        if(usage) tokens=usage.completion_tokens||null;
        var genMs=Math.max(totalMs-(ttft||0),1);
        var tps=tokens? tokens/(genMs/1000) : (chars? chars/(genMs/1000) : null);
        if(ttft===null){
          m.test={ok:false,ttft:null,tps:null,error:"无响应内容",hint:"上游返回 200 但没有内容，重试通常即可。"};
        } else {
          m.test={ok:true,ttft:ttft,tps:tps,basis:tokens?"token":"chars",tokens:tokens,chars:chars,genMs:genMs,totalMs:totalMs,early:early};
        }
        renderMRows(); renderMStats();
        addLog({kind:"test",model:id,stream:true,ok:m.test.ok,status:200,ttft:m.test.ttft,totalMs:totalMs,genMs:genMs,tokens:tokens,chars:chars,tps:tps,tpsBasis:m.test.basis,
          promptTokens:usage?usage.prompt_tokens:null,completionTokens:usage?usage.completion_tokens:null,totalTokens:usage?usage.total_tokens:null,
          reasoningTokens:usage&&usage.completion_tokens_details?usage.completion_tokens_details.reasoning_tokens:null,
          stopped:early,note:"模型页测速，拿到样本后主动中止",error:m.test.ok?null:m.test.error,hint:m.test.ok?null:m.test.hint,
          requestBody:reqBody,responseRaw:usage?JSON.stringify(usage,null,2):"已中止（未取得 usage）"});
        persistTest(id,m.test);
      });
    })
    .catch(function(e){
      clearTimeout(timer);
      var stopped=String(e&&e.name)==="AbortError";
      if(stopped&&ttft!==null){
        var tm=performance.now()-t0, gm=Math.max(tm-ttft,1);
        m.test={ok:true,ttft:ttft,tps:tokens?tokens/(gm/1000):(chars?chars/(gm/1000):null),basis:tokens?"token":"chars",tokens:tokens,chars:chars,genMs:gm,totalMs:tm,early:true};
      } else {
        m.test={ok:false,ttft:null,tps:null,error:stopped?"超时":String(e&&e.message||e).slice(0,80),hint:stopped?"40 秒内没有收到内容，可能上游繁忙或该模型不可用。":"请求异常，检查服务是否在运行。"};
      }
      renderMRows(); renderMStats();
      addLog({kind:"test",model:id,stream:true,ok:m.test.ok,status:m.test.ok?200:null,ttft:m.test.ttft,totalMs:m.test.totalMs,genMs:m.test.genMs,
        tokens:m.test.tokens,chars:m.test.chars,tps:m.test.tps,tpsBasis:m.test.basis,stopped:m.test.early,note:"模型页测速",
        error:m.test.ok?null:m.test.error,hint:m.test.ok?null:m.test.hint,requestBody:reqBody});
      persistTest(id,m.test);
    })
    .then(function(){
      if(m.test) delete m.test.busy;
      state.testingIds[id]=m.test||null;
      renderMRows();
    });
}
function persistTest(id,t){
  var saved=load(LS.tests,{})||{};
  saved[id]={ok:!!t.ok,ttft:t.ttft||null,tps:t.tps||null,basis:t.basis||null,tokens:t.tokens||null,chars:t.chars||null,
    genMs:t.genMs||null,totalMs:t.totalMs||null,error:t.error||null,hint:t.hint||null,at:Date.now()};
  var ks=Object.keys(saved);
  if(ks.length>80){
    ks.sort(function(a,b){ return (saved[a].at||0)-(saved[b].at||0); });
    for(var i=0;i<ks.length-80;i++) delete saved[ks[i]];
  }
  save(LS.tests,saved);
}
function testAll(){
  if(state.testing) return;
  var targets=visibleModels().map(function(m){return m.id;});
  if(!targets.length) return;
  state.testing=true;
  $("btnTestAll").disabled=true; $("btnStopTest").hidden=false; $("mBar").hidden=false;
  $("mBar").querySelector("i").style.width="0%";
  var i=0;
  function next(){
    if(!state.testing||i>=targets.length){
      state.testing=false; $("btnTestAll").disabled=false; $("btnStopTest").hidden=true;
      setTimeout(function(){ $("mBar").hidden=true; },900);
      return;
    }
    var id=targets[i++];
    testModel(id);
    // 等这个模型测完再做下一个（轮询 busy 标记）
    var waited=0;
    (function wait(){
      var mm=null;
      for(var k=0;k<state.models.length;k++) if(state.models[k].id===id){ mm=state.models[k]; break; }
      if((mm&&mm.test&&mm.test.busy)&&waited<45000){ waited+=250; setTimeout(wait,250); return; }
      $("mBar").querySelector("i").style.width=Math.round(i/targets.length*100)+"%";
      setTimeout(next,250);
    })();
  }
  next();
}

/* ══ 对话 ══ */
function renderThread(){
  var box=$("thread");
  if(!state.messages.length){ box.innerHTML='<div class="empty">还没有消息。在下面输入内容开始测试，多轮对话会自动带上上下文。</div>'; return; }
  box.innerHTML=state.messages.map(function(m){
    var cls=m.role==="user"?"me":(m.error?"err":"ai");
    var who=m.role==="user"?"我":(m.error?"!":"AI");
    var rz=m.reasoning?'<details class="rz"><summary>思考过程 · '+m.reasoning.length+' 字</summary><pre>'+esc(m.reasoning)+"</pre></details>":"";
    var st=(m.stats||[]).map(function(s){ return '<span class="'+(s.hi?"hi":s.lo?"lo":"")+'">'+esc(s.t)+"</span>"; }).join("");
    return '<div class="turn '+cls+'"><div class="who">'+who+'</div><div>'+
      '<div class="txt">'+esc(m.content||"")+"</div>"+rz+
      (st?'<div class="stats">'+st+"</div>":"")+"</div></div>";
  }).join("");
  box.scrollTop=box.scrollHeight;
}
function streamBubble(){
  var box=$("thread");
  var e=box.querySelector(".empty"); if(e) e.remove();
  var last=box.lastElementChild;
  if(last&&last.getAttribute("data-live")==="1") return {root:last,txt:last.querySelector(".txt"),rz:last.querySelector("details.rz")};
  var el=document.createElement("div");
  el.className="turn ai"; el.setAttribute("data-live","1");
  el.innerHTML='<div class="who">AI</div><div><div class="txt"></div>'+
    '<details class="rz" hidden><summary>思考过程</summary><pre></pre></details><div class="stats"></div></div>';
  box.appendChild(el);
  return {root:el,txt:el.querySelector(".txt"),rz:el.querySelector("details.rz")};
}
function renderChatStats(usage,ttft,genMs,totalMs,tps,tokens,finish){
  var items=[];
  items.push(["首字节",fmtMs(ttft)]);
  items.push(["生成耗时",fmtMs(genMs)]);
  items.push(["总耗时",fmtMs(totalMs)]);
  if(tps) items.push(["输出速度",fmtNum(tps,1)+" "+(tokens?"tok/s":"字/s")]);
  if(usage) items.push(["输入 token",String(usage.prompt_tokens||0)]);
  if(usage) items.push(["输出 token",String(usage.completion_tokens||0)]);
  if(finish) items.push(["结束原因",finish]);
  // 两列布局下若为奇数项，补一个占位格，避免最后一格露出灰底像缺失数据
  var html=items.map(function(it){ return cell(it[0],it[1],it[0]==="输出速度"||it[0]==="首字节"?"ok":""); }).join("");
  if(items.length%2===1) html+='<div style="background:var(--surface)"></div>';
  $("chatStats").innerHTML=html;
}
function send(){
  if(state.busy) return;
  var text=$("input").value.trim();
  if(!text) return;
  if(!state.key){
    var box=$("notes");
    box.innerHTML='<div class="note warn"><span class="grow">请先在「接入配置」填写 API Key。</span><button class="xs ghost" onclick="goConfig()">去填写</button></div>';
    box.style.pointerEvents="auto";
    return;
  }
  state.busy=true;
  $("btnSend").disabled=true; $("btnStop").hidden=false;
  $("cmeta").innerHTML='<span class="gen">生成中</span>';
  state.messages.push({role:"user",content:text});
  $("input").value=""; renderThread(); persistMsgs();

  var msgs=[];
  if(state.sys.trim()) msgs.push({role:"system",content:state.sys.trim()});
  for(var i=0;i<state.messages.length;i++){
    if(state.messages[i].error) continue;
    msgs.push({role:state.messages[i].role,content:state.messages[i].content});
  }
  var body={model:state.model,stream:state.stream,messages:msgs};
  var tv=parseFloat(state.temp), pv=parseFloat(state.topp);
  if(!isNaN(tv)) body.temperature=tv;
  if(!isNaN(pv)) body.top_p=pv;
  var reqBody=JSON.stringify(body,null,2);

  var ctrl=new AbortController(); state.abort=ctrl;
  var t0=performance.now(), ttft=null, raw="";
  var content="", reasoning="", usage=null, finish=null, chars=0;
  // 用显式标记判断是否走到"成功聚合"分支：早前用 btnSend.disabled 判断不可靠，
  // 因为该按钮只在最后一个 then 里才恢复，早期分支也会误判为成功。
  var okPath=false;

  fetch("/v1/chat/completions",{method:"POST",headers:authHeaders(),body:JSON.stringify(body),signal:ctrl.signal})
    .then(function(r){
      if(!r.ok){
        return r.text().then(function(et){
          var hint=explain(r.status,et);
          state.messages.push({role:"assistant",content:hint,error:true,stats:[{t:"HTTP "+r.status,lo:true}]});
          renderThread(); persistMsgs();
          $("cmeta").textContent="失败 · "+fmtMs(performance.now()-t0);
          addLog({kind:"chat",model:state.model,stream:state.stream,ok:false,status:r.status,totalMs:performance.now()-t0,
            error:"HTTP "+r.status+" "+et.slice(0,400),hint:hint,requestBody:reqBody,responseRaw:et.slice(0,6000)});
        });
      }
      okPath=true;
      if(!state.stream){
        return r.json().then(function(d){
          var mm=(d.choices&&d.choices[0]&&d.choices[0].message)||{};
          content=mm.content||""; reasoning=mm.reasoning||""; usage=d.usage||null;
          finish=d.choices&&d.choices[0]&&d.choices[0].finish_reason;
          chars=content.length; ttft=performance.now()-t0; raw=JSON.stringify(d,null,2);
        });
      }
      var reader=r.body.getReader(), dec=new TextDecoder(), buf="";
      var bub=streamBubble();
      function pump(){
        return reader.read().then(function(s){
          if(s.done) return null;
          if(ttft===null) ttft=performance.now()-t0;
          var chunk=dec.decode(s.value,{stream:true});
          raw+=chunk; buf+=chunk;
          if(bub.root.isConnected){ var tb=$("thread"); tb.scrollTop=tb.scrollHeight; }
          var ix;
          while((ix=buf.indexOf("\\n"))>=0){
            var line=buf.slice(0,ix); buf=buf.slice(ix+1);
            if(line.indexOf("data:")!==0) continue;
            var p=line.slice(5).trim();
            if(!p||p==="[DONE]") continue;
            try{
              var o=JSON.parse(p), c=o.choices&&o.choices[0], dl=(c&&c.delta)||{};
              if(dl.content){ content+=dl.content; chars+=dl.content.length; bub.txt.textContent=content; }
              if(dl.reasoning){
                reasoning+=dl.reasoning;
                bub.rz.hidden=false;
                bub.rz.querySelector("summary").textContent="思考过程 · "+reasoning.length+" 字（生成中）";
                bub.rz.querySelector("pre").textContent=reasoning;
              }
              if(o.usage) usage=o.usage;
              if(c&&c.finish_reason) finish=c.finish_reason;
            }catch(e){}
          }
          return pump();
        });
      }
      return pump().then(function(){ if(bub.root) bub.root.removeAttribute("data-live"); });
    })
    .then(function(){
      if(!okPath) return;   // 失败/异常分支已各自处理，不要重复写入
      var totalMs=performance.now()-t0;
      if(!content&&reasoning){ content=reasoning; reasoning=""; }
      var genMs=Math.max(totalMs-(ttft||0),1);
      var tokens=usage?usage.completion_tokens:null;
      var tps=tokens? tokens/(genMs/1000) : (chars? chars/(genMs/1000) : null);
      var stats=[];
      if(finish) stats.push({t:"finish="+finish});
      if(usage) stats.push({t:(usage.prompt_tokens||0)+"→"+(usage.completion_tokens||0)+" token"});
      stats.push({t:"首字节 "+fmtMs(ttft),hi:true});
      stats.push({t:"生成 "+fmtMs(genMs)});
      if(tps) stats.push({t:"≈"+fmtNum(tps,1)+(tokens?" tok/s":" 字/s"),hi:true});
      stats.push({t:"总计 "+fmtMs(totalMs)});
      state.messages.push({role:"assistant",content:content||"(空响应)",reasoning:reasoning,stats:stats});
      renderThread(); persistMsgs();
      $("cmeta").textContent="完成 · "+fmtMs(ttft)+" / "+fmtMs(totalMs);
      renderChatStats(usage,ttft,genMs,totalMs,tps,tokens,finish);
      addLog({kind:"chat",model:state.model,stream:state.stream,ok:true,status:200,ttft:ttft,totalMs:totalMs,genMs:genMs,
        promptTokens:usage?usage.prompt_tokens:null,completionTokens:usage?usage.completion_tokens:null,
        reasoningTokens:usage&&usage.completion_tokens_details?usage.completion_tokens_details.reasoning_tokens:null,
        totalTokens:usage?usage.total_tokens:null,chars:chars,reasonChars:reasoning.length,tps:tps,tpsBasis:tokens?"token":"chars",
        finishReason:finish,turns:msgs.length,requestBody:reqBody,responseRaw:raw.slice(0,20000)});
    })
    .catch(function(e){
      var stopped=String(e&&e.name)==="AbortError";
      state.messages.push({role:"assistant",content:stopped?(content||"(已停止)"):("请求异常："+String(e&&e.message||e)),
        reasoning:reasoning,error:!stopped,stats:[{t:stopped?"已手动停止":"异常",lo:true},{t:"已接收 "+chars+" 字"}]});
      renderThread(); persistMsgs();
      $("cmeta").textContent=stopped?"已停止":"异常";
      addLog({kind:"chat",model:state.model,stream:state.stream,ok:false,status:null,ttft:ttft,totalMs:performance.now()-t0,chars:chars,stopped:stopped,
        error:stopped?null:String(e&&e.message||e),hint:stopped?"你手动停止了生成，已收到的内容仍保留。":"请求异常，确认服务是否在运行。",
        requestBody:reqBody,responseRaw:raw.slice(0,6000)});
    })
    .then(function(){
      state.busy=false; state.abort=null;
      $("btnSend").disabled=false; $("btnStop").hidden=true;
      var live=$("thread").querySelector('[data-live="1"]');
      if(live) live.removeAttribute("data-live");
    });
}
function stopGen(){
  if(state.abort){ try{state.abort.abort();}catch(e){} }
  state.testing=false;
}
function persistMsgs(){
  save(LS.msgs,state.messages.slice(-40).map(function(m){
    return {role:m.role,content:m.content,reasoning:m.reasoning||"",stats:m.stats||[],error:!!m.error};
  }));
}
function exportThread(){
  if(!state.messages.length) return;
  var md="# cline-free 对话记录\\n\\n模型："+state.model+"\\n\\n";
  state.messages.forEach(function(m){
    md+="## "+(m.role==="user"?"用户":"助手")+"\\n\\n"+(m.content||"")+"\\n\\n";
    if(m.reasoning) md+="> 思考过程："+m.reasoning.replace(/\\n/g," ")+"\\n\\n";
  });
  var holder=$("snip"); if(holder) holder.textContent=md;
  copyText(md,$("btnExport"),holder);
}

/* ══ 代码片段 ══ */
var SNIPS=[{id:"curl",l:"cURL"},{id:"python",l:"Python"},{id:"node",l:"Node"},{id:"anthropic",l:"Anthropic"},{id:"env",l:"环境变量"}];
function snipText(id){
  var base=baseUrl(), key=state.key||"你的API_KEY", model=state.model||"模型ID";
  var ua="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  if(id==="curl"){
    return "curl "+base+"/chat/completions \\\\\\n"+
      '  -H "Authorization: Bearer '+key+'" \\\\\\n'+
      '  -H "Content-Type: application/json" \\\\\\n'+
      '  -H "User-Agent: '+ua+'" \\\\\\n'+
      "  -d '{\\n"+'    "model": "'+model+'",\\n'+'    "messages": [{"role": "user", "content": "你好"}],\\n'+'    "stream": true\\n'+"  }'";
  }
  if(id==="python"){
    return "from openai import OpenAI\\n\\nclient = OpenAI(\\n"+'    base_url="'+base+'",\\n'+'    api_key="'+key+'",\\n'+")\\n\\n"+
      "resp = client.chat.completions.create(\\n"+'    model="'+model+'",\\n'+'    messages=[{"role": "user", "content": "你好"}],\\n'+")\\n"+
      "print(resp.choices[0].message.content)\\n\\n# 流式\\n"+
      "stream = client.chat.completions.create(\\n"+'    model="'+model+'",\\n'+'    messages=[{"role": "user", "content": "你好"}],\\n'+"    stream=True,\\n)\\n"+
      "for chunk in stream:\\n    d = chunk.choices[0].delta.content\\n    if d:\\n"+'        print(d, end="", flush=True)';
  }
  if(id==="node"){
    return 'import OpenAI from "openai";\\n\\nconst client = new OpenAI({\\n  baseURL: "'+base+'",\\n  apiKey: "'+key+'",\\n});\\n\\n'+
      "const stream = await client.chat.completions.create({\\n"+'  model: "'+model+'",\\n  messages: [{ role: "user", content: "你好" }],\\n  stream: true,\\n});\\n\\n'+
      "for await (const chunk of stream) {\\n"+'  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");\\n}';
  }
  if(id==="anthropic"){
    return "from anthropic import Anthropic\\n\\n# 本服务同时实现 Anthropic 协议：/v1/messages\\nclient = Anthropic(\\n"+
      '    base_url="'+base+'",\\n    api_key="'+key+'",\\n)\\n\\nmsg = client.messages.create(\\n'+
      '    model="'+model+'",\\n    max_tokens=1024,\\n    messages=[{"role": "user", "content": "你好"}],\\n)\\nprint(msg.content[0].text)';
  }
  return "# 通用 OpenAI 兼容变量，多数工具与 SDK 都认\\nOPENAI_BASE_URL="+base+"\\nOPENAI_API_KEY="+key+
    "\\n\\n# 部分工具用这个名字\\nOPENAI_API_BASE="+base+"\\n\\n# Anthropic 兼容客户端\\nANTHROPIC_BASE_URL="+base+"\\nANTHROPIC_API_KEY="+key;
}
function renderSnip(){
  $("snipTabs").innerHTML=SNIPS.map(function(s){
    return '<button class="'+(s.id===state.snip?"on":"")+'" data-snip="'+s.id+'">'+esc(s.l)+"</button>";
  }).join("");
  $("snip").textContent=snipText(state.snip);
  $("snipNote").textContent=state.key?"":"填入 API Key 后会自动更新";
  $("baseurl").value=baseUrl();
  $("curmodel").value=state.model||"";
}

/* ══ 日志（固定窗口 + 滚动） ══ */
function addLog(e){
  e.id="l"+Date.now()+Math.random().toString(36).slice(2,7);
  e.ts=Date.now(); e.time=fmtClock(e.ts);
  state.logs.unshift(e);
  if(state.logs.length>60) state.logs.length=60;
  save(LS.logs,state.logs.slice(0,30));
  renderLogs();
}
function logMatches(e){
  if(state.filter==="ok"&&!e.ok) return false;
  if(state.filter==="fail"&&e.ok) return false;
  if(state.filter==="slow"&&!((e.ttft&&e.ttft>8000)||(e.totalMs&&e.totalMs>20000))) return false;
  if(state.search&&String(e.model||"").toLowerCase().indexOf(state.search)<0) return false;
  return true;
}
function renderLogs(){
  var okN=0,failN=0,slowN=0;
  for(var i=0;i<state.logs.length;i++){
    var e=state.logs[i];
    if(e.ok) okN++; else failN++;
    if((e.ttft&&e.ttft>8000)||(e.totalMs&&e.totalMs>20000)) slowN++;
  }
  $("cAll").textContent=String(state.logs.length);
  $("cOk").textContent=String(okN);
  $("cFail").textContent=String(failN);
  $("cSlow").textContent=String(slowN);
  $("cnt-log").textContent=state.logs.length?String(state.logs.length):"";
  $("logNote").textContent="最近 "+state.logs.length+" 条";

  var list=state.logs.filter(logMatches);
  var win=$("logwin");
  if(!list.length){
    win.innerHTML='<div class="empty">'+(state.logs.length?"没有符合筛选的条目。":"还没有请求记录。去「对话测试」或「模型」页发一次请求就会出现在这里。")+"</div>";
    renderLogDetail();
    return;
  }
  win.innerHTML=list.map(function(e){
    var st=e.ok?'<span class="st ok">成功</span>':(e.stopped?'<span class="st stop">已停止</span>':'<span class="st bad">失败'+(e.status?" "+e.status:"")+"</span>");
    var sp=typeof e.tps==="number"&&isFinite(e.tps)&&e.tps>0?fmtNum(e.tps,1):"-";
    return '<div class="ln'+(e.id===state.selId?" sel":"")+'" data-log="'+e.id+'">'+
      '<span class="t">'+esc(e.time)+'</span>'+
      '<span class="md" title="'+esc(e.model)+'">'+esc(e.model||"-")+"</span>"+
      st+
      '<span class="n opt">'+(e.ttft?fmtMs(e.ttft):"-")+"</span>"+
      '<span class="n opt'+(sp!=="-"?" hi":"")+'">'+esc(sp)+"</span>"+
      '<span class="n">'+(e.totalMs?fmtMs(e.totalMs):"-")+"</span>"+
    "</div>";
  }).join("");
  renderLogDetail();
  if(state.follow) win.scrollTop=0;   // 最新的在最上面
}
function renderLogDetail(){
  var d=$("logDetail");
  if(!state.selId){ d.innerHTML='<div class="empty">点击左侧任意一行查看完整指标与原始报文。</div>'; return; }
  var e=null;
  for(var i=0;i<state.logs.length;i++) if(state.logs[i].id===state.selId){ e=state.logs[i]; break; }
  if(!e){ d.innerHTML='<div class="empty">该条目已被清理。</div>'; return; }
  d.innerHTML=entryBody(e);
}
function entryBody(e){
  var ms=[];
  function add(k,v){ if(v!==null&&v!==undefined&&v!=="-") ms.push('<div><div class="k">'+esc(k)+'</div><div class="v">'+esc(v)+"</div></div>"); }
  add("类型",e.kind==="test"?"模型测速":e.kind==="chat"?"对话":e.kind);
  add("模式",e.stream?"流式":"非流式");
  add("状态",e.ok?"成功":(e.stopped?"已停止":"失败")+(e.status?" "+e.status:""));
  add("首字节",e.ttft?fmtMs(e.ttft):null);
  add("生成耗时",e.genMs?fmtMs(e.genMs):null);
  add("总耗时",e.totalMs?fmtMs(e.totalMs):null);
  add("输出速度",typeof e.tps==="number"&&e.tps>0?fmtNum(e.tps,1)+" "+(e.tpsBasis==="token"?"tok/s":"字/s"):null);
  add("输入 token",e.promptTokens); add("输出 token",e.completionTokens);
  add("思考 token",e.reasoningTokens); add("token 合计",e.totalTokens);
  add("输出字符",e.chars); add("结束原因",e.finishReason); add("时间",e.time);
  var h='<div class="metrics">'+ms.join("")+"</div>";
  if(e.note) h+='<div style="font-size:10.5px;color:var(--ink-3)">'+esc(e.note)+"</div>";
  if(e.error) h+='<div class="err"><b>错误：</b>'+esc(e.error)+"</div>";
  if(e.hint) h+='<div class="hint"><b>建议：</b>'+esc(e.hint)+"</div>";
  if(e.requestBody) h+='<div><h4>请求体<span class="grow"></span><button class="xs ghost" data-copytxt="'+e.id+'|req">复制</button></h4><pre>'+esc(e.requestBody)+"</pre></div>";
  if(e.responseRaw) h+='<div><h4>原始响应'+(e.responseRaw.length>=20000?"（截断）":"")+'<span class="grow"></span><button class="xs ghost" data-copytxt="'+e.id+'|res">复制</button></h4><pre>'+esc(e.responseRaw)+"</pre></div>";
  return h;
}
function exportLogs(){
  var list=state.logs.filter(logMatches).map(function(e){
    return {time:new Date(e.ts).toISOString(),kind:e.kind,model:e.model,stream:!!e.stream,ok:!!e.ok,status:e.status||null,stopped:!!e.stopped,
      ttft_ms:e.ttft||null,gen_ms:e.genMs||null,total_ms:e.totalMs||null,
      tps:typeof e.tps==="number"?Number(e.tps.toFixed(2)):null,tps_basis:e.tpsBasis||null,
      prompt_tokens:e.promptTokens||null,completion_tokens:e.completionTokens||null,total_tokens:e.totalTokens||null,
      chars:e.chars||null,finish_reason:e.finishReason||null,error:e.error||null};
  });
  var txt=JSON.stringify(list,null,2);
  var holder=$("snip"); if(holder) holder.textContent=txt;
  copyText(txt,$("btnExportLogs"),holder);
}

/* ══ 主题 ══ */
function applyTheme(t){
  document.documentElement.setAttribute("data-theme",t);
  save(LS.theme,t);
}
function cycleTheme(){
  var cur=document.documentElement.getAttribute("data-theme")||"dark";
  applyTheme(cur==="dark"?"light":"dark");
}

/* ══ 事件绑定 ══ */
$("nav").addEventListener("click",function(e){
  var a=e.target.closest&&e.target.closest("a[data-v]");
  if(a) showTab(a.getAttribute("data-v"));
});
$("btnTheme").addEventListener("click",cycleTheme);
$("btnRefresh").addEventListener("click",function(){ loadHealth(); loadModels(); });
$("snipTabs").addEventListener("click",function(e){
  var b=e.target.closest&&e.target.closest("button[data-snip]");
  if(b){ state.snip=b.getAttribute("data-snip"); renderSnip(); }
});
document.addEventListener("click",function(e){
  var el=e.target.closest?e.target.closest("[data-copy],[data-copyid],[data-copytxt]"):null;
  if(!el) return;
  var id=el.getAttribute("data-copy");
  if(id){ var f=$(id); copyText(f?f.value:"",el,f); return; }
  var cid=el.getAttribute("data-copyid");
  if(cid){ copyText(cid,el); return; }
  var ct=el.getAttribute("data-copytxt");
  if(ct){
    var parts=ct.split("|"),en=null;
    for(var i=0;i<state.logs.length;i++) if(state.logs[i].id===parts[0]){ en=state.logs[i]; break; }
    if(en){
      var t=parts[1]==="req"?en.requestBody:en.responseRaw;
      var pre=el.closest("div").querySelector("pre");
      copyText(t||"",el,pre);
    }
  }
});
$("logwin").addEventListener("click",function(e){
  var ln=e.target.closest&&e.target.closest("[data-log]");
  if(!ln) return;
  state.selId=ln.getAttribute("data-log");
  save(LS.sel,state.selId);
  var all=$("logwin").querySelectorAll(".ln");
  for(var i=0;i<all.length;i++) all[i].classList.toggle("sel",all[i]===ln);
  renderLogDetail();
});
$("btnFollow").addEventListener("click",function(){
  state.follow=!state.follow;
  save(LS.follow,state.follow);
  $("btnFollow").textContent="跟随最新："+(state.follow?"开":"关");
  $("btnFollow").classList.toggle("on",state.follow);
});
$("lfilter").addEventListener("input",function(){ state.search=this.value.trim().toLowerCase(); renderLogs(); });
document.querySelectorAll(".chip").forEach(function(c){
  c.addEventListener("click",function(){
    state.filter=c.getAttribute("data-f");
    save(LS.filter,state.filter);
    document.querySelectorAll(".chip").forEach(function(x){ x.classList.toggle("on",x===c); });
    renderLogs();
  });
});
$("btnClearLogs").addEventListener("click",function(){ state.logs=[]; state.selId=null; save(LS.logs,[]); renderLogs(); });
$("btnExportLogs").addEventListener("click",exportLogs);
$("mRows").addEventListener("click",function(e){
  var t=e.target.closest&&e.target.closest("[data-test]");
  if(t){ testModel(t.getAttribute("data-test")); return; }
  var u=e.target.closest&&e.target.closest("[data-use]");
  if(u){
    state.model=u.getAttribute("data-use"); $("model").value=state.model; save(LS.model,state.model);
    renderSnip(); showTab("chat");
  }
});
document.querySelectorAll("table.m th.sort").forEach(function(th){
  th.addEventListener("click",function(){
    var k=th.getAttribute("data-s");
    if(state.sort===k) state.sortDir=-state.sortDir;
    else { state.sort=k; state.sortDir=1; }
    document.querySelectorAll("table.m th.sort .ar").forEach(function(a){ a.remove(); });
    var ar=document.createElement("span"); ar.className="ar"; ar.textContent=state.sortDir>0?"↑":"↓";
    th.appendChild(ar);
    save(LS.sort,{key:state.sort,dir:state.sortDir});
    renderMRows();
  });
});
$("mfilter").addEventListener("input",function(){ renderMRows(); });
$("mfree").addEventListener("change",function(){ save(LS.freeOnly,this.checked); renderMRows(); renderMStats(); });
$("mcn").addEventListener("change",function(){ renderMRows(); });
$("btnReloadModels").addEventListener("click",function(){ loadModels(); });
$("btnTestAll").addEventListener("click",testAll);
$("btnStopTest").addEventListener("click",function(){ state.testing=false; });
$("btnRefreshAcct").addEventListener("click",function(){ loadHealth(); });
$("btnLogin").addEventListener("click",startLogin);
$("btnLoginCancel").addEventListener("click",cancelLogin);
$("btnSend").addEventListener("click",send);
$("btnStop").addEventListener("click",stopGen);
$("input").addEventListener("keydown",function(e){
  if(e.key==="Enter"&&!e.shiftKey){ e.preventDefault(); send(); }
});
$("btnClearMsgs").addEventListener("click",function(){ if(!state.messages.length) return; state.messages=[]; $("chatStats").innerHTML=""; renderThread(); persistMsgs(); });
$("btnExport").addEventListener("click",exportThread);
$("btnCopySnip").addEventListener("click",function(){ copyText(snipText(state.snip),$("btnCopySnip"),$("snip")); });
$("model").addEventListener("change",function(){ state.model=this.value; save(LS.model,state.model); renderSnip(); });
$("stream").addEventListener("change",function(){ state.stream=this.checked; saveParams(); });
$("temp").addEventListener("input",function(){ state.temp=this.value; saveParams(); });
$("topp").addEventListener("input",function(){ state.topp=this.value; saveParams(); });
$("sys").addEventListener("input",function(){ state.sys=this.value; saveParams(); });
function saveParams(){ save(LS.params,{stream:state.stream,temp:state.temp,topp:state.topp,sys:state.sys}); }
$("key").addEventListener("input",function(){
  state.key=this.value.trim(); save(LS.key,state.key); renderSnip();
  if(state.health&&state.health.api_key_configured) renderHealth(state.health);
});
window.addEventListener("beforeunload",function(){ clearTimeout(state.loginTimer); });

/* ══ 启动 ══ */
(function boot(){
  var injected="";
  try{ injected=(window.__CLINE2API__&&window.__CLINE2API__.key)||""; }catch(e){}
  state.key=injected||load(LS.key,"")||"";
  state.model=load(LS.model,"");
  var p=load(LS.params,null);
  if(p&&typeof p==="object"){
    if("stream" in p) state.stream=!!p.stream;
    state.temp=p.temp||""; state.topp=p.topp||""; state.sys=p.sys||"";
  }
  var msgs=load(LS.msgs,[]); if(Array.isArray(msgs)) state.messages=msgs;
  var logs=load(LS.logs,[]); if(Array.isArray(logs)) state.logs=logs;
  state.filter=load(LS.filter,"all")||"all";
  state.selId=load(LS.sel,null);
  var f=load(LS.follow,true); state.follow=(f===false||f==="false")?false:true;
  var srt=load(LS.sort,null);
  if(srt&&srt.key){ state.sort=srt.key; state.sortDir=srt.dir; }

  applyTheme(load(LS.theme,"dark")||"dark");
  $("key").value=state.key;
  $("stream").checked=state.stream;
  $("temp").value=state.temp; $("topp").value=state.topp; $("sys").value=state.sys;
  $("btnFollow").textContent="跟随最新："+(state.follow?"开":"关");
  $("btnFollow").classList.toggle("on",state.follow);
  // 恢复「只看免费」的勾选状态（默认开）。
  // 正常情况下服务端已只返回免费模型，这个筛选几乎不减少条数；保留它是因为
  // 上游拉取失败时会回退到内置列表（含 cline-pass 等非免费项），那时它才有区分作用。
  var fo=load(LS.freeOnly,true);
  $("mfree").checked = !(fo===false||fo==="false");
  document.querySelectorAll(".chip").forEach(function(x){ x.classList.toggle("on",x.getAttribute("data-f")===state.filter); });
  if(state.sort!=="region"){
    var th=document.querySelector('table.m th[data-s="'+state.sort+'"]');
    if(th){ var ar=document.createElement("span"); ar.className="ar"; ar.textContent=state.sortDir>0?"↑":"↓"; th.appendChild(ar); }
  }
  showTab(load(LS.tab,"chat")||"chat");
  renderThread(); renderSnip(); renderLogs(); renderChatStats(null,null,null,null,null,null,null);
  loadHealth();
  loadModels();
  setInterval(loadHealth,30000);
})();
</script>
</body>
</html>
`;
// #endregion console-html

function jsonResponse(obj, status, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(), ...extraHeaders },
  });
}

// 统一把内部异常转成对客户端有意义的响应
// 重点：所有账号都在冷却（额度用尽）时返回 429 + Retry-After，
//       而不是 500 —— 这是"等一会儿再来"的语义，客户端/网关可据此退避。
function errorResponse(e) {
  if (e && e.message === "all_accounts_cooling") {
    const secs = Math.ceil((e.retryAfterMs || 0) / 1000);
    const mins = Math.floor(secs / 60);
    const human = mins >= 60
      ? `${Math.floor(mins / 60)}h ${mins % 60}m`
      : mins >= 1 ? `${mins}m` : `${secs}s`;
    return jsonResponse({
      error: {
        message: `所有账号（${e.accountCount} 个）的免费额度均在冷却中，约 ${human} 后恢复。` +
                 `可等待冷却结束，或在 CLINE_REFRESH_TOKEN 中追加更多账号。`,
        type: "rate_limit_error",
        reason: "all_accounts_cooling",
        retry_after_seconds: secs,
      },
    }, 429, { "Retry-After": String(secs) });
  }
  if (e && e.message === "缺少 CLINE_REFRESH_TOKEN 环境变量") {
    return jsonResponse({
      error: {
        message: "服务端未配置 CLINE_REFRESH_TOKEN。请运行 python cline_oauth.py 获取 refreshToken，"
               + "再配置为环境变量（wrangler secret put / vercel env add），保存后重新部署。",
        type: "config_error",
        reason: "missing_refresh_token",
      },
    }, 500);
  }
  return jsonResponse({ error: { message: (e && e.message) || String(e), type: "api_error" } }, 500);
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta",
  };
}

