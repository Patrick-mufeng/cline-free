/**
 * 自检脚本：不需要真实 Cline 账号，用本地假上游验证 worker.js 的关键行为。
 *
 * 用法：node selftest.mjs
 *
 * 覆盖：
 *   1. 路由（/ 控制台、/v1/health、404 提示）
 *   2. 鉴权 fail-closed（未配 API_KEY 拒绝 / 配了则校验）
 *   3. 流式响应不被缓冲（TTFT 远小于总耗时）
 *   4. 账号池不因 token 轮换而重建（缓存与冷却保留）
 *   5. 429 时按账号冷却切号（不空转重试同一个号）
 *   6. 多账号 round-robin
 *   7. Anthropic 流式协议事件完整（message_start / content_block_* / message_stop）
 *   8. 请求体剥离 max_tokens
 */
import { createServer } from "node:http";

// ---------- 假上游 ----------
let upstreamCalls = [];
let refreshCalls = [];
let mode = { kind: "ok" };

function setMode(next) {
  mode = next;
  upstreamCalls = [];
  refreshCalls = [];
}

const upstream = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const bodyText = Buffer.concat(chunks).toString("utf8");

  if (req.url.includes("/auth/refresh")) {
    const n = refreshCalls.length + 1;
    refreshCalls.push(JSON.parse(bodyText || "{}"));
    // 模拟 Cline 会轮换 refreshToken
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      data: {
        accessToken: "ACCESS_" + n,
        refreshToken: "ROTATED_" + n,
        expiresAt: Date.now() + 600000,
      },
    }));
    return;
  }

  // recommended-models：官方四个分类数组，是权威的渠道来源
  if (req.url.includes("recommended-models")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      recommended: [{ id: "openai/gpt-6-astra", name: "gpt-6-astra" }],
      free: [{ id: "z-ai/glm-5.3-flash", name: "glm-5.3-flash" },
             { id: "cline-free/deepseek-v4.1-flash", name: "Deepseek-v4.1-Flash" },
             // 只存在于 free 数组、不在 /v1/models 里的官方免费通道 →
             // 必须被补进模型池（现实里 cline-free/* 就是这样，且它是默认模型所在）
             { id: "cline-free/muse-spark-1.3-contributor", name: "Muse-Spark-1.3" }],
      clinePass: [{ id: "cline-pass/glm-5.2" }],
      clineCloud: [{ id: "cline-cloud/kimi-k3" }],
    }));
    return;
  }

  if (req.url.includes("/models")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    // 故意混合几类，逐条验证白名单语义下谁进谁出：
    //   放行 = 带 :free 后缀的，或 FREE_WHITELIST 里的
    //   丢弃 = 其余全部（哪怕官方分类把它归在 recommended 里）
    res.end(JSON.stringify({
      data: [
        { id: "cline-free/deepseek-v4.1-flash" },  // 白名单 + 官方 free 分类 → 免费
        { id: "z-ai/glm-5.3-flash" },              // 白名单 + 官方 free 分类 → 免费
        { id: "deepseek/deepseek-v4-flash" },      // 白名单，但官方无分类 → 实测免费
        { id: "nvidia/nemotron-3-super-120b-a12b:free" }, // :free 后缀 → 免费
        { id: "openai/gpt-6-astra" },              // 官方 recommended 但不在白名单 → 丢弃
        { id: "cline-pass/glm-5.2" },              // 需订阅 → 丢弃
        { id: "unknown-vendor/mystery-model" },    // 无任何信息 → 丢弃
        { id: "poolside/laguna-s-2.1:free:batch" },// :batch 通道 → 即便带 :free 也排除
        { id: "~deepseek/deepseek-v4-flash-0731" }, // ~ 别名，去波浪号后命中白名单 → 保留
        { id: "~openai/gpt-latest" },              // ~ 别名，去波浪号后不在白名单 → 丢弃
      ],
    }));
    return;
  }

  // chat/completions
  upstreamCalls.push({ body: JSON.parse(bodyText || "{}"), auth: req.headers.authorization });

  if (mode.kind === "429") {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Daily free limit reached. Try again in 10m" } }));
    return;
  }

  // 正常：模拟流式，分块输出，每块之间有明显延迟
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const parts = ["你", "好", "，", "世", "界"];
  for (let i = 0; i < parts.length; i++) {
    const chunk = {
      data: {
        id: "gen_test",
        model: "cline-free/deepseek-v4.1-flash",
        choices: [{ index: 0, delta: { content: parts[i] }, finish_reason: null }],
      },
    };
    res.write("data: " + JSON.stringify(chunk) + "\n\n");
    await new Promise((r) => setTimeout(r, 250)); // 每块 250ms，共约 1.25s
  }
  res.write("data: " + JSON.stringify({
    data: {
      id: "gen_test",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 5 },
    },
  }) + "\n\n");
  res.write("data: [DONE]\n\n");
  res.end();
});

await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const upstreamPort = upstream.address().port;
const UPSTREAM = "http://127.0.0.1:" + upstreamPort;

