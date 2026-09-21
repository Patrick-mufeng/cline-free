/**
 * 本地运行入口（不部署也能跑）
 *
 * 用法：
 *   1. 在项目根目录的 .env.local 里填 CLINE_REFRESH_TOKEN（和可选的 API_KEY）
 *   2. node local-server.js
 *   3. 浏览器/curl 访问 http://localhost:8787
 *
 * 原理：把 Node 的 http 请求转成 Web Request 交给 worker.js 的 fetch 处理器，
 *       响应再转回 Node http（支持 SSE 流式透传）。生产代码 worker.js 不做任何改动。
 */
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);

// ---- 读取 .env.local（简易解析，不引依赖）----
function loadEnvLocal() {
  const file = join(__dirname, ".env.local");
  const out = {};
  if (!existsSync(file)) return out;
  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

// 每次请求都重新读配置，这样 cline_oauth.py 写入 token 后无需重启服务
function currentEnv() {
  const fileEnv = loadEnvLocal();
  return {
    CLINE_REFRESH_TOKEN: process.env.CLINE_REFRESH_TOKEN || fileEnv.CLINE_REFRESH_TOKEN || "",
    API_KEY: process.env.API_KEY || fileEnv.API_KEY || "",
  };
}

/**
 * 本地首次运行时自动生成一个 API_KEY 并写回 .env.local，省得手填。
 * 只写本地文件（已被 .gitignore 忽略），不影响线上部署。
 * 若用户已显式设置（环境变量或文件里已有非空值），则尊重原值不动。
 */
function ensureLocalApiKey() {
  if ((process.env.API_KEY || "").trim()) {
    return { key: process.env.API_KEY.trim(), generated: false, why: "env" };
  }
  const fileEnv = loadEnvLocal();
  if ((fileEnv.API_KEY || "").trim()) {
    return { key: fileEnv.API_KEY.trim(), generated: false, why: "file" };
  }

  const key = "sk-cline-" + randomUUID().replace(/-/g, "").slice(0, 24);
  const path = join(__dirname, ".env.local");
  let lines = [];
  if (existsSync(path)) {
    lines = readFileSync(path, "utf8").split(/\r?\n/);
  } else {
    lines = ["# 本地运行配置（.gitignore 已忽略，不会提交）", "CLINE_REFRESH_TOKEN="];
  }
  // 替换已有的空 API_KEY 行，没有就追加
  let replaced = false;
  const out = [];
  for (const line of lines) {
    if (/^\s*API_KEY\s*=/.test(line)) {
      if (!replaced) { out.push("API_KEY=" + key); replaced = true; }
      continue;
    }
    out.push(line);
  }
  if (!replaced) out.push("API_KEY=" + key);
  writeFileSync(path, out.join("\n").replace(/\n+$/, "") + "\n", "utf8");
  return { key, generated: true, why: "generated" };
}

function countAccounts(token) {
  return String(token || "").split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 8).length;
}

const bootEnv = currentEnv();
const tokenCount = countAccounts(bootEnv.CLINE_REFRESH_TOKEN);
const keyInfo = ensureLocalApiKey();

console.log("=".repeat(64));
console.log("cline-free 本地服务");
console.log("=".repeat(64));
console.log("CLINE_REFRESH_TOKEN :", tokenCount > 0 ? `已配置 ${tokenCount} 个账号` : `未配置 — 打开 http://localhost:${PORT} 在「账号」页登录即可`);
if (keyInfo.generated) {
  console.log("API_KEY             :", keyInfo.key);
  console.log("                      ↑ 首次运行自动生成，已写入 .env.local（无需手填）");
} else {
  console.log("API_KEY             :", keyInfo.key, keyInfo.why === "env" ? "(来自环境变量)" : "(来自 .env.local)");
}
console.log("监听地址            : http://localhost:" + PORT);
console.log("-".repeat(64));
console.log("端点：");
console.log(`  GET  http://localhost:${PORT}/           控制台（浏览器打开）`);
console.log(`  GET  http://localhost:${PORT}/v1/health`);
console.log(`  GET  http://localhost:${PORT}/v1/models`);
console.log(`  POST http://localhost:${PORT}/v1/chat/completions`);
console.log(`  POST http://localhost:${PORT}/v1/messages      (Anthropic 格式)`);
console.log("=".repeat(64));

/**
 * 加载 worker.js，并在文件变化时自动重新加载。
 * 背景：Node 会缓存 ESM 导入，改完 worker.js（尤其是跑过 build-console.mjs
 * 重新生成内联 HTML 之后）如果只重启不够或忘了重启，服务会继续返回旧页面，
 * 排查时极易误判成"改动没生效"。这里用 mtime 轮询 + 带时间戳的动态导入实现热重载。
 */
let worker = null;
let workerMtime = 0;
let reloads = 0;
const workerPath = join(__dirname, "worker.js");

async function getWorker() {
  try {
    const mtime = statSync(workerPath).mtimeMs;
    if (!worker || mtime !== workerMtime) {
      // 用 query 参数绕开 ESM 模块缓存
      const mod = await import("./worker.js?t=" + mtime);
      worker = mod.default;
      workerMtime = mtime;
      reloads++;
      if (reloads > 1) console.log(`[hot-reload] worker.js 已更新，已重新加载（第 ${reloads - 1} 次）`);
    }
  } catch (e) {
    if (!worker) throw e;
    console.error("[hot-reload] 重新加载失败，继续用上一版：", String(e.message || e).slice(0, 160));
  }
  return worker;
}

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;

  const url = "http://localhost:" + PORT + req.url;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach((item) => headers.append(k, item));
    else headers.set(k, v);
  }

  const request = new Request(url, {
    method: req.method,
    headers,
    body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
  });

  try {
    const w = await getWorker();
    const resp = await w.fetch(request, currentEnv());

    // 本地便利：把自动生成的 API_KEY 注入控制台页面，省得手填。
    // 仅在本地开发服务器生效，线上 Worker 不会注入。
    const ctype = resp.headers.get("content-type") || "";
    if (req.method === "GET" && ctype.includes("text/html")) {
      let html = await resp.text();
      const inject =
        "<script>window.__CLINE2API__={key:" + JSON.stringify(keyInfo.key) + "};</script>\n";
      html = html.includes("</head>")
        ? html.replace("</head>", inject + "</head>")
        : inject + html;
      const headers = Object.fromEntries(resp.headers);
      headers["content-length"] = String(Buffer.byteLength(html));
      res.writeHead(resp.status, headers);
      return res.end(html);
    }

    res.writeHead(resp.status, Object.fromEntries(resp.headers));
    if (!resp.body) return res.end();
    const reader = resp.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // 流式响应立即 flush，保证 SSE 逐块到达（不被 Node 缓冲吞掉）
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    console.error("[local-server] 处理异常:", err);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: String(err && err.message || err), type: "local_server_error" } }));
  }
});

server.listen(PORT, () => {
  console.log(`\n✅ 服务已启动，按 Ctrl+C 停止\n`);
});
