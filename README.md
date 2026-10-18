# Golden Finance API — 生活管理系统后端

> **更新日期**: 2026-10-18

为 Golden Finance 移动端 PWA 应用提供 RESTful API 支持，涵盖用户认证、财务管理、银行卡、工资核算、理财投资、数据备份等完整功能。

## 功能特性

| 模块 | 功能 |
|------|------|
| 🔐 认证 | 管理员首次注册、登录、JWT 认证、Token 刷新、登出、系统锁定 |
| 🔑 安全 | PIN 码安全验证（423 锁定 + 8303 风险路由挑战）、预握手 AES 密钥交换、httpOnly Cookie 认证、APP 签名自检、多层请求校验（防重放/IP/指纹） |
| 💰 账务 | 收支流水管理（收入/支出/转账/信用卡消费/还款）、流水冲正、账户余额 |
| 💳 银行卡 | 借记卡/信用卡管理、账单周期计算、还款管理、分期管理 |
| 📊 报表 | 流水筛选、收支统计、类目占比、月度趋势、负债统计 |
| 📈 理财 | 理财产品登记、净值追踪、收益明细、变动走势 |
| 🏷️ 分类 | 收支分类管理（银行分类走 `/category?type=bank`） |
| ✅ 待办 | 日历日程、提醒管理 |
| 💼 工资 | 工作信息、工资日历、薪资统计、日薪计算 |
| 👤 用户 | 资料更新、邮箱变更、密码修改（均需邮箱验证码） |
| 🏠 资产 | 资产快照登记、固定资产管理 |
| 📉 预算 | 购物/出行/餐饮预算管理 |
| 📁 上传 | 文件/图片上传（Sharp 处理，WebP + PNG 双格式） |
| 📓 日记 | 动态发布/编辑/分享（支持公开链接访问） |
| 📦 数据管理 | 系统检查、备份、导出、导入（登录日志见 `/auth/login-logs`） |
| 🔁 周期支出 | 固定周期支出提醒 |
| 🌍 地理位置 | IP 定位、逆地理编码代理 |
| 🔗 分享 | 动态公开分享（免登录访问） |

## 项目结构