// ---------- 注入假上游地址到 worker ----------
const workerSrc = (await import("node:fs")).readFileSync(new URL("./worker.js", import.meta.url), "utf8")
  .replace('const CLINE_API_BASE = "https://api.cline.bot/api/v1";', 'const CLINE_API_BASE = "' + UPSTREAM + '/api/v1";');

const { writeFileSync, mkdtempSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const dir = mkdtempSync(join(tmpdir(), "cline2api-test-"));
const tmpWorker = join(dir, "worker-under-test.mjs");
writeFileSync(tmpWorker, workerSrc, "utf8");

const worker = (await import("file://" + tmpWorker.replace(/\\/g, "/"))).default;

// ---------- 测试工具 ----------
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (detail ? "\n      → " + detail : "")); }
}

const ENV = { API_KEY: "sk-test", CLINE_REFRESH_TOKEN: "TOKEN_A_aaaaaaaaaa\nTOKEN_B_bbbbbbbbbb" };
function req(path, init) {
  return worker.fetch(new Request("https://x.dev" + path, init), ENV);
}
const post = (path, body, headers = {}) =>
  req(path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const AUTH = { Authorization: "Bearer sk-test" };

// =====================================================================
console.log("\n【1】路由");
{
  const r = await req("/");
  const html = await r.text();
  check("GET / 返回控制台 HTML", r.status === 200 && html.includes("<title>cline-free · 控制台</title>"));
  check("控制台含首字节延迟（TTFT）显示逻辑",
    html.includes("首字节") && html.includes("fmtMs"),
    "页面应展示首字节延迟，帮助判断流式是否正常");

  const h = await (await req("/v1/health")).json();
  check("GET /v1/health 200 且 ok", h.ok === true);
  check("health 含 README 字段 api_key_configured", h.api_key_configured === true);
  check("health 含 README 字段 account_count", h.account_count === 2, "实际: " + h.account_count);
  check("health 保留旧字段 authenticated/accounts", h.authenticated === true && h.accounts === 2);
  check("health 含 accounts_available", h.accounts_available === 2);

  const nf = await req("/nope");
  const nfBody = await nf.json();
  check("未知路径 404 且给出可用端点提示",
    nf.status === 404 && nfBody.error.message.includes("/v1/chat/completions"),
    "message=" + nfBody.error.message.slice(0, 80));

  const opt = await req("/v1/chat/completions", { method: "OPTIONS" });
  check("OPTIONS 预检 204", opt.status === 204);
}

// =====================================================================
console.log("\n【2】鉴权 fail-closed");
{
  const noKeyEnv = { CLINE_REFRESH_TOKEN: "TOKEN_A_aaaaaaaaaa" };
  const r1 = await worker.fetch(new Request("https://x.dev/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [] }),
  }), noKeyEnv);
  const b1 = await r1.json();
  check("未配 API_KEY 时拒绝聊天（不再回退公开默认 key）", r1.status === 401);
  check("拒绝原因明确指向未配置 API_KEY",
    b1.error.reason === "server_no_key" && b1.error.message.includes("未配置 API_KEY"),
    "reason=" + b1.error.reason);

  // 公开默认 key 必须无效
  const r2 = await post("/v1/chat/completions", { messages: [] }, { Authorization: "Bearer cline2api-default-key" });
  check("公开默认 key cline2api-default-key 无效", r2.status === 401);

  const r3 = await post("/v1/chat/completions", { messages: [] });
  const b3 = await r3.json();
  check("缺客户端 key → 401 且提示如何传递", r3.status === 401 && b3.error.reason === "missing_client_key");

  const r4 = await post("/v1/chat/completions", { messages: [] }, { Authorization: "Bearer wrong" });
  const b4 = await r4.json();
  check("错误 key → 401 wrong_client_key", r4.status === 401 && b4.error.reason === "wrong_client_key");

  const r5 = await post("/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] }, AUTH);
  check("正确 key → 放行", r5.status === 200, "status=" + r5.status);
}

// =====================================================================
console.log("\n【3】流式不被缓冲（TTFT）");
{
  setMode({ kind: "ok" });
  const t0 = Date.now();
  const r = await post("/v1/chat/completions",
    { model: "cline-free/deepseek-v4.1-flash", stream: true, messages: [{ role: "user", content: "hi" }] }, AUTH);
  const reader = r.body.getReader();
  let ttft = null, text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (ttft === null) ttft = Date.now() - t0;
    text += new TextDecoder().decode(value, { stream: true });
  }
  const total = Date.now() - t0;
  check("流式返回。" + (ttft !== null ? "TTFT=" + ttft + "ms / 总=" + total + "ms" : ""),
    ttft !== null && ttft < total * 0.6,
    "TTFT 应远小于总耗时，否则说明被缓冲");
  // 内容分散在多个 delta 块里，需按块累加后再比对
  const rebuilt = [...text.matchAll(/"content":"([^"]*)"/g)].map((m) => m[1]).join("");
  check("SSE 内容完整（累加各 delta）", rebuilt === "你好，世界", "累加得到: " + rebuilt);
  check("SSE 以 [DONE] 结束", text.includes("data: [DONE]"));
  check("SSE 已剥离上游 data 包装", !text.includes('"data":{"id"') && text.includes('"id":"gen_test"'));
}

