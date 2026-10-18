# live API（Go 版）

生活记账与资产管理系统的后端 API 服务，使用 Go 实现，编译为单二进制运行，通过 HTTP 提供 REST 接口（前缀 `/api/v1`），面向 Web / 移动端 / 原生 APP 三端。

## 功能范围

- **认证与安全**：JWT 登录与自动续期、邮箱验证码、PIN 二次验证、请求防重放（nonce）、RSA 安全键盘字符级加密、APP 签名自检、请求频率风控
- **记账**：借记/信用账户、卡片与卡池、账单与还款、预算、流水日历、周期支出与分期、分类管理
- **资产**：固定资产、理财、工作工资
- **内容**：动态/日记、待办事项、公开分享链接
- **系统**：数据备份与导入导出、文件上传与缩略图、地理位置解析

## 技术栈

| 项 | 选型 |
|---|---|
| 语言 / HTTP | Go，标准库 `net/http` + `ServeMux`（无 Web 框架） |
| 数据库 | MySQL 8（`go-sql-driver/mysql`，连接池） |
| 认证 | JWT（HS256）、bcrypt 密码哈希 |
| 加密 | RSA-2048（PKCS1v15）、AES-256-GCM |
| 其他 | `x/crypto`、`x/image` |

## 快速开始

1. 准备 MySQL 实例，创建数据库（如 `live_dev`）。
2. 复制环境变量模板并按需填写：

```bash
cp .env.example .env
```

至少需确认数据库连接（`DB_*`）与密钥（`JWT_SECRET`，建议 ≥32 位随机串：`openssl rand -hex 32`）。

3. 构建与启动：

```bash
go build -o api-go .
./api-go
```

默认监听 `:7777`（可用 `PORT` 覆盖），接口地址 `http://localhost:7777/api/v1`。

4. 首次部署可开启自动初始化（建表 + 创建管理员），初始化完成后自动关闭：

```ini
INIT_ENABLE=true
INIT_ADMIN_USER=admin
INIT_ADMIN_PASS=your_secure_password
INIT_ADMIN_EMAIL=admin@example.com
```

## 目录结构

```
.
├── main.go                  # 入口：加载 .env → 密钥自检 → 连接探测 → 启动钩子 → 监听
├── internal/
│   ├── config/              # 环境变量加载与密钥强度自检
│   ├── db/                  # MySQL 连接池与事务封装
│   ├── resp/                # 统一响应与请求体解析
│   ├── sec/                 # JWT / RSA / AES-GCM 加解密
│   ├── idgen/ cur/ tim/     # ID 生成、金额换算、时区时钟
│   ├── mw/                  # 中间件：鉴权、PIN 风控、防重放、签名、限流
│   ├── srv/                 # 中间件链与模块装配
│   └── mod/                 # 业务模块（auth、account、card、budget、todo 等）
├── public/                  # 静态资源与上传目录（运行时）
└── data/                    # 上传暂存与备份输出（运行时）
```

## 配置要点

- 全部配置通过环境变量提供，完整清单与说明见 `.env.example`；`.env` 位于运行目录，不入版本库。
- 生产环境（`NODE_ENV=production`）下 `JWT_SECRET`、`SHARE_TOKEN_SECRET` 为弱密钥时会**拒绝启动**。
- PIN 风控与防重放计数为单进程内存态，多实例部署需外置共享存储（如 Redis）。
- 数据备份依赖 `mysqldump`，图片缩略图优先使用 `cwebp`，缺失时按源格式输出。
- `RSA_KEY_FILE` 用于持久化 RSA 密钥，多实例需指向同一共享文件。

## 测试

```bash
go test ./...
```

包含路由契约测试与各模块单元测试。

## 说明

- 接口请求需携带客户端时间戳与 nonce 头（详见安全配置项 `REQUIRE_CLIENT_NONCE`）。
- 该项目为服务端实现，不含前端代码；前端需单独部署并配置 `FRONTEND_URL` 以放行跨域来源。