```
api/
├── app.js                       # Express 应用实例（中间件 + 路由挂载 + 启动逻辑）
├── package.json
├── .env / .env.example          # 环境变量配置
├── jest.config.js               # Jest 测试配置
│
├── src/
│   ├── api/                     # 路由层
│   │   └── index.js             # API 路由统一注册（22 个子路由，2026-10-13 冗余接口清理后）
│   │
│   ├── modules/                 # 业务模块（19 个，按功能划分，每个模块含 api/controller/model/rules）
│   │   ├── auth/                # 认证模块（登录/Token/用户信息/用户模型/登录日志）
│   │   ├── security/            # 安全模块（PIN 码状态/设置/验证/修改/风险路由验证）
│   │   ├── account/             # 账务模块
│   │   │   ├── api/             # 路由（流水 index + 余额 balance）
│   │   │   ├── controller/      # 控制器（流水/信用卡/借记卡/余额）
│   │   │   ├── model/           # 数据模型（流水/信用卡/借记卡/余额）
│   │   │   ├── rules/           # 校验规则
│   │   │   └── service/         # 结算服务
│   │   ├── category/            # 分类管理（收支分类；银行分类同路由 type=bank）
│   │   ├── card/                # 银行卡模块（卡片 + 账单 + 还款 + 操作日志）
│   │   ├── user/                # 用户模块（资料/邮箱/密码）
│   │   ├── upload/              # 文件上传模块（Multer + Sharp 图片处理）
│   │   ├── moment/              # 时刻/日记模块
│   │   ├── asset/               # 资产快照与登记模块
│   │   ├── todo/                # 待办日程模块
│   │   ├── work/                # 工作与工资模块
│   │   ├── fixed_asset/         # 固定资产模块（含回收站）
│   │   ├── budget/              # 预算管理模块
│   │   ├── fund/                # 理财投资模块
│   │   ├── recurring/           # 周期支出提醒模块
│   │   ├── dataManager/         # 数据管理模块（备份/导出/导入）
│   │   ├── flow/                # 流水详情/日历模块
│   │   ├── geo/                 # 地理位置代理模块
│   │   └── share/               # 公开分享模块
│   │
│   ├── common/                  # 公共模块
│   │   ├── config/
│   │   │   ├── db.js            # MySQL 连接池（mysql2/promise，连接数 10）
│   │   │   └── jwt.js           # JWT 配置
│   │   ├── middleware/           # 中间件（11 个）
│   │   │   ├── securityCheck.js # 安全请求校验（唯一生效实现：头校验/时间戳+nonce 反重放/IP/指纹）
│   │   │   │                    # ⚠ 不要再新建第二份同名 securityCheck，见 logs/CHANGELOG_2026-09-21.md
│   │   │   ├── authGuard.js     # JWT / httpOnly Cookie 认证守卫
│   │   │   ├── cookieParser.js  # Cookie 解析（安全整改 P0-5，2026-10-08）
│   │   │   ├── pinSecurityGuard.js # PIN 安全守卫（拦截锁定会话）
│   │   │   ├── pinLockGuard.js  # PIN 失败次数锁定 + 8303 风险路由挑战
│   │   │   ├── authSecurityData.js # 前端加密数据解密
│   │   │   ├── accountLockCheck.js # 账户锁定检查
│   │   │   ├── emailCodeRateLimit.js # 邮箱验证码频率限制
│   │   │   ├── appSignatureGuard.js # APP 签名自检（P1-28：x-app-sign-sha256）
│   │   │   ├── errorMiddleware.js # 统一错误处理（404 + 500）
│   │   │   └── validate.js      # Joi 校验中间件
│   │   └── utils/               # 工具
│   │       ├── crypto.js        # 加密工具
│   │       ├── idUtils.js       # ID 生成
│   │       ├── mailer.js        # Nodemailer 邮件发送
│   │       └── shareToken.js    # 分享 Token 生成
│   │
│   └── init/                    # 系统初始化
│       ├── index.js             # 初始化入口（全量/增量两种模式）
│       ├── autoDatabase.js      # 数据库自动创建
│       ├── schemaSync.js        # 表结构同步
│       └── migrationRunner.js   # 增量迁移执行器
│
├── mysql/                       # 数据库
│   ├── live.sql                 # 完整数据库结构（当前版本）
│   ├── live_V1.0.0.sql          # V1.0.0 基线
│   ├── live_old_version.sql     # 旧版本备份
│   ├── migrations/              # 增量迁移脚本目录
│   └── backups/                 # 初始化时的全量备份输出
│
├── data/                        # 数据存储
│   ├── uploads/                 # 上传文件
│   └── sql/                     # SQL 数据文件
│
├── public/                      # 静态资源（管理后台页面）
│   ├── admin-register.html/js   # 管理员注册页面
│   ├── database-init.js         # 数据库初始化脚本
│   └── uploads/                 # 公开上传资源
│
├── tests/                       # 测试
│   ├── setup.js                 # 测试环境配置
│   ├── README.md                # 测试说明文档
│   └── unit/                    # 单元测试（当前仅此目录；`tests/integration` 尚未建立）
│
├── scripts/                     # 脚本目录
└── logs/                        # 变更日志
    ├── CHANGELOG_2026-05-28.md
    ├── CHANGELOG_2026-05-29.md
    ├── CHANGELOG_2026-05-31.md
    ├── CHANGELOG_2026-06-28.md
    ├── CHANGELOG_2026-09-14.md
    ├── CHANGELOG_2026-09-20.md
    └── CHANGELOG_2026-09-21.md
```

## API 路由总览

所有 API 挂载在 `/api/v1` 下，需经过 `securityCheck` 中间件校验（公开分享和静态资源除外）。

> 🔒 2026-10-13（冗余接口清理）：`/bank`、`/bank-category`、`/resource`、`/database` 整组删除，
> `/dashboard` 从未挂载（银行分类改走 `/category?type=bank`，文件资源改走 `/upload`）。
> 下方仅列**当前实际挂载**的 22 个前缀，Node 与 Go 两端保持一致。