// =====================================================================
console.log("\n【4】账号池缓存与冷却保留（不再每次重建）");
{
  // 用独立的账号池，避免前面小节已缓存 token 影响统计
  const env4 = { API_KEY: "sk-test", CLINE_REFRESH_TOKEN: "TOKEN_E_eeeeeeeeee\nTOKEN_F_ffffffffff" };
  setMode({ kind: "ok" });
  const N = 6;
  for (let i = 0; i < N; i++) {
    await worker.fetch(new Request("https://x.dev/v1/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json", ...AUTH },
      body: JSON.stringify({ model: "cline-free/deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }] }),
    }), env4);
  }
  check(N + " 次请求全部到达上游", upstreamCalls.length === N, "upstream=" + upstreamCalls.length);
  // 2 个账号，round-robin 各刷一次 token 后就该全部命中缓存。
  // 旧实现（每次请求重建账号池）会刷新 N 次 —— 这是本项的核心回归点。
  check("token 缓存生效：只刷新 2 次（= 账号数），而非 " + N + " 次",
    refreshCalls.length === 2,
    "实际刷新 " + refreshCalls.length + " 次" +
    (refreshCalls.length === N ? "（等于请求数 → 账号池被反复重建，回归！）" : ""));
}

// =====================================================================
console.log("\n【5】429 限流：冷却切号、不空转");
{
  const env5 = { API_KEY: "sk-test", CLINE_REFRESH_TOKEN: "TOKEN_G_gggggggggg\nTOKEN_H_hhhhhhhhhh" };
  const chat5 = () => worker.fetch(new Request("https://x.dev/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json", ...AUTH },
    body: JSON.stringify({ model: "cline-free/deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }] }),
  }), env5);

  setMode({ kind: "429" });
  const r = await chat5();
  await r.text();
  // 两个账号都会被限流 → 应各试一次（2 次），而不是同一个号重试 5 次
  check("两账号各试一次（不拿同一号空转重试）",
    upstreamCalls.length === 2, "上游被调用: " + upstreamCalls.length + " 次");

  const h = await (await worker.fetch(new Request("https://x.dev/v1/health"), env5)).json();
  check("health 显示两账号均冷却（accounts_available=0）",
    h.accounts_available === 0, "accounts_available=" + h.accounts_available);

  // 冷却期内再请求：应直接返回 429 + Retry-After，不再打上游
  const before = upstreamCalls.length;
  const r2 = await chat5();
  const b2 = await r2.json();
  check("冷却期内不重复打上游（冷却状态被保留）",
    upstreamCalls.length === before,
    "冷却期又打了 " + (upstreamCalls.length - before) + " 次上游");
  check("全冷却时返回 429 + rate_limit_error（而非 500）",
    r2.status === 429 && b2.error.reason === "all_accounts_cooling",
    "status=" + r2.status + " reason=" + (b2.error && b2.error.reason));
  check("带 Retry-After 头供客户端退避", !!r2.headers.get("Retry-After"),
    "Retry-After=" + r2.headers.get("Retry-After"));
}

// =====================================================================
console.log("\n【6】多账号 round-robin");
{
  setMode({ kind: "ok" });
  // 等冷却过期：直接重读 env 无法清冷却，这里用新 env 对象触发重建
  const freshEnv = { API_KEY: "sk-test", CLINE_REFRESH_TOKEN: "TOKEN_C_cccccccccc\nTOKEN_D_dddddddddd" };
  const seen = new Set();
  for (let i = 0; i < 2; i++) {
    await worker.fetch(new Request("https://x.dev/v1/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json", ...AUTH },
      body: JSON.stringify({ model: "cline-free/deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }] }),
    }), freshEnv);
  }
  for (const c of upstreamCalls) seen.add(c.auth);
  check("两次请求使用了不同账号（轮询生效）", seen.size === 2, "用到的账号: " + [...seen].join(" | "));
}

