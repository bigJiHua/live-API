# 环境配置与接手启动

本仓库提交 `.env.example` 和配置检查工具；真实 `.env` 不入库。模板默认与 Web 配套：API `7788`、Web `5173`。`app.js` 无 PORT 时的历史回退为 `3001`，正常启动检查要求显式填写 PORT，避免误用回退端口。

## 首次启动

需要 Node.js 22.12+（或 24）、npm、MySQL 8。先进入本仓库根目录，安装依赖并复制模板；已有 `.env` 时只补缺项，保留原密码和密钥。

```powershell
npm install
Copy-Item .env.example .env  # 仅首次、.env 不存在时执行
```

必须确认这些值：

| 配置 | 本地模板 / 填写要求 |
|---|---|
| `NODE_ENV` / `PORT` | `development` / `7788`；生产改为 `production` |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | 自己的 MySQL 连接；模板库名 `live`，密码允许为空但须与数据库一致 |
| `JWT_SECRET` | 至少 32 位随机串；生产拒绝占位值，开发会告警 |
| `FRONTEND_URL` | `http://localhost:5173`；只填来源地址，不加路径 |
| `TRUST_PROXY_HOPS` | 本地直连 `0`，前面一层 Nginx 填 `1` |
| `INIT_SKIP` / `INIT_ENABLE` | 日常为 `false` / `false`，启动执行增量迁移 |

生成一个新密钥，再写入 `.env` 的 `JWT_SECRET`（仅新部署）：

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

已存在的部署必须保留 `JWT_SECRET`、`SHARE_TOKEN_SECRET`、`FIELD_ENCRYPT_KEY` 及 RSA 持久化文件。字段加密密钥还用于保存 AI 接入商 Key、记忆和回执；直接换密钥会使已有密文无法解密。多实例共用一致密钥、数据库和 RSA 文件。

准备数据库：已有库保留数据，只跑日常增量迁移；新库先创建并导入 `mysql/live.sql`（见 README 的建库命令）。需要首次管理员时，在新库设 `INIT_ENABLE=true`、`INIT_SKIP=false` 并填写自己的 `INIT_ADMIN_USER/PASS/EMAIL`，不能沿用占位密码。深度初始化会备份并同步结构，完成后清理管理员配置、设置 `INIT_ENABLE=false` 和 `INIT_SKIP=true`；确认完成后把 `INIT_SKIP` 改回 `false`，以便以后更新时执行迁移。

```powershell
npm run env:check          # 检查配置与模板覆盖，不连接数据库
npm run env:check -- --db  # 再检查数据库连接，只执行 SELECT 1
npm run dev               # 启动时自动检查配置，再进行正常初始化/迁移
```

开发与生产入口 `npm run dev`、`npm start`、`node app.js` 都检查必填项、端口、地址、密钥与 AI 条件。错误只显示变量名和修复方式，退出后不启动服务；开发占位密钥会告警。`--db` 不建库、不迁移、不调用模型，也不代表完整业务权限验收。

## AI 配置

基础服务默认 `AI_MODE=disabled`，不需要 AI 只读账号即可启动。开启时设 `AI_MODE=deepseek`（兼容开关名，仍支持多接入商），并配齐 `AI_DB_HOST/PORT/NAME/USER/PASSWORD`。`AI_DB_NAME` 与 `DB_NAME` 必须指向同一账本；`AI_DB_USER` 使用独立只读账号，不能使用 root 或业务可写账号，按 `mysql/README.md` 的固定业务表范围授予 SELECT。

用户在「聊天设置 → AI 连接设置」填写接入商地址、模型和 Key，加密保存到 `ai_provider_profile`。旧 `AI_API_KEY`、`AI_BASE_URL`、`AI_MODEL`、`DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL` 不用于用户聊天；仅复制这些旧 env 值不能完成 AI 配置。

额度、输出 Token、供应商超时、单轮超时：**本人设置 > 数据库 ai_config > env 回退**。模板中的回退值不等于已部署站点的实际额度；接手时需保留数据库配置。

联网搜索的 `AI_SEARCH_BASE_URL/API_KEY/PROVIDER` 为可选站点代配，三项同时填写或全部留空；DeepSeek/智谱聊天连接可复用用户 Key，仍需用户明确开启并授权。`AI_SEARCH_ENGINE` 仅用于智谱。邮件 `EMAIL_*`、地图 `AMAP_KEY`/`IPINFO_TOKEN` 等服务配置可在基础启动后填写，未配置会影响对应功能。

## 与 Web、生产配置对齐

| API 配置 | Web 配置 / 反向代理 |
|---|---|
| `PORT=7788` | `VITE_API_BASE_URL=http://localhost:7788`，不追加 `/api` |
| `FRONTEND_URL=http://localhost:5173` | `VITE_PORT=5173`、`VITE_SITE_URL=http://localhost:5173` |
| `/api/public` 文件路由 | `VITE_FILE_BASE_URL=http://localhost:7788/api/public` |
| 生产 `PORT=<实际端口>` | Nginx 所有 `proxy_pass` 使用同一端口；浏览器 `/api/v1` 与 `/api/public` 由反代转发 |
| 生产 `FRONTEND_URL=https://<自己的域名>` | Web 生产站点 URL 与文件 URL 使用自己的 HTTPS 地址或同源文件路径 |

API 只加载启动目录的 `.env`，系统/进程环境变量优先；不会因为 `NODE_ENV=production` 自动改读 `.env.production`。从仓库根目录启动。Web 则按 Vite mode 加载 `.env*`，以 Web 仓库 `ENV_SETUP.md` 为准。

Go 是独立实现，默认监听 `7777`（可用 PORT 覆盖），不提供当前 Node AI 功能；切换时用 Go 自己的模板并让 Web 指向实际端口。不要将 Node `.env` 整份覆盖到 Go。

## 后续更新

每次新增或改名环境变量，同一改动更新 `.env.example` 和本说明；新增可选项用注释列出默认值。运行 `npm run env:check:example` 检查源码里的 `process.env.NAME` / `env.NAME` 是否遗漏模板；真实环境再运行 `npm run env:check -- --db`。`INIT_ADMIN_*` 被初始化清理后、未启用的可选项缺省，均不要求补回全部模板值。

配置检查失败时先按变量名修正；数据库 `ER_BAD_DB_ERROR` 表示目标库不存在，`ER_ACCESS_DENIED_ERROR` 检查账号密码，`ECONNREFUSED` 检查 MySQL 服务及端口。迁移错误应修复数据库结构；`INIT_SKIP=true` / `INIT_STRICT=false` 会跳过或掩盖问题，不能作为接手启动方案。