| 前缀 | 模块 | 主要功能 |
|------|------|---------|
| `/api/v1/auth` | auth | 首次管理员注册、登录、用户信息、Token 刷新、登出、系统锁定、登录日志 |
| `/api/v1/security` | security | PIN 码状态/设置/验证/修改、风险路由验证 |
| `/api/v1/account` | account | 收支流水 CRUD、冲正、转账 |
| `/api/v1/accountBalance` | account | 账户余额管理（虚拟账户同步） |
| `/api/v1/category` | category | 收支分类 CRUD（含银行分类 `?type=bank`） |
| `/api/v1/card` | card | 银行卡 CRUD、卡片流水查询 |
| `/api/v1/card/bill` | card | 信用卡账单 CRUD、账单流水明细 |
| `/api/v1/card/repay` | card | 信用卡还款 CRUD |
| `/api/v1/user` | user | 资料更新、邮箱变更、密码修改（均需邮箱验证码） |
| `/api/v1/upload` | upload | 文件/图片上传（支持多文件） |
| `/api/v1/moment` | moment | 动态/日记 CRUD |
| `/api/v1/asset` | asset | 资产快照与登记 |
| `/api/v1/todo` | todo | 待办日程 CRUD |
| `/api/v1/work` | work | 工作信息、工资日历、薪资统计、日薪 |
| `/api/v1/fixedAsset` | fixed_asset | 固定资产 CRUD、回收站 |
| `/api/v1/budget` | budget | 购物/出行/餐饮预算管理 |
| `/api/v1/fund` | fund | 理财产品登记、净值追踪、收益明细 |
| `/api/v1/recurring` | recurring | 周期固定支出提醒 |
| `/api/v1/flow` | flow | 流水详情查询、日历聚合 |
| `/api/v1/data-manager` | dataManager | 系统检查/备份/导出/导入 |
| `/api/v1/geo` | geo | IP 定位、逆地理编码代理 |
| `/api/v1/share` | share | 公开分享查看（免登录，白名单放行） |
| `/api/public` | 静态资源 | 公开静态文件服务（上传资源） |

## 认证与安全体系

### 认证流程

```
客户端                          服务端
  │                               │
  ├── POST /auth/handshake ──────►│ 交换 AES 密钥（预握手）
  │◄─────── { aesKey, iv } ──────┤
  │                               │
  ├── POST /auth/login (AES加密)─►│ 安全头校验 → JWT 签发
  │◄─────── { token } ────────────┤
  │                               │
  ├── 业务请求 (JWT + 安全头) ────►│ authGuard → pinSecurityGuard
  │◄─────── 数据 ──────────────────┤
  │                               │
  │  (若返回 423)                 │
  ├── POST /security/pin/verify ─►│ PIN 验证解锁
  │◄─────── 200 OK ───────────────┤
```

### 安全特性