// =====================================================================
console.log("\n【7】Anthropic 流式协议完整性");
{
  setMode({ kind: "ok" });
  const r = await post("/v1/messages",
    { model: "cline-free/deepseek-v4.1-flash", stream: true, messages: [{ role: "user", content: "hi" }] }, AUTH);
  const text = await r.text();
  const need = ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"];
  const missing = need.filter((e) => !text.includes("event: " + e));
  check("包含全部必需事件: " + need.join(" → "), missing.length === 0, "缺失: " + missing.join(", "));
  const order = need.map((e) => text.indexOf("event: " + e));
  check("事件顺序正确", order.every((v, i) => i === 0 || v > order[i - 1]));
  check("message_start 是首个事件", text.trimStart().startsWith("event: message_start"));
  // Anthropic 侧同样按 delta 块累加
  const aText = [...text.matchAll(/"type":"text_delta","text":"([^"]*)"/g)].map((m) => m[1]).join("");
  check("文本内容正确透出（累加 text_delta）", aText === "你好，世界", "累加得到: " + aText);
  check("stop_reason 为 end_turn", text.includes('"stop_reason":"end_turn"'));

  // 非流式 Anthropic
  setMode({ kind: "ok" });
  const rr = await post("/v1/messages",
    { model: "cline-free/deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }] }, AUTH);
  const j = await rr.json();
  check("非流式 Anthropic 返回 text 块",
    j.type === "message" && j.content[0].type === "text" && j.content[0].text.includes("你好，世界"));
  check("非流式含 stop_sequence 字段", "stop_sequence" in j);
}

// =====================================================================
console.log("\n【8】上游请求体处理");
{
  setMode({ kind: "ok" });
  await (await post("/v1/chat/completions",
    { model: "cline-free/deepseek-v4.1-flash", max_tokens: 999, temperature: 0.5,
      messages: [{ role: "user", content: "hi" }] }, AUTH)).text();
  const sent = upstreamCalls[0].body;
  check("剥离 max_tokens（上游带该字段会 500）", !("max_tokens" in sent), "body 含: " + Object.keys(sent).join(","));
  check("保留 temperature 等可选参数", sent.temperature === 0.5);
  check("免费通道非流式请求被强制走上游 stream", sent.stream === true);
  check("附带 session_id", typeof sent.session_id === "string");
}

// =====================================================================
console.log("\n【9】/v1/models 白名单过滤（只放行确定免费的模型）");
{
  setMode({ kind: "ok" });
  const r = await req("/v1/models");
  const d = await r.json();
  const ids = d.data.map((m) => m.id);
  check("返回 object=list", d.object === "list");
  check("每个模型都带 cost 字段", d.data.length > 0 && d.data.every((m) => typeof m.cost === "string"),
    "样例: " + JSON.stringify(d.data[0]));
  check("每个模型都带 free 布尔字段", d.data.every((m) => typeof m.free === "boolean"));
  check("列表内全部标为免费（白名单语义）",
    d.data.every((m) => m.cost === "free" && m.free === true),
    "不应出现非 free 项: " + JSON.stringify(d.data.filter((m) => m.cost !== "free")));
  check(":free 后缀的模型放行",
    ids.includes("nvidia/nemotron-3-super-120b-a12b:free"), "缺 :free 后缀模型");
  check("白名单里实测免费的模型放行（名字无 :free 也要进）",
    ids.includes("deepseek/deepseek-v4-flash"), "白名单模型被挡掉了");
  check("非白名单的普通模型被挡掉",
    !ids.includes("openai/gpt-6-astra") && !ids.includes("unknown-vendor/mystery-model"),
    "不应放行: " + ids.join(", "));
  check("即便官方 recommended 分类也不放行（只认白名单与 :free）",
    !ids.includes("openai/gpt-6-astra"), "openai/gpt-6-astra 不该出现");
  check("需订阅的 cline-pass 模型被挡掉", !ids.includes("cline-pass/glm-5.2"));
  check(":batch 通道被排除（即便带 :free 后缀）",
    !d.data.some((m) => m.id.includes(":batch")),
    ":batch 应被排除");
  check("~ 别名去波浪号后按白名单判定，命中则保留",
    ids.includes("deepseek/deepseek-v4-flash-0731") && !ids.some((i) => i.startsWith("~")),
    "~deepseek/deepseek-v4-flash-0731 应变成不带波浪号的 ID");
  check("~ 别名未命中白名单则丢弃", !ids.includes("openai/gpt-latest"));
  check("别名保留原始 ID 到 upstream 字段（便于排查）",
    d.data.some((m) => m.upstream === "~deepseek/deepseek-v4-flash-0731" && m.id === "deepseek/deepseek-v4-flash-0731"));
  check("模型不重复（~ 别名与本体同名时去重）", ids.length === new Set(ids).size,
    "发现重复 ID: " + ids.filter((x, i) => ids.indexOf(x) !== i).join(", "));
  check("官方 free 分类 → channel=free",
    d.data.some((m) => m.channel === "free" && m.id === "z-ai/glm-5.3-flash"),
    "应有 channel=free 的模型");
  check("官方分类未覆盖但在白名单里 → channel=verified",
    d.data.some((m) => m.channel === "verified" && m.id === "deepseek/deepseek-v4-flash"),
    "白名单独有项应标 verified");
  check("仅靠 :free 后缀进来的 → channel=free-suffix",
    d.data.some((m) => m.channel === "free-suffix" && m.id.endsWith(":free")),
    "应有一条 free-suffix 来源的模型");
  check("每个模型都带 channel 字段（渠道来源可溯源）",
    d.data.every((m) => "channel" in m), "缺 channel 字段");
  // cline-free/* 不在 /v1/models 里，只存在于 recommended-models 的 free 数组，
  // 必须补入模型池——否则默认模型自己会从列表里消失
  check("free 数组独有模型（cline-free/*）被补入模型池",
    ids.includes("cline-free/deepseek-v4.1-flash") && ids.includes("cline-free/muse-spark-1.3-contributor"),
    "缺 cline-free 官方免费通道: " + ids.join(", "));
  check("补入的模型也标 free", d.data.filter((m) => m.id.startsWith("cline-free/")).every((m) => m.free === true));
}

// =====================================================================
console.log("\n【10】控制台页面完整性");
{
  const r = await req("/");
  const html = await r.text();
  check("返回 HTML 且含 UTF-8 声明", r.status === 200 && html.includes('charset="utf-8"'));
  check("与 console.src.html 一致（构建产物同步）", await (async () => {
    try {
      const { readFileSync } = await import("node:fs");
      const src = readFileSync(new URL("./console.src.html", import.meta.url), "utf8");
      return html === src;
    } catch { return true; } // 无源文件时跳过
  })(), "worker.js 内联的 HTML 与 console.src.html 不一致，请运行 node build-console.mjs");
  // 关键功能点必须在页面上
  for (const [name, needle] of [
    ["多轮对话容器", 'id="thread"'],
    ["停止生成按钮", 'id="btnStop"'],
    ["模型筛选输入框", 'id="mfilter"'],
    ["只看免费开关", 'id="mfree"'],
    ["接入代码片段区", 'id="snip"'],
    ["固定高度日志滚动窗口", 'id="logwin"'],
    ["日志详情面板", 'id="logDetail"'],
    ["日志筛选开关", 'data-f="slow"'],
    ["账号池指示器（签名元素）", 'id="poolCells"'],
    ["输出速度列", 'data-s="speed"'],
    ["首字节列", 'data-s="ttft"'],
    ["思考过程折叠", 'details class="rz"'],
  ]) {
    check("含" + name, html.includes(needle), "缺少: " + needle);
  }
  check("代码片段覆盖 5 种语言",
    html.includes('{id:"curl"') && html.includes('{id:"python"') && html.includes('{id:"node"') &&
    html.includes('{id:"anthropic"') && html.includes('{id:"env"'),
    "片段定义应含 curl/python/node/anthropic/env 五种");
  check("错误提示含 1010 / 402 / 429 的解释",
    html.includes("1010") && html.includes("insufficient_credits") && html.includes("Daily free limit"),
    "页面应把常见上游错误翻译成可操作建议");
  check("含复制模型 ID 的按钮", html.includes("data-copyid"));
  check("含速度单位 tok/s", html.includes("tok/s"));
  check("尊重 prefers-reduced-motion", html.includes("prefers-reduced-motion"));
  check("无外部资源依赖（单文件自包含）",
    !/<script[^>]+src=/i.test(html) && !/<link[^>]+stylesheet/i.test(html),
    "不应引用外部 js/css，否则离线/内网部署会挂");
  check("品牌已改为 cline-free", html.includes("cline-free") && html.includes("<title>cline-free"));
  check("署名作者 Patrick", html.includes("Patrick"));
  check("署名公众号 AI实用talk", html.includes("AI实用talk"));
  check("像素 WiFi 图标为内联 SVG（1px 网格 rect）",
    /<svg class="logo"[^>]*><rect /.test(html), "品牌区应有像素 WiFi 的 SVG");
  check("国产模型识别表存在", html.includes("CN_PROVIDERS") && html.includes("deepseek"));
  check("国产优先排序逻辑存在", html.includes('s==="region"') || html.includes('mcn'));
  check("日志为固定高度滚动窗口", html.includes('id="logwin"') && /overflow-y:\s*auto/.test(html));
  check("日志含跟随最新开关", html.includes('id="btnFollow"'));
  check("日志含详情面板", html.includes('id="logDetail"'));
  check("含主题切换（深/浅）", html.includes('id="btnTheme"') && html.includes('[data-theme="light"]'));
  check("含减少动效支持", html.includes("prefers-reduced-motion"));

  // 回归：曾在 HTML 里写 Markdown 粗体，页面直接显示成 **文字**，很显眼
  check("可见文案中没有残留 Markdown 标记（** 与 [](  ）", await (async () => {
    // 只看 body 里、标签之外的文本
    const body = html.slice(html.indexOf("<body"));
    const textOnly = body.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ");
    return !/\*\*[^*]+\*\*/.test(textOnly) && !/\[[^\]]+\]\([^)]+\)/.test(textOnly);
  })(), "页面文案里出现了未渲染的 Markdown 语法");
  check("账号页含登录按钮", html.includes('id="btnLogin"'));
  check("登录区含跳转授权页的按钮", html.includes("btnOpenAuth"));
  check("展示设备码的容器存在", html.includes('id="deviceCode"'));

  // 回归：状态提示曾用绝对定位的顶部浮层（#notes）呈现，它压在整个 .views 之上，
  // 正好盖住账号页右上角的「登录新账号」按钮 —— 提示用户去登录，却挡住登录入口。
  // 现统一改为右下角弹窗（syncNotices），这里确保浮层不再回来。
  check("没有覆盖在视图之上的提示浮层（会挡住页头按钮）",
    !html.includes('id="notes"') && !/\.notes\s*\{[^}]*position\s*:\s*absolute/.test(html),
    "顶部提示浮层又出现了：#notes 绝对定位在 .views 顶部，会挡住各页头部按钮");
  check("状态提示走右下角弹窗同步（syncNotices）",
    html.includes("function syncNotices") && html.includes("sticky: true"),
    "renderHealth 应通过 syncNotices 把状态提示发到右下角，而不是渲染到页面顶部");
  check("弹窗支持动作按钮（提示里可直接去处置）",
    html.includes("function bindToastAction") && html.includes('class="act"'),
    "常驻提示需要一个按钮把用户带到处置位置");
  check("常驻提示不自动消失（sticky 且无倒计时条）",
    html.includes('(o.sticky ? " sticky" : "")') &&
    html.includes(".toast:not(.out):not(.sticky)") &&
    html.includes('var barHtml = o.sticky ? "" : '),
    "sticky 提示不该被自动收走，也不该参与淘汰计数");
  check("手动关掉的提示不会每 30 秒弹回来",
    html.includes("muteNotice") && html.includes("mutedNotices[it.nid]"),
    "syncNotices 每轮轮询都会跑，需要记住用户已关闭的提示");
  check("本地首次运行不再被误报为「服务端未配置」",
    html.includes("isLocalConsole") && html.includes("本地首次启动时账号池是空的，这是正常的"),
    "本地账号池为空是预期状态，应提示去登录而非报配置错误");
  check("云端账号丢失时有单独措辞（不说成配置缺失）",
    html.includes("当前没有可用账号") && html.includes("重新部署后会丢失"),
    "云端内存账号在冷启动后会丢，提示不应说成「未配置 CLINE_REFRESH_TOKEN」");
}

