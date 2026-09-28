# CoPage · 在线协同文档系统

CoPage 是一个以 **Java 后端和实时协同算法**为核心的课程实训项目。用户可以创建富文本文档，通过 WebSocket 同时编辑；服务端使用 OT（Operational Transformation，操作变换）处理并发修改，并将正文、版本和操作日志持久化到 MySQL。

目前优先完善后端正确性、持久化和故障恢复。前端提供基础交互与联调入口，视觉设计和部分业务入口仍在建设中。

> 开发进度更新于 **2026-09-28**。当前开发分支为 [`feat/collab-core`](https://github.com/kilig-21/CoPage/tree/feat/collab-core)，完整进度见[实施计划与验收记录](docs/实施计划.md)。

## 当前能做什么

| 能力 | 当前状态 |
| --- | --- |
| 注册、登录与鉴权 | BCrypt 密码存储、JWT、HTTP/WS 鉴权已实现；登录和注册页面已接接口 |
| 文档管理与权限 | 创建、列表、详情、改名、软删除已实现；区分所有者、可编辑、只读和无权访问 |
| 富文本实时协同 | Quill 2 编辑器、Java Delta/OT、WebSocket ack/op、客户端 pending/buffer 已实现 |
| 多实例协同 | Redis 文档锁、续租、Pub/Sub、在线状态和过期会话清理已实现；远程彩色光标绘制待完善 |
| 持久化与恢复 | MySQL 事务保存正文/revision/操作日志/幂等收据；RabbitMQ 触发快照，巡检补偿漏通知 |
| 搜索与图片 | ES 权限过滤检索、索引重建、MinIO 图片上传接口已实现；搜索页仍为演示数据，编辑器图片按钮待接线 |
| 断线重连 | 历史追赶、稳定 opId 重试和版本缺口检测已实现；未确认编辑保存在当前浏览器，刷新后先由用户确认再恢复；双实例和浏览器双标签页已验收 |

协作者权限读取已实现，成员邀请和权限管理界面尚未提供。项目目前也没有历史版本浏览/一键回滚界面。

## 技术栈

| 层次 | 仓库当前配置 |
| --- | --- |
| 后端 | Java 21、Spring Boot 3.3.5、Spring WebSocket、MyBatis-Plus / JDBC、JWT |
| 协同核心 | Java 实现的 Delta、操作变换、服务端 revision 全序、客户端 pending/buffer 状态机 |
| 前端 | React 18.3、Vite 5.4、Quill 2.0、Ant Design 5、Axios |
| 数据与基础设施 | MySQL 8.4、Redis 7.4、RabbitMQ 3.13、Elasticsearch 8.15、MinIO、Docker Compose |
| 测试 | JUnit 5、Mockito、Node.js 内置测试运行器 |

具体依赖以 [backend/pom.xml](backend/pom.xml)、[frontend/package.json](frontend/package.json) 和 [docker-compose.yml](docker-compose.yml) 为准。

## 一次编辑如何保存

1. 浏览器将 Quill 的改动转换为 Delta，携带 `baseRevision` 和稳定的 `opId` 发送。未收到确认的操作保留在 `pending`，继续输入积累到 `buffer`。
2. 服务端校验权限，在 Redis 文档锁内按历史操作进行 OT 变换，得到下一版本正文。
3. **MySQL 是持久化事实来源。** 正文、revision、操作日志和请求收据在同一事务内写入；重复 opId 会校验原始请求指纹，只补确认，不重复编辑。
4. 服务端更新 Redis 热状态，回复 ack，并通过 Redis Pub/Sub 向其他实例的连接广播。RabbitMQ 通知用于后续快照和索引处理。
5. 重连时，服务端在文档锁内提供快照、连续历史和待确认操作的收据，同时完成会话注册。客户端据此追赶，避免把本地未确认输入直接覆盖掉。

Redis 是热状态和协调层，Elasticsearch 是可重建的检索副本；RabbitMQ 通知不替代同步的 MySQL 正文保存。协同操作的搜索索引采用异步刷新，因此搜索结果可能稍晚更新。

## 本地运行

### 1. 环境与代码

准备 JDK 21、Maven 3.9+、Node.js 20+ 和 Docker Compose v2。Windows 可使用 Docker Desktop；执行 Compose 命令前先启动 Docker。

```powershell
git clone --branch feat/collab-core https://github.com/kilig-21/CoPage.git
Set-Location CoPage
```

已有代码时，直接在项目根目录继续。以下命令以 PowerShell 为例。

### 2. 启动五项基础服务

首次使用时复制示例配置；已有 `.env` 则保留原配置：

```powershell
Copy-Item .env.example .env
docker compose up -d
docker compose ps -a
```

首次启动可能需要等待镜像下载和 Elasticsearch 初始化。MySQL、Redis、RabbitMQ、Elasticsearch 应显示 `healthy`；MinIO 显示运行，`minio-init` 完成后显示 `Exited (0)` 是正常状态。

| 服务 | 本机地址/端口 | 本地默认凭据 |
| --- | --- | --- |
| MySQL | `localhost:3308`，数据库 `collab_doc` | `root / 123456` |
| Redis | `localhost:6380` | 无密码 |
| RabbitMQ | AMQP `5673`；[管理台](http://localhost:15673) | `collab / 123456` |
| Elasticsearch | [localhost:9200](http://localhost:9200) | 本地配置关闭认证 |
| MinIO | [API：9000](http://localhost:9000)；[控制台：9001](http://localhost:9001) | `minioadmin / minioadmin` |

MySQL、Redis 和 RabbitMQ 的宿主机端口已避开常用默认值，避免与其他项目冲突。更改映射时，需同步修改后端连接配置。

MySQL **空数据卷首次初始化**会执行 [schema.sql](backend/src/main/resources/db/schema.sql)，创建表和演示账号；已有数据卷不会重复执行整份 SQL。操作幂等收据表及其指纹字段另有应用启动补建逻辑。

### 3. 启动 Java 后端

在项目根目录的新终端运行：

```powershell
mvn -f backend/pom.xml spring-boot:run
```

后端监听 `http://localhost:8080`。使用 **IntelliJ IDEA** 时，导入 `backend/pom.xml`，设置项目 SDK 为 JDK 21，等待 Maven 同步后运行 `com.school.collab.CollabApplication`。

### 4. 启动前端

在项目根目录的另一个终端运行：

```powershell
npm --prefix frontend ci
npm --prefix frontend run dev
```

打开 [http://localhost:5173](http://localhost:5173)。Vite 已将 `/api` 和 `/ws` 代理到本机 `8080`；前端生产构建仍需部署环境配置相应 HTTP/WebSocket 路由。

### 5. 体验编辑流程

1. 使用 `testA / 123456` 登录，或注册新账号。另一个演示账号是 `testB / 123456`。
2. 新建文档，等待编辑页显示“已连接”，输入正文并尝试富文本格式。
3. 在第二个标签页打开同一文档地址，观察两端编辑。可先使用同一账号体验；不同账号访问需要相应协作者权限，不能仅凭文档链接获得编辑权。
4. 测试短暂断线后重连，观察版本恢复。出现“本地内容已保留”时，先复制备份当前内容再处理错误。

上述是本地体验步骤；自动化覆盖范围和仍待验收的端到端场景见下文及[实施计划](docs/实施计划.md)。

## 配置说明

Compose 读取根目录 `.env`；**Spring Boot 不会自动读取这份 `.env`**。如果修改了容器密码或地址，还需在后端进程环境中设置相应变量，或在 IDEA 运行配置中配置它们。

| 后端变量 | 用途 |
| --- | --- |
| `MYSQL_URL`、`MYSQL_USER`、`MYSQL_PASSWORD` | JDBC 地址、数据库用户和密码 |
| `REDIS_HOST`、`REDIS_PORT` | Redis 连接 |
| `RABBITMQ_HOST`、`RABBITMQ_PORT`、`RABBITMQ_USER`、`RABBITMQ_PASSWORD` | RabbitMQ 连接 |
| `ELASTICSEARCH_URIS` | Elasticsearch 地址 |
| `MINIO_ENDPOINT`、`MINIO_PUBLIC_ENDPOINT` | 后端访问地址、返回给浏览器的可访问地址 |
| `MINIO_ACCESS_KEY`、`MINIO_SECRET_KEY`、`MINIO_BUCKET` | 对象存储凭据与桶 |
| `JWT_SECRET`、`JWT_EXPIRE_HOURS` | JWT 签名密钥与有效期 |

默认值见 [application.yml](backend/src/main/resources/application.yml)。本地 Compose 的 MinIO 桶 `collab` 为公共读，ES 未开启认证；默认账号、密码和 JWT 密钥只用于本地开发。对外部署前需替换凭据、配置网络访问和 HTTPS/WSS，部署验收尚未完成。

可选的第二后端实例：

```powershell
mvn -f backend/pom.xml spring-boot:run "-Dspring-boot.run.arguments=--server.port=8081"
```

两个实例共用相同基础服务。当前 Vite 代理仍指向 `8080`；验证跨实例协同时，测试连接需要分别连到 `8080` 和 `8081`。

## 接口与代码导航

| 接口 | 用途 |
| --- | --- |
| `POST /api/auth/register`、`POST /api/auth/login` | 注册、登录 |
| `GET /api/doc/list`、`POST /api/doc` | 文档列表、创建 |
| `GET /api/doc/{id}`、`PUT /api/doc/{id}`、`DELETE /api/doc/{id}` | 详情、改名、软删除 |
| `GET /api/search?q=...` | 按当前用户权限过滤的标题/正文检索 |
| `POST /api/upload/image` | 图片上传，multipart 字段为 `file`，上限 10 MiB |
| `/ws/collab?token=<JWT>` | WebSocket 协同连接 |

除注册/登录外，业务 HTTP 请求携带 `Authorization: Bearer <JWT>`；浏览器 WebSocket 通过 query token 握手。消息格式、错误码和重连字段见[接口约定](docs/接口约定.md)。

```text
CoPage/
├── backend/
│   ├── src/main/java/com/school/collab/
│   │   ├── auth/          注册登录与账号
│   │   ├── document/      文档管理与权限
│   │   ├── ot/            Delta、应用与操作变换
│   │   ├── collab/        锁、热状态、持久化、版本、WS、在线状态
│   │   ├── search/        搜索与索引重建
│   │   └── storage/       图片上传
│   └── src/test/          后端回归测试
├── frontend/src/
│   ├── pages/             登录、列表、编辑、搜索页面
│   ├── editor/            Quill 接线
│   └── ws/                连接管理、OT 状态机及测试
├── docs/                  协议、数据设计、分工与验收记录
└── docker-compose.yml     本地中间件
```

Java 根包为 `com.school.collab`，其下的 `collab` 子包表示“协同模块”，因此出现 `com.school.collab.collab` 是当前模块划分的结果。

## 测试与当前边界

在项目根目录执行：

```powershell
mvn -f backend/pom.xml test
npm --prefix frontend test
npm --prefix frontend run build
```

最近一次本地验证：后端 **58 个测试**、客户端 **14 个测试**通过，前端生产构建通过。后端包含 OT 固定用例与 1 万组 TP1 随机并发用例、权限边界、锁续租、操作幂等、历史追赶和 join/commit 交错测试。客户端覆盖 pending/buffer、确认丢失、操作未提交、重复确认、消息跳号、历史缺口保护及跨页面草稿序列化。双实例脚本完成 30/30 并发 ack 验收；真实浏览器完成双标签页双向同步、后端中断重连、ACK 丢失关页确认恢复及四标签页并发增删和刷新收敛验收。

这些测试不替代运行中的基础设施和浏览器验收。当前仍需完成：

- CODI-90 的断线恢复和并发编辑验收证据已记录在实施计划中，待人工复核。
- 本地草稿存储在当前浏览器的 `localStorage` 中，含文档正文；共享电脑使用后应退出并按需清理浏览器站点数据。
- 超过 2000 条或历史缺失时的进一步恢复体验；当前保留本地内容并转只读。
- 搜索页、图片按钮、远程光标和协作者管理入口；前端视觉素材与样式后续完善。
- 部署联调、交付材料与 RAG 演进接口边界。当前不提供已验收的线上演示地址。

Vite 构建目前有主包体积提示，后续可做按路由拆包和资源优化。完整任务状态以[实施计划](docs/实施计划.md)为准。

## 常见问题

**容器没有全部 healthy？** 首次启动先等待初始化，再用 `docker compose logs --tail=100 <服务名>` 查看对应服务；`minio-init` 成功退出不需要保持运行。

**改了 `.env`，后端仍然连接失败？** 检查后端环境变量是否同步，特别是 Compose 的 `MYSQL_ROOT_PASSWORD` 对应后端的 `MYSQL_PASSWORD`；本机 MySQL 端口为 `3308`。

**编辑器是只读的？** 首次同步和重连追赶期间会暂时只读；只读协作者始终不可编辑。历史恢复失败时会保留本地内容并提示备份。

**图片链接打不开？** 检查 `MINIO_PUBLIC_ENDPOINT` 是否能从浏览器访问；它不能是仅容器内部可用的主机名。

停止基础服务并保留数据卷：

```powershell
docker compose down
```

重新执行初始化 SQL 不能靠普通重启完成。不要用删除数据卷作为日常重启手段；现有数据应先备份，再进行明确的迁移或重建。

## 项目文档

- [实施计划与验收记录](docs/实施计划.md)：按 Multica CODI-81～CODI-93 顺序推进的小闭环与剩余事项。
- [接口约定](docs/接口约定.md)：HTTP / WebSocket 协议及重连规则。
- [数据库设计](docs/数据库设计.md)：业务表与数据关系；实际建表和升级逻辑以代码为准。
- [分工说明](docs/分工说明.md)：模块职责与协作边界。

开发按小闭环提交；`test` 用于集成，`main` 用于最终交付。当前优先推进后端，接口字段变化应同步协议文档与相关客户端。