| 层级 | 机制 | 说明 |
|------|------|------|
| 传输加密 | AES 预握手 | 首次请求交换 AES 密钥，后续 POST/PUT/DELETE 自动加解密。**仅通道混淆，无认证性**（任意 `fp` 均可换取密钥） |
| 请求校验 | securityCheck | 校验 X-Requested-With、时间戳（±2min）、一次性 nonce（防重放）、IP 合法性、指纹一致性。**不含请求签名**（历史文档所称"MD5 签名"从未生效，详见 `logs/CHANGELOG_2026-09-21.md`） |
| 身份认证 | JWT Token / httpOnly Cookie | Bearer 头优先，缺失时回落 httpOnly Cookie（P0-5，2026-10-08）；authGuard 自动验证 |
| APP 完整性 | 签名自检 | `APP_SIGN_SHA256` 白名单校验 `x-app-sign-sha256`（P1-28）；未配置=守卫不启用，`strict` 模式连浏览器也要求带头 |
| 反代信任 | TRUST_PROXY_HOPS | 只按声明的层数取 `X-Forwarded-For`，避免伪造 `req.ip` 绕过按 IP 的风控与限流（P1-18，2026-10-08） |
| 令牌吊销 | `password_changed_at` + `TOKEN_MAX_SESSION_DAYS` | 改密后旧令牌刷新被拒；会话超过 N 天（默认 90）强制重登 |
| 敏感操作 | PIN 码 | 6 位数字 PIN 码二次验证，失败锁定；风险路由返回 8303 挑战 → `/security/pin/route-verify` 换一次性 token 后原请求重发 |
| PIN 守卫容错 | fail-closed | 守卫内部异常且用户已设置 PIN 时拒绝请求（503），不再静默放行 |
| 重放自愈 | 业务码 `8401` | nonce 复用返回 `400 + {code:8401, retryable:true}`（独立码，不与其它 400 混用），前端识别后**自动重发一次**，用户无感；重发仍失败才提示 |
| 风控可灰度 | `PIN_RISK_MODE` | 严格 / 观测 / 关闭 三档，`.env` 可切、无需回滚代码；非严格模式启动打印告警 |
| 会话锁定 | 423 状态码 | 手动锁定/自动锁定后返回 423，前端引导 PIN 验证 |
| 密钥强度 | secretGuard | 生产环境密钥缺失/过短/占位值 → 拒绝启动（fail-fast），杜绝静默回退到硬编码常量 |
| 密码存储 | bcryptjs | 单向哈希加密存储 |
| 安全头 | Helmet | 自动添加安全相关 HTTP 头 |
| CORS | 白名单 | 生产仅 `FRONTEND_URL` + `CORS_EXTRA_ORIGINS`；内网/localhost 调试源仅非生产放行 |
| 输入校验 | Joi | 请求参数 Schema 校验 |
| 并发保护 | 事务 + 行锁 | `SELECT ... FOR UPDATE` 防止竞态（冲正/还款） |

### 认证接口 (`/api/v1/auth`)

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/auth/handshake` | 否 | 预握手，交换 AES 密钥 |
| POST | `/auth/login` | 否 | 用户登录（前置 Joi 校验 + 账户锁定检查） |
| GET | `/auth/check-admin` | 否 | 检查是否已存在管理员（首次注册前调用） |
| POST | `/auth/admin-register` | 否 | 管理员首次注册（仅可注册一次） |
| POST | `/auth/refresh` | 否 | 刷新 Token |
| POST | `/auth/logout` | 否 | 登出（**刻意不挂 authGuard**：令牌已失效时也要能幂等登出） |
| GET | `/auth/me` | JWT | 获取当前用户信息 |
| POST | `/auth/lock-system` | JWT | 锁定当前会话 |
| GET | `/auth/login-logs` | JWT | 获取当前用户登录日志（最近 30 条） |

> ⚠️ `POST /auth/register` **未挂载**（`src/modules/auth/api/index.js:13` 为注释行），
> 用户注册已由「管理员首次注册 + 后台建号」取代；历史文档中列出该接口属过期信息。

### 安全接口 (`/api/v1/security`)

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/security/pin/check` | JWT | 获取 PIN 状态 |
| POST | `/security/pin/verify` | JWT | 验证 PIN 码 |
| POST | `/security/pin/route-verify` | JWT | 风险路由 PIN 验证，成功后返回一次性 token（`x-route-verify-token`） |
| POST | `/security/pin/set` | JWT | 设置 PIN 码 |
| POST | `/security/pin/change` | JWT | 修改 PIN 码 |
| POST | `/security/pin/reset` | JWT | 重置 PIN 码（已挂载，前端暂未调用） |
| POST | `/security/risk-report` | JWT | 设备风险信号上报（纯信号落库，不拒服务） |

### 用户接口 (`/api/v1/user`)

> 该模块所有路由均先挂 `authGuard`（`router.use(authGuard)`）。

| 方法 | 路径 | 说明 |
|------|------|------|
| PUT | `/user/profile` | 更新用户资料 |
| POST | `/user/email/send-code` | 发送邮箱验证码（频率限制中间件 + Joi 剥离伪造字段） |
| PUT | `/user/email/change` | 修改邮箱（需验证码） |
| PUT | `/user/password/change` | 修改密码（需邮箱验证码） |

## 银行卡业务规则

### 账单周期计算

