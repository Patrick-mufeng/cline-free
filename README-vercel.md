# Cline2API · Vercel 部署补充说明

> ⚠️ **本仓库现在只有 `main` 一条分支**（原 `vercel` 分支已删除并合并）。
> Cloudflare Workers 版（`worker.js`）和 Vercel 版（`api/index.js`）**同源同仓库**。
>
> **完整的 Vercel 部署教程见 [README.md](./README.md) 第三章「部署到 Vercel」**，
> 本文只保留两版差异对照，便于排查问题。

## 为什么用 Vercel？

- CF Workers 域名对 `User-Agent` 挑得凶（非浏览器 UA 直接 `1010`）；Vercel 域名**不挑 UA**，
  curl / python / SDK 默认 UA 都能直连
- Workers 免费档容易触发限流/风控，Vercel Hobby 免费档可作备份通道
- 代码几乎不用改：Vercel Edge Runtime 原生支持 `fetch` / `Request` / `Response`

## 文件结构

```
├── api/index.js   # Vercel Edge Function 入口（完整逻辑，与 worker.js 同源）
├── vercel.json    # 路由重写：/v1/* → /api/index
├── worker.js      # Cloudflare Workers 入口
└── cline_oauth.py # 获取 Cline refreshToken 的脚本（两版通用）
```

## 两版差异对照

| 项 | Cloudflare Workers | Vercel Edge Function |
|---|---|---|
| 入口文件 | `worker.js` | `api/index.js` |
| 入口写法 | `export default { fetch(request, env) }` | `export default async function handler(request)` |
| 环境变量 | `wrangler secret` / Dashboard 机密 | Vercel Env Variables（`process.env`） |
| 路由 | Worker 内置路由 | `vercel.json` rewrites |
| 部署命令 | `npx wrangler deploy` | `vercel --prod` |
| 区域 | Cloudflare 全球边缘 | 文件内 `regions: ["iad1","sfo1"]`（美区） |
| UA 要求 | **必须浏览器 UA**，否则 `1010` | 不挑 UA |
| 域名保护 | 无 | 自动生成的域名受 Deployment Protection 限制，生产别名 `项目名.vercel.app` 公开 |

> ️ 改功能时 `worker.js` 与 `api/index.js` **两份都要同步改**，否则两版行为会不一致。

## 测试

```bash
# 健康检查（无需鉴权）
curl https://<项目名>.vercel.app/v1/health

# OpenAI 兼容
curl https://<项目名>.vercel.app/v1/chat/completions \
  -H "Authorization: Bearer ***" \
  -H "Content-Type: application/json" \
  -d '{"model":"cline-free/deepseek-v4.1-flash","messages":[{"role":"user","content":"hi"}],"stream":true}'
```