// =====================================================================
console.log("\n【11】/v1/health 账号池明细（控制台签名元素的数据源）");
{
  const env = { API_KEY: "sk-test", CLINE_REFRESH_TOKEN: "TOKEN_Z_zzzzzzzzzz\nTOKEN_Y_yyyyyyyyyy" };
  const h = await (await worker.fetch(new Request("https://x.dev/v1/health"), env)).json();
  check("返回 account_details 数组", Array.isArray(h.account_details), JSON.stringify(h.account_details));
  check("每项含 index / available / cooldown_seconds / token_cached",
    h.account_details.every((a) =>
      typeof a.index === "number" && typeof a.available === "boolean" &&
      typeof a.cooldown_seconds === "number" && typeof a.token_cached === "boolean"),
    JSON.stringify(h.account_details[0]));
  check("account_details 不泄露 token 内容", await (async () => {
    // 用不可能出现在字段名/枚举值里的 token，避免误判
    const probe = "sEcReTtOkEnVaLuE12345";
    const e2 = { API_KEY: "sk-test", CLINE_REFRESH_TOKEN: probe + "_aaaaaaaaaa\n" + probe + "_bbbbbbbbbb" };
    const h2 = await (await worker.fetch(new Request("https://x.dev/v1/health"), e2)).json();
    const dump = JSON.stringify(h2);
    return !dump.includes(probe);
  })(), "健康端点里出现了 refreshToken 片段");
  check("account_details 数量与 account_count 一致",
    h.account_details.length === h.account_count);
}