- **账单周期**: 账单日(bill_day)次日 ~ 次月账单日前一天
- **账单月归属**:
  - 消费日期 **≤** 账单日 → 当月账单（账单日当天仍属当月）
  - 消费日期 **>** 账单日 → 下月账单（开启新周期）
- **还款日**: 账单月的下一月 repayDay
- **逾期判定**: 当前日期 > repay_date 且 need_repay > 0

### 信用卡冲正规则

- 消费冲正: 原支出 → 冲正收入 + 恢复账单额度
- 还款撤销: 原还款 → 冲正收入（恢复余额）+ 软删除还款记录 + 全量重建账单
- 账单周期隔离: 冲正/还款检查仅限同一 `bill_month`，不跨周期误拦
- 并发保护: 事务内 `SELECT ... FOR UPDATE` 行锁，防止重复冲正

### 举例说明（账单日=12号，还款日=次月6号）

| 消费日期 | 归属账单月 | 出账日 | 还款日 |
|---------|-----------|--------|--------|
| 4月1日 ~ 4月12日 | 4月 | 4月12日 | 5月6日 |
| 4月13日 ~ 4月30日 | 5月 | 5月12日 | 6月6日 |

## 技术栈

| 类别 | 技术 | 用途 |
|------|------|------|
| 框架 | Express 4.19.2 | HTTP 服务框架 |
| 数据库 | MySQL (mysql2/promise) | 连接池，连接数 10 |
| 认证 | jsonwebtoken 9.0.2 | JWT Token 签发与验证 |
| 密码加密 | bcryptjs 2.4.3 | 单向哈希密码存储 |
| 安全头 | helmet 7.1.0 | HTTP 安全头 |
| 跨域 | cors 2.8.5 | 白名单 CORS 配置 |
| 日志 | morgan 1.10.0 | HTTP 请求日志 |
| 校验 | joi 17.9.2 | 请求参数 Schema 校验 |
| 文件上传 | multer 1.4.5-lts.1 | 多文件上传中间件 |
| 图片处理 | sharp 0.33.0 | WebP 转换 + 缩略图生成 |
| 环境变量 | dotenv 16.4.5 | .env 配置加载 |
| 邮件 | nodemailer 6.9.13 | 邮件发送 |
| 数据库备份 | mysqldump 3.2.0 | 数据库导出 |
| 压缩 | adm-zip / archiver | ZIP 归档 |
| 测试 | Jest 29.7.0 | 单元测试 / 集成测试 |
| 热重载 | nodemon 3.1.0 | 开发模式自动重启 |
| 其他 | nanoid, uuid, crypto-js, dayjs, axios | ID 生成、加密、日期处理 |

## 快速开始

### 安装依赖

```bash
npm install
```

### 配置环境变量

```bash
cp .env.example .env
```

主要配置项:

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务端口（`app.js` 默认 3001，**本仓库 `.env` 为 666**，与 Go 版 7777 隔离） | 3001 |
| `NODE_ENV` | 运行环境（`production` 会触发密钥 fail-fast 与错误脱敏） | development |
| `DB_HOST` / `DB_PORT` | 数据库主机 / 端口 | localhost / 3306 |
| `DB_USER` / `DB_PASSWORD` | 数据库用户 / 密码 | root / (空) |
| `DB_NAME` | 数据库名 | live |
| `TRUST_PROXY_HOPS` | 反代层数：决定 `req.ip` 取 XFF 的第几段（直连填 0，1 层 nginx 填 1；留空=1） | 1 |
| `JWT_SECRET` | JWT 签名密钥。**生产必填**，≥32 位随机串，占位值/过短会拒绝启动 | (必填) |
| `JWT_EXPIRES_IN` | Access Token 有效期 | 7d |
| `JWT_REFRESH_EXPIRES_IN` | Refresh Token 有效期 | 30d |
| `SHARE_TOKEN_SECRET` | 分享 token 密钥，未配置时回退 `JWT_SECRET` | (可选) |
| `FIELD_ENCRYPT_KEY` | 字段级加密密钥（device_crypto 握手行 aes_key 落库加密），未配置时从 `SHARE_TOKEN_SECRET` 派生 | (可选) |
| `RSA_KEY_FILE` | RSA 密钥对持久化路径 | `data/rsa-keys.json` |
| `BCRYPT_SALT_ROUNDS` | bcrypt 盐轮数（10 约 100–200ms，生产建议 12–15） | 10 |
| `FRONTEND_URL` | 前端地址 | (必填，用于 CORS) |
| `CORS_EXTRA_ORIGINS` | 额外允许的跨域来源，逗号分隔（生产用） | (空) |
| `APP_NAME` | 应用名称（邮件标题等） | 生活管理系统 |
| `EMAIL_HOST` / `EMAIL_PORT` | 邮件服务器（465=SSL，587=STARTTLS） | smtp.gmail.com / 587 |
| `EMAIL_USER` / `EMAIL_PASS` | 发信账号 / 授权码 | (空) |
| `AMAP_KEY` | 高德 Web 服务 Key（IP 定位、逆地理编码） | (空) |
| `IPINFO_TOKEN` | ipinfo.io Token（IP 定位国际回退，可选） | (空) |
| `REQUIRE_CLIENT_NONCE` | 设为 `true` 强制要求 `x-client-nonce` 头（三端已同步携带，**本仓库 `.env` 已开启**） | false |
| `TOKEN_MAX_SESSION_DAYS` | 会话最长天数，超期强制重登 | 90 |
| `INIT_ENABLE` | 启用全量初始化 | false |
| `INIT_SKIP` | 跳过初始化 | false |
| `INIT_ADMIN_USER` / `INIT_ADMIN_PASS` / `INIT_ADMIN_EMAIL` | 初始管理员账户（仅 `INIT_ENABLE=true` 时生效） | admin / (必填) / admin@example.com |
| `INSTALLMENT_GRACE_DAYS` | 分期宽限天数（超期未入账则作废） | 30 |
| `INSTALLMENT_SCAN_INTERVAL_MS` | 分期定时扫描间隔（毫秒） | 6 小时 |

#### APP 签名自检（P1-28）

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `APP_SIGN_SHA256` | APK 签名证书 SHA-256 白名单（64 位 hex，逗号分隔可多签共存）。未配置=守卫不启用 | (空) |
| `APP_SIGN_ENFORCE` | `loose`=只校验带头的请求（兼容浏览器）/ `strict`=连浏览器也要求带头（仅纯 APP 部署） | loose |

#### 安全风控开关（均有安全默认值，不改即为最严格）

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PIN_RISK_MODE` | PIN 风控模式：`enforce` 严格拦截 / `observe` 只告警不拦截 / `off` 完全关闭 | **enforce** |
| `PIN_RISK_FREQ_LIMIT` | 全局频率上限（次） | 60 |
| `PIN_RISK_FREQ_WINDOW` | 全局频率窗口（秒） | 60 |
| `PIN_RISK_SENSITIVE_LIMIT` | 敏感操作（POST/PUT/PATCH/DELETE）上限（次） | 10 |
| `PIN_RISK_SENSITIVE_WINDOW` | 敏感操作窗口（秒） | 60 |
| `PIN_PASS_WINDOW` | PIN 验证成功后的放行窗口（秒） | 30 |
| `PIN_NONCE_MODE` | nonce 校验模式：`enforce` 拦截 / `observe` 只告警 / `off` 关闭 | **enforce** |

> - 非 `enforce` 模式会在启动日志打印显式告警，避免「以为在严格模式、实际没生效」。
> - `observe` 模式的留痕检索关键字：`[pinSecurityGuard][observe]`、`[securityCheck][observe]`。
> - `PIN_RISK_*` / `PIN_PASS_WINDOW` 的默认值与历史实现完全一致，不配置即无行为变化。

> ⚠️ `APP_SECURITY_SALT` 已于 2026-09-21 移除：它只被一份**无人加载的死代码**引用，
> 运行时从未校验过请求签名。详见 `logs/CHANGELOG_2026-09-21.md`。
> 生成强随机密钥：`openssl rand -hex 32`

### 创建数据库

```sql
CREATE DATABASE live DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

### 导入数据库结构

```bash
mysql -u root -p live < mysql/live.sql
```