// =====================================================================
console.log("\n【12】登录端点鉴权（不得成为开放 OAuth 代理）");
{
  // 未配置 API_KEY 时必须拒绝
  const noKeyEnv = { CLINE_REFRESH_TOKEN: "TOKEN_A_aaaaaaaaaa" };
  for (const path of ["/v1/login/start", "/v1/login/poll"]) {
    const r = await worker.fetch(new Request("https://x.dev" + path, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    }), noKeyEnv);
    check(path + " 未配置 API_KEY 时拒绝", r.status === 401, "status=" + r.status);
  }
  // 错误 key 也必须拒绝
  const r2 = await post("/v1/login/start", {}, { Authorization: "Bearer wrong-key" });
  check("/v1/login/start 错误 key 拒绝", r2.status === 401, "status=" + r2.status);
  // 公开默认 key 必须无效（历史后门）
  const r3 = await post("/v1/login/start", {}, { Authorization: "Bearer cline2api-default-key" });
  check("/v1/login/start 拒绝公开默认 key", r3.status === 401, "status=" + r3.status);
}

console.log("\n【13】登录流程（假 WorkOS 上游）");
{
  // 用一个本地假 WorkOS，验证 start → poll pending → poll success 全链路
  const { createServer } = await import("node:http");
  let pollCount = 0;
  const fake = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString("utf8");
    if (req.url.includes("authorize/device")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        device_code: "dev_abc123", user_code: "ABCD-1234",
        verification_uri_complete: "https://authkit.example/device?user_code=ABCD-1234",
        interval: 5, expires_in: 300,
      }));
      return;
    }
    if (req.url.includes("user_management/authenticate")) {
      pollCount++;
      if (pollCount < 2) {
        // 第一次：还没授权（WorkOS 用 400 + authorization_pending）
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "authorization_pending", error_description: "still pending" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ access_token: "workos_at", refresh_token: "workos_rt" }));
      return;
    }
    if (req.url.includes("/auth/register")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: { refreshToken: "CLINE_RT_NEW_123456", userInfo: { email: "new@example.com" } } }));
      return;
    }
    res.writeHead(404); res.end("{}");
  });
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  const fakePort = fake.address().port;

  // 把 worker 里的 WorkOS 地址替换成本地假上游
  const { readFileSync, writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const src = readFileSync(new URL("./worker.js", import.meta.url), "utf8")
    .replace('const WORKOS_DEVICE = "https://api.workos.com/user_management/authorize/device";',
             'const WORKOS_DEVICE = "http://127.0.0.1:' + fakePort + '/user_management/authorize/device";')
    .replace('const WORKOS_AUTH = "https://api.workos.com/user_management/authenticate";',
             'const WORKOS_AUTH = "http://127.0.0.1:' + fakePort + '/user_management/authenticate";')
    .replace('const CLINE_REGISTER = "https://api.cline.bot/api/v1/auth/register";',
             'const CLINE_REGISTER = "http://127.0.0.1:' + fakePort + '/api/v1/auth/register";');
  const dir = mkdtempSync(join(tmpdir(), "login-test-"));
  const f = join(dir, "w.mjs");
  writeFileSync(f, src, "utf8");
  const w2 = (await import("file:///" + f.split("\\").join("/"))).default;

  const env = { API_KEY: "sk-test", CLINE_REFRESH_TOKEN: "" };
  const call = (path, body) => w2.fetch(new Request("https://x.dev" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer sk-test" },
    body: JSON.stringify(body || {}),
  }), env);

  const s = await call("/v1/login/start", {});
  const sd = await s.json();
  check("start 返回授权链接", s.status === 200 && !!sd.verification_uri, JSON.stringify(sd).slice(0, 140));
  check("start 返回设备码", sd.user_code === "ABCD-1234", sd.user_code);
  check("start 返回 device_code", !!sd.device_code);

  const p1 = await (await call("/v1/login/poll", { device_code: sd.device_code })).json();
  check("poll 未授权时返回 pending（不当作错误）", p1.status === "pending", JSON.stringify(p1));

  const p2 = await (await call("/v1/login/poll", { device_code: sd.device_code })).json();
  check("poll 授权后返回 success", p2.status === "success", JSON.stringify(p2).slice(0, 140));
  check("poll 返回 refreshToken", p2.refresh_token === "CLINE_RT_NEW_123456", p2.refresh_token);
  check("poll 返回邮箱", p2.email === "new@example.com", p2.email);

  // 登录后账号应进入账号池并可被 health 看到（标记为 runtime）
  const h = await (await w2.fetch(new Request("https://x.dev/v1/health"), env)).json();
  check("登录的账号已进入账号池", h.account_count === 1, "account_count=" + h.account_count);
  check("该账号被标记为运行时账号（重启会丢）",
    h.runtime_accounts === 1 && h.account_details[0].runtime === true,
    JSON.stringify(h.account_details));
  check("health 不泄露登录得到的 refreshToken",
    !JSON.stringify(h).includes("CLINE_RT_NEW"), "泄漏了 token");

  const p3 = await (await call("/v1/login/poll", {})).json();
  check("poll 缺 device_code 时报错", !p3.ok, JSON.stringify(p3));
  check("poll 不泄露上游错误细节为成功", p3.status !== "success");

  // 运行时账号可以被移除（与环境变量账号相反：后者只能停用）
  const h2 = await (await w2.fetch(new Request("https://x.dev/v1/health"), env)).json();
  const rtId = h2.account_details[0].id;
  const rm = await (await call("/v1/accounts/action", { action: "remove", id: rtId })).json();
  check("运行时账号可以移除", rm.ok === true && rm.removed === 1,
    JSON.stringify(rm).slice(0, 160));
  const h3 = await (await w2.fetch(new Request("https://x.dev/v1/health"), env)).json();
  check("移除后账号池里不再有该账号", h3.account_count === 0,
    "account_count=" + h3.account_count);

  fake.close();
}