### 启动服务

```bash
# 开发模式（nodemon 热重载）
npm run dev

# 启动（package.json 中 start 与 dev 相同，均走 nodemon，非生产守护）
npm start
```

> 生产环境建议直接用 `node app.js` 交给进程守护（pm2/systemd），不要用 nodemon。

服务启动后自动执行:
1. 数据库连接检测（输出版本和服务器时间）
2. 系统初始化（增量迁移 / INIT_ENABLE=true 时全量）
3. 监听端口输出启动信息

默认访问: `http://localhost:<PORT>/api/v1`（`app.js` 兜底 3001；**本仓库 `.env` 已改为 666**，与 Go 版 7777 隔离，两端可并行对照）

### 运行测试

```bash
npm test                # 运行全部测试（jest）
npm run test:unit       # 仅单元测试（tests/unit）
npm run test:integration # 集成测试（脚本已定义，但 tests/integration 目录尚未建立）
npm run test:coverage   # 生成覆盖率报告
```

## 系统初始化机制

系统启动时通过 `src/init/` 模块自动处理数据库初始化:

| 模式 | 环境变量 | 行为 |
|------|---------|------|
| 增量 | 默认 | 执行 `migrations/` 目录下未执行过的迁移脚本 |
| 全量 | `INIT_ENABLE=true` | 先执行全量 SQL 备份，再同步表结构，最后跑迁移 |
| 跳过 | `INIT_SKIP=true` | 完全跳过初始化，用于排查问题 |

## 代码架构约定

### 模块分层

每个业务模块遵循统一的三层结构:

```
modules/{模块名}/
├── api/index.js        # 路由注册（Express Router）
├── controller/index.js  # 控制器（请求处理、参数提取、响应格式化）
├── model/index.js       # 数据模型（SQL 查询、事务管理）
└── rules/index.js       # 校验规则（Joi Schema）
```

### 统一响应格式

所有接口使用 `res.say(message, statusCode)` 方法统一响应:

```json
{
  "status": 200,
  "message": "操作成功",
  "data": { ... }
}
```

错误时 `message` 为错误描述字符串，生产环境 5xx 错误统一脱敏为 "服务器内部错误"。

---

## 更新日志

| 日期 | 内容 |
|------|------|
| 2026-10-13 | 冗余接口清理：整组删除 `/bank`、`/bank-category`、`/resource`、`/database`，并删除 `/user/settings` 等零散接口（启用路由 192→165）；`/user/email/send-code` 补上 Joi validator。见 `src/api/index.js:50-52` 注释 |
| 2026-10-12 | 修复 httpOnly Cookie 通道下 PIN 风控对 web **静默失效**（`pinSecurityGuard` 改认 Cookie 令牌，与 `extractToken` 双通道对齐） |
| 2026-10-08 | P0-5：认证 token 改为 httpOnly Cookie（新增 `cookieParser.js`）；P1-18：`TRUST_PROXY_HOPS` 收敛 XFF 信任（见 `src/common/middleware/cookieParser.js`、`app.js:59-65`） |
| 2026-09-21 | [安全审计：APP 接入站点信任模型 + securityCheck 死代码与签名能力缺失](logs/CHANGELOG_2026-09-21.md)（**无代码改动**，见根目录 [APP-接入站点安全设计.md](../APP-接入站点安全设计.md)） |
| 2026-09-20 | [PIN 安全验证：锁定绕过修复 + 前端策略同步至 webview-APP 与 APP](logs/CHANGELOG_2026-09-20.md) |
| 2026-09-14 | [Vant 组件安卓原生复刻工程（APP/）](logs/CHANGELOG_2026-09-14.md) |
| 2026-06-28 | [多项模块优化与修复](logs/CHANGELOG_2026-06-28.md) |
| 2026-05-31 | [信用卡冲正 + 账单一致性修复](logs/CHANGELOG_2026-05-31.md) |
| 2026-05-29 | [定位模块 + 邮箱脱敏](logs/CHANGELOG_2026-05-29.md) |
| 2026-05-28 | [新增模块 + 文档补全](logs/CHANGELOG_2026-05-28.md) |