// =====================================================================
console.log("\n【14】账号控制（启用/停用/重置冷却/移除）");
{
  // 独立加载一份 worker，避免影响前面的用例（账号池是模块级状态）
  const { readFileSync, writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const src = readFileSync(new URL("./worker.js", import.meta.url), "utf8")
    .replace('const CLINE_API_BASE = "https://api.cline.bot/api/v1";', 'const CLINE_API_BASE = "' + UPSTREAM + '/api/v1";');
  const dir = mkdtempSync(join(tmpdir(), "acct-test-"));
  const f = join(dir, "w.mjs");
  writeFileSync(f, src, "utf8");
  const w = (await import("file:///" + f.split("\\").join("/"))).default;

  const env = { API_KEY: "sk-test", CLINE_REFRESH_TOKEN: "TOKEN_A_aaaaaaaaaa\nTOKEN_B_bbbbbbbbbb" };
  const call = (path, body) => w.fetch(new Request("https://x.dev" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer sk-test" },
    body: JSON.stringify(body || {}),
  }), env);
  const health = async () => (await w.fetch(new Request("https://x.dev/v1/health"), env)).json();
  const chat = () => w.fetch(new Request("https://x.dev/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer sk-test" },
    body: JSON.stringify({ model: "cline-free/deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }] }),
  }), env);

  let h = await health();
  check("health 的账号明细含 id / enabled / stats",
    h.account_details.every((a) => typeof a.id === "string" && a.id.length > 0 &&
      typeof a.enabled === "boolean" && a.stats && typeof a.stats.ok === "number"),
    JSON.stringify(h.account_details[0]));
  check("账号 id 不泄露 token 内容",
    !JSON.stringify(h).includes("TOKEN_A") && !JSON.stringify(h).includes("TOKEN_B"));
  const idA = h.account_details[0].id, idB = h.account_details[1].id;
  check("多账号的 id 互不相同", idA !== idB, idA + " vs " + idB);

  // 未鉴权不得操作账号
  const noAuth = await w.fetch(new Request("https://x.dev/v1/accounts/action", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "disable", id: idA }),
  }), env);
  check("账号控制端点未鉴权时拒绝", noAuth.status === 401, "status=" + noAuth.status);

  // 停用
  let r = await (await call("/v1/accounts/action", { action: "disable", id: idA })).json();
  check("停用账号返回成功", r.ok === true, JSON.stringify(r).slice(0, 140));
  check("停用后该账号 enabled=false",
    r.accounts[0].enabled === false && r.accounts[0].available === false,
    JSON.stringify(r.accounts[0]));
  check("停用只影响目标账号", r.accounts[1].enabled === true);
  check("停用后 accounts_available 少一个", r.accounts.filter((a) => a.available).length === 1);

  h = await health();
  check("health 反映停用状态",
    h.account_details[0].enabled === false && h.accounts_available === 1,
    JSON.stringify({ enabled: h.account_details[0].enabled, avail: h.accounts_available }));

  // 停用全部 → 请求应给出明确原因，而不是含糊的报错
  await call("/v1/accounts/action", { action: "disable", id: idB });
  const chatResp = await chat();
  const chatBody = await chatResp.json();
  check("全部停用时聊天端点说明原因（all_accounts_disabled）",
    chatBody.error && chatBody.error.reason === "all_accounts_disabled",
    JSON.stringify(chatBody).slice(0, 200));
  check("全部停用返回 429（可重试语义而非 500）", chatResp.status === 429, "status=" + chatResp.status);

  // 启用回来 → 恢复正常
  r = await (await call("/v1/accounts/action", { action: "enableAll" })).json();
  check("全部启用后所有账号 enabled",
    r.accounts.every((a) => a.enabled === true), JSON.stringify(r.accounts.map((a) => a.enabled)));
  check("全部启用后 accounts_available 恢复", r.accounts.filter((a) => a.available).length === 2);

  // 重置冷却
  r = await (await call("/v1/accounts/action", { action: "reset", id: idA })).json();
  check("重置冷却返回成功且该账号可用",
    r.ok === true && r.accounts.find((a) => a.id === idA).cooldown_seconds === 0,
    JSON.stringify(r.accounts.find((a) => a.id === idA)));

  r = await (await call("/v1/accounts/action", { action: "resetAll" })).json();
  check("重置全部冷却返回成功", r.ok === true, JSON.stringify(r).slice(0, 140));

  // 环境变量账号不可移除（移除没意义：下次 parseAccounts 又会建出来）
  const rm = await call("/v1/accounts/action", { action: "remove", id: idA });
  const rmBody = await rm.json();
  check("环境变量账号拒绝移除", rm.status === 400 && !rmBody.ok, JSON.stringify(rmBody).slice(0, 200));
  check("拒绝移除时提示改用停用", rmBody.error && rmBody.error.message.includes("停用"));

  // 未知 id / 未知 action
  const unknown = await (await call("/v1/accounts/action", { action: "disable", id: "deadbeef" })).json();
  check("未知账号 id 返回错误", unknown.ok !== true, JSON.stringify(unknown).slice(0, 140));
  const badAct = await (await call("/v1/accounts/action", { action: "nonsense", id: idA })).json();
  check("未知 action 返回错误", badAct.ok !== true, JSON.stringify(badAct).slice(0, 140));
  const noAct = await (await call("/v1/accounts/action", {})).json();
  check("缺少 action 参数时报错", noAct.ok !== true);

  // 统计：成功调用应累计到账号上
  await chat();
  h = await health();
  check("成功请求累加到账号统计（ok>0）",
    h.account_details.some((a) => a.stats.ok > 0),
    JSON.stringify(h.account_details.map((a) => a.stats)));

  // token 刷新轮换后，账号 id 必须保持不变，否则控制台的开关会跟丢账号
  const afterRefresh = await health();
  check("账号 id 在 token 轮换后保持稳定",
    afterRefresh.account_details[0].id === idA,
    "before=" + idA + " after=" + afterRefresh.account_details[0].id);
}

// ---------- 收尾 ----------
upstream.close();
console.log("\n" + "=".repeat(56));
console.log(fail === 0
  ? "✅ 全部通过：" + pass + " 项"
  : "❌ 通过 " + pass + " 项，失败 " + fail + " 项");
console.log("=".repeat(56));
process.exit(fail === 0 ? 0 : 1);
