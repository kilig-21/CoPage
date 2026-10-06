# CoPage · 在线协同文档系统

CoPage 是一个以 **Java 后端和实时协同算法**为核心的课程实训项目。用户可以创建富文本文档，通过 WebSocket 同时编辑；服务端使用 OT（Operational Transformation，操作变换）处理并发修改，并将正文、版本和操作日志持久化到 MySQL。

第一阶段本地功能版已完成技术收尾：文档管理、成员权限、实时协同、搜索、图片、模板、历史、回收站及导入导出均可使用。最终范围和验证限制见[第一阶段交付说明](docs/第一阶段交付说明.md)。前端沿用基础样式，视觉素材由负责人后续处理；公网部署作为可选事项。

> 开发进度及最近技术验收更新于 **2026-10-06**。当前开发分支为 [`feat/collab-core`](https://github.com/kilig-21/CoPage/tree/feat/collab-core)，完整进度见[实施计划与验收记录](docs/实施计划.md)，实际使用见[本地使用指南](docs/本地使用指南.md)。

当前回归基线：后端 **122 项**，前端 **89 项**；独立文档副本通过全量、JAR/生产构建、Docker源码构建及双实例和浏览器验收。下方按日期保留的118项等属于历史证据。功能提交按闭环保留在当前分支。最终生产前端已串联双账号协作、原生复制粘贴、历史恢复、实际下载与重导入、回收站、搜索以及真实后端重启无刷新恢复；另已验证其它标签退出/换账号时旧连接关闭、原账号草稿保留和迟到登录响应取消。登录信息保存失败时提供重试提示，不留下新令牌与旧账号名错配，不修改原草稿。恢复弹窗可下载富文本/纯文本草稿并稍后处理；只读时不允许同步，文档撤权、删除或读取失败时仍可保存此账号的本地副本，不取得服务器正文或补交操作。草稿存储失败且退出编辑器时，会提供完整正文的临时备份页，可实际下载、手动复制或导入为独立文档；刷新/关闭仍会失去这份内存副本，需先保存。模拟组合事件、剪贴板事件及真实系统输入法未人工覆盖的范围在记录中单独注明。后文按日期保留的旧测试数量属于历史证据，不代表当前数量；AI/RAG、视觉重做和公网部署继续后置。

## 当前能做什么

| 能力 | 当前状态 |
| --- | --- |
| 注册、登录与鉴权 | BCrypt 密码存储、JWT、HTTP/WS 鉴权；确认密码、内联错误、登录失效提示与返回原页面已接入，失效不删除草稿 |
| 文档模板 | 会议纪要、项目计划、学习笔记；可预览、命名并创建独立文档，初始模板作为版本 0 保留 |
| 文档内查找与替换 | 字面文字、大小写、计数/导航与高亮；单处/全部替换保留首字符格式和图片，可撤销，受同步/权限/容量约束 |
| 独立文档副本 | 列表或编辑器创建自己的副本，保留完整已存正文/格式/图片地址和版本0；只读成员可用，不复制权限或历史 |
| 文档管理与权限 | 创建、标题筛选、详情、改名、软删除；编辑器改名实时同步，分享链接不自动授予权限 |
| 回收站 | 所有者分页查看和恢复误删文档；保留正文、版本与原权限，删除即时停止在线访问；重复恢复不覆盖后续编辑 |
| 打印与浏览器 PDF | 已保存版本的富文本/图片预览，可刷新；只读成员可用，权限及同步校验、缺图确认，浏览器打印或另存为PDF |
| 导入导出 | UTF-8文本和CoPage富文本副本导入为独立文档；可下载纯文本/格式副本，限制1 MiB，图片保留地址；只读成员可导出，撤权/删除后拒绝 |
| 富文本实时协同 | Quill 2 编辑器、Java Delta/OT、WebSocket ack/op、客户端 pending/buffer；本标签撤销/重做、链接并发选区、图片粘贴及组合输入保护已验证 |
| 多实例协同 | Redis 文档锁、续租、Pub/Sub、在线状态和过期会话清理已实现；双账号彩色光标、名字标签、失焦/离开及后端断线后的恢复已通过本地浏览器验收 |
| 持久化与恢复 | MySQL 事务保存正文/revision/操作日志/幂等收据；RabbitMQ 触发快照，巡检补偿漏通知 |
| 搜索与图片 | ES 权限过滤检索、索引重建、MinIO 图片上传接口已实现；搜索页支持关键词、高亮、分页和失败重试；图片按钮上传、另一端实时接收及刷新保留已联合验收 |
| 断线重连 | 历史追赶、稳定 opId 重试和版本缺口检测；超过 2000 条时分批恢复；浏览器离线立即暂停编辑，联网自动重连；未确认编辑保存在当前浏览器，刷新后先由用户确认再恢复 |
| 历史版本 | 分页浏览、富文本预览、所有者恢复和重要版本标记；普通历史按年龄/数量/逻辑容量清理，自动清理默认关闭 |

文档所有者可从列表或编辑器进入“协作者管理”，按已注册用户名添加只读/可编辑成员、切换权限或移除。权限变化实时作用于已经打开的页面；撤权后停止接收正文，有未确认编辑时保留本地草稿。编辑器提供历史版本列表和富文本预览；所有者可标记重要版本、恢复正文，恢复产生新的 revision 并同步到其他在线页面，不倒退版本号。并发编辑使预期版本变化时，恢复请求被拒绝；重复请求只返回原结果。

本地功能版的最终组合检查已通过，范围见[第一阶段交付说明](docs/第一阶段交付说明.md)和[第一阶段上线计划](docs/第一阶段上线计划.md)。该结论不包含视觉重做、AI/RAG或真实公网环境发布。

2026-10-01 负责人授权 Codex 直接执行技术验收并依据结果判定。回归测试、双实例 30/30 并发确认、双账号浏览器双向输入/删除/刷新保留、实际后端中断期间只读，以及无刷新自动重连和继续编辑均通过，CODI-90 的验收缺口已关闭。两端页面存活标记与加载时间在重启前后保持不变；原文档 26 及 testB 编辑权限继续保留。2026-10-03 进一步补齐搜索、成员管理及图片联合操作，完成本地交付；公网部署仍未执行。具体范围和证据见[交付验收记录](docs/交付验收清单.md)。

2026-10-03 后续补齐历史版本和长断线恢复：后端 **85 项**、前端 **24 项**测试通过，前端构建、可执行 JAR 和默认 Docker 源码镜像构建通过。2005 次远端编辑的两种草稿恢复场景均分 8 页收敛；数量、年龄、容量清理及重要版本跨清理保留已验证。自动清理默认关闭，使用范围见[保留策略](docs/历史版本与保留策略.md)。8080 本机和 8082 容器均运行最新后端。

## 技术栈

2026-10-03 离席续办进一步补齐内置模板与注册/登录流程，后端全量 **91 项**、前端 **26 项**通过，前端构建与 JAR/Docker 源码构建成功。真实浏览器完成模板预览/创建、密码确认阻止错误提交、注册/登录、深链返回原文档和失效提示/草稿键保留；新 8082 与 8080 的模板、历史、跨实例及 30/30 并发确认回归通过。默认源码 Docker 镜像与本机 JAR 已更新，详细记录见[最新验收](docs/交付验收清单.md)。

| 层次 | 仓库当前配置 |
| --- | --- |
| 后端 | Java 21、Spring Boot 3.5.16、Spring WebSocket、MyBatis-Plus / JDBC、JWT |
| 协同核心 | Java 实现的 Delta、操作变换、服务端 revision 全序、客户端 pending/buffer 状态机 |
| 前端 | React 18.3、Vite 7.3、Quill 2.0、Ant Design 5、Axios |
| 数据与基础设施 | MySQL 8.4、Redis 7.4、RabbitMQ 3.13、Elasticsearch 8.15、MinIO、Docker Compose |
| 测试 | JUnit 5、Mockito、Node.js 内置测试运行器 |

具体依赖以 [backend/pom.xml](backend/pom.xml)、[frontend/package.json](frontend/package.json) 和 [docker-compose.yml](docker-compose.yml) 为准。

## 日常编辑与分享

列表可按标题筛选，刷新保留筛选条件；`%`、`_` 按普通文字匹配。编辑器和列表都能改名，标题会同步到已打开的协作者页面，自动重连后重新读取最新标题。只读成员不能改名。

“所有修改已保存”表示当前正文没有待确认操作；正在输入、上传、保存和等待同步分别显示。分享入口可复制链接，浏览器拒绝复制时可手动选取；接收者仍须登录并已被所有者授予权限。320/360像素编辑器与列表的操作换行已验证，完整使用流程与最终发布检查继续按计划推进。

## 一次编辑如何保存

1. 浏览器将 Quill 的改动转换为 Delta，携带 `baseRevision` 和稳定的 `opId` 发送。未收到确认的操作保留在 `pending`，继续输入积累到 `buffer`。
2. 服务端校验权限，在 Redis 文档锁内按历史操作进行 OT 变换，得到下一版本正文。
3. **MySQL 是持久化事实来源。** 正文、revision、操作日志和请求收据在同一事务内写入；重复 opId 会校验原始请求指纹，只补确认，不重复编辑。
4. 服务端更新 Redis 热状态，回复 ack，并通过 Redis Pub/Sub 向其他实例的连接广播。RabbitMQ 通知用于后续快照和索引处理。
5. 重连时，服务端在文档锁内提供快照、连续历史和待确认操作的收据，同时完成会话注册。客户端据此追赶，避免把本地未确认输入直接覆盖掉。

Redis 是热状态和协调层，Elasticsearch 是可重建的检索副本；RabbitMQ 通知不替代同步的 MySQL 正文保存。协同操作的搜索索引采用异步刷新，因此搜索结果可能稍晚更新。

## 本地运行

### 1. 环境与代码

准备 JDK 21、Maven 3.9+、Node.js 22.12+ 和 Docker Compose v2。Windows 可使用 Docker Desktop；执行 Compose 命令前先启动 Docker。

```powershell
git clone --branch feat/collab-core https://github.com/kilig-21/CoPage.git
Set-Location CoPage
```

已有代码时，直接在项目根目录继续。以下命令以 PowerShell 为例。

### Windows 日常启动入口

启动 Docker Desktop 后，在项目根目录执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\local.ps1 start
```

需要查询或结束应用时，分别执行相应命令：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\local.ps1 status
# 结束本入口启动的前端和后端，Docker 与数据继续保留
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\local.ps1 stop
```

`start` 检查基础服务，构建当前源码并在后台启动本机 `8080` 后端和 `5173` 前端生产预览；成功后可关闭终端并打开 [CoPage](http://localhost:5173)。首次需要下载镜像和依赖。已有同项目服务会复用，不重复创建进程；修改源码后需先停止原服务再启动。通过 IDEA 或其它终端启动的服务不会被接管或停止，端口属于其它项目时会拒绝启动。

入口从 Compose 的有效配置向后端子进程传递本地地址与凭据，保留已有 `.env`；运行记录、日志和 npm 缓存在被 Git 忽略的 `.copage-local/` 中。仅支持 Windows PowerShell 5.1/PowerShell 7、本地 `default` profile 和 `http://localhost:5173`，不用于公网服务。`-ExecutionPolicy Bypass` 只作用于本次命令，不修改系统执行策略。详细使用和失败处理见[本地使用指南](docs/本地使用指南.md#windows-日常启动入口)。下方保留分窗口的开发方式。

### 2. 启动五项基础服务

首次使用时复制示例配置；已有 `.env` 则保留原配置：

```powershell
if (-not (Test-Path -LiteralPath .env)) { Copy-Item .env.example .env }
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

本地 MySQL **空数据卷首次初始化**会依次执行 [schema.sql](backend/src/main/resources/db/schema.sql) 建表及 [demo-users.sql](backend/src/main/resources/db/demo-users.sql) 创建演示账号；演示昵称以 UTF-8 字节常量写入，避免 Windows shell 导入时乱码。服务器配置只挂载建表脚本，不初始化演示账号。已有数据卷不会重复执行 SQL；若旧演示账号昵称已乱码，须先核对具体记录再定点修复，不能为此删除数据卷。操作幂等收据表及其指纹字段另有应用启动补建逻辑。

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

打开 [http://localhost:5173](http://localhost:5173)。Vite 已将 `/api` 和 `/ws` 代理到本机 `8080`；前端部署时可分别配置后端 HTTP/WebSocket 公网地址。

### 5. 体验编辑流程

1. 使用 `testA / 123456` 登录，或注册新账号。另一个演示账号是 `testB / 123456`。
2. 新建文档，等待编辑页显示“已连接”，输入正文并尝试富文本格式。
3. 所有者点击“协作者管理”，添加已注册的 `testB` 并选“可编辑”；在独立浏览器会话用 testB 登录并打开同一文档链接，观察两端编辑。也可先使用同一账号体验；知道链接不等于获得访问权限。
4. 测试短暂断线后重连，观察版本恢复。出现“本地内容已保留”时，先复制备份当前内容再处理错误。

上述是本地体验步骤；自动化覆盖范围和仍待验收的端到端场景见下文及[实施计划](docs/实施计划.md)。

## 配置说明

Compose 读取根目录 `.env`；**Spring Boot 不会自动读取这份 `.env`**。Windows `local.ps1` 入口会从 Compose 有效配置为新启动的后端传递连接变量；手动或 IDEA 启动时，如果修改了容器密码或地址，还需在后端进程环境中设置相应变量。

| 后端变量 | 用途 |
| --- | --- |
| `MYSQL_URL`、`MYSQL_USER`、`MYSQL_PASSWORD` | JDBC 地址、数据库用户和密码 |
| `REDIS_HOST`、`REDIS_PORT`、`REDIS_PASSWORD` | Redis 连接；密码在 `prod` profile 必填，本地开发不要求 |
| `RABBITMQ_HOST`、`RABBITMQ_PORT`、`RABBITMQ_USER`、`RABBITMQ_PASSWORD` | RabbitMQ 连接 |
| `ELASTICSEARCH_URIS` | Elasticsearch 地址 |
| `MINIO_ENDPOINT`、`MINIO_PUBLIC_ENDPOINT` | 后端访问地址、返回给浏览器的可访问地址 |
| `MINIO_ACCESS_KEY`、`MINIO_SECRET_KEY`、`MINIO_BUCKET` | 对象存储凭据与桶 |
| `JWT_SECRET`、`JWT_EXPIRE_HOURS` | JWT 签名密钥与有效期 |
| `FRONTEND_ORIGIN` | 允许访问 API 与 WebSocket 的前端精确来源；本地默认 `http://localhost:5173` |

默认值见 [application.yml](backend/src/main/resources/application.yml)。前端部署变量见 [frontend/.env.example](frontend/.env.example)：`VITE_BACKEND_HTTP_ORIGIN` 填后端 HTTPS origin，`VITE_BACKEND_WS_ORIGIN` 填同一后端的 WSS origin，均不带 `/api` 或 `/ws` 路径。留空时仍使用当前页面同源地址，适合本地 Vite 代理。Vercel 预览域名确定后，应将该精确域名设为后端 `FRONTEND_ORIGIN`；切勿用任意来源通配代替。Vite 变量会打包进浏览器代码，不能存放密钥。

[frontend/vercel.json](frontend/vercel.json) 为 React Router 的 `/login`、`/docs/:id` 等深层路径回退到 `index.html`。前端必须以 `frontend` 为 Vercel 项目根目录，并在后端公网地址确定后配置上面两个 `VITE_` 变量、重新构建预览。未配置公网后端的预览只能检验静态页面，不代表登录和协同功能可用。

本地 Compose 的 MinIO 桶 `collab` 为公共读，ES 未开启认证；默认账号、密码和 JWT 密钥只用于本地开发。对外部署前需替换凭据、配置网络访问和 HTTPS/WSS，部署验收尚未完成。

正式后端启动时设置 `SPRING_PROFILES_ACTIVE=prod`。此配置要求显式提供 MySQL、Redis、RabbitMQ、Elasticsearch、MinIO 的地址及凭据、`JWT_SECRET`、`FRONTEND_ORIGIN` 和 `MINIO_PUBLIC_ENDPOINT`；缺项或使用演示密钥时会拒绝启动。`FRONTEND_ORIGIN` 必须是无路径的精确 HTTPS 来源，图片公开地址必须使用 HTTPS（可带反向代理路径）。本地 Compose 的 `app` profile 默认仍为开发配置；仅设置 `prod` 不会自动让当前 Compose 具备公网隔离、TLS 和备份能力。

服务器部署另用 [compose.production.yml](compose.production.yml) 与 [.env.production.example](.env.production.example)：独立项目和数据卷、必填正式凭据、非 root 数据库账号、Redis 认证、仅回环开放后端与图片接口。部署及备份步骤见[后端服务器部署说明](docs/后端服务器部署.md)。配置检查用 `node scripts/production-compose-check.mjs`；`--smoke` 验证全新数据库和 Redis，`--full-smoke` 验证完整临时栈及两个 `prod` 后端，`--recovery-smoke` 备份合成文档和图片并恢复到另一组新卷。临时验收使用独立卷，结束后自动清理；公网 TLS 和真实服务器恢复仍待做。

2026-09-30 恢复烟测还验证了空 ES 从 MySQL 自动重建标题/正文索引：所有者与只读协作者可检索，无权账号零命中且不返回摘要；恢复后的历史/收据、快照、图片字节、去重与继续编辑均通过。

[Nginx 模板](deploy/nginx/copage.conf.example) 提供宿主机 HTTPS/WSS 和图片只读入口；`--proxy-smoke` 已用临时生产栈与受信任的本地测试证书验证登录、协同、来源限制、图片读写边界和日志不含 token。需要已有 OpenSSL 与指定官方 Nginx 镜像，准备步骤见[部署说明](docs/后端服务器部署.md)。服务器部署前仍须替换域名/证书，并完成真实公网浏览器验收。

可选的第二后端实例：

```powershell
mvn -f backend/pom.xml spring-boot:run "-Dspring-boot.run.arguments=--server.port=8081"
```

两个实例共用相同基础服务。当前 Vite 代理仍指向 `8080`；验证跨实例协同时，测试连接需要分别连到 `8080` 和 `8081`。

### 可选的后端容器

[backend/Dockerfile](backend/Dockerfile) 以 Java 21 构建带 `exec` 分类的可执行 JAR，再放入非 root 用户运行的 JRE 镜像。本地 `mvn -f backend/pom.xml package` 会生成普通 JAR 和 `target/collab-docs-backend-0.0.1-SNAPSHOT-exec.jar`，需要 `java -jar` 时使用后者；这样运行中的旧 JAR 不会阻碍重打包。Compose 中的 `backend` 使用 `app` profile，普通 `docker compose up -d` 不会额外启动它。在本机验证容器时运行：

```powershell
docker compose --profile app up -d --build backend
docker compose --profile app ps
```

容器把服务映射到本机 `8082`，避免覆盖 IDEA 的 `8080`；它在 Compose 网络内连接 MySQL、Redis、RabbitMQ、ES 和 MinIO。当前 Vite 开发代理仍连 `8080`，因此检查容器应直接访问 `http://localhost:8082/api/...`。此 Compose 为本地开发配置，会向宿主机开放数据库等端口，并保留演示默认凭据，**不可原样暴露到公网**。正式部署还需隔离内部服务、配置持久卷备份、替换所有凭据，并在入口提供 HTTPS/WSS 反向代理。

2026-09-30 已验证上述默认多阶段 Dockerfile 从源码完整构建；生成的容器以 `app` 用户运行，8082 容器与 8080 本机实例通过跨实例广播、断线追赶及 30/30 并发操作确认。公网部署验收仍待完成。

首次拉取 Maven 构建镜像受网络限制时，也可用已打包的 JAR 验证容器运行阶段：

```powershell
mvn -f backend/pom.xml -DskipTests package
docker build -f backend/Dockerfile.prebuilt --build-context artifact=backend/target -t copage-backend:prebuilt backend
docker tag copage-backend:prebuilt collab-docs-backend:latest
docker compose --profile app up -d --no-build backend
$env:COPAGE_SMOKE_PORT_A='8082'
$env:COPAGE_SMOKE_PORT_B='8081'
node scripts/collab-smoke.mjs
```

预构建路径只验证运行时镜像，不能替代默认多阶段 Dockerfile 的源码构建验收。烟测会新建并软删除测试文档，要求 `8081` 已启动且与 `8082` 共用基础服务。

图片接口可单独在本机容器后端执行 `node scripts/image-upload-smoke.mjs`（默认 `127.0.0.1:8082`，可用 `COPAGE_IMAGE_SMOKE_ORIGIN` 指向其他本机 HTTP 端口）。脚本用演示账号检查无 token、伪造图片、前端上传函数及返回的 MinIO 图片内容；它会输出测试图片的精确 URL，并在 MinIO 留下一张 64×64 蓝黄棋盘测试图，需要按该 URL 定位后清理。`--write-fixture` 可在系统临时目录生成同一张浏览器选图用的测试 PNG，使用后请删除。此烟测**不等于**浏览器图片按钮、双端同步或刷新保留验收。

站内副本端到端验收：`node scripts/copy-smoke.mjs`。默认连接8080与8082，两端须使用相同基础服务且新源码后端已启动；可用`COPAGE_COPY_ORIGIN`、`COPAGE_COPY_PEER_ORIGIN`覆盖地址，只有一个本机后端时可将两者都设为它的地址。脚本使用演示账号自建并核对后软删除测试文档，检查完整大正文、私有归属、版本0、搜索、独立编辑和权限边界，不等同于真实浏览器交互验收。

## 接口与代码导航

| 接口 | 用途 |
| --- | --- |
| `POST /api/auth/register`、`POST /api/auth/login` | 注册、登录 |
| `GET /api/doc/list`、`POST /api/doc` | 文档列表、创建 |
| `POST /api/doc/{id}/copy` | 从当前可见文档创建自己拥有的独立副本，返回来源版本 |
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

此前本地验证：2026-10-01 后端 **63 个测试**、客户端 **19 个测试**和前端生产构建通过。后端包含 OT 固定用例与 1 万组 TP1 随机并发用例、权限边界、锁续租、操作幂等、历史追赶和 join/commit 交错测试。客户端覆盖 pending/buffer、确认丢失、操作未提交、重复确认、消息跳号、历史缺口保护、跨页面草稿序列化、图片上传边界及远端光标状态。双实例脚本完成 30/30 并发 ack 验收；此前真实浏览器完成双标签页双向同步、后端中断重连、ACK 丢失关页确认恢复及四标签页并发增删和刷新收敛验收。图片已分别补验本地浏览器按钮选图/保存/刷新，以及两个先连接标签页之间粘贴图片 Delta 的实时广播；双账号远程光标的昵称/颜色、位置变化、失焦/离开和真实后端断线后的恢复已通过本地浏览器验收。

2026-10-03 本地交付复验：后端全量 71 项、前端 22 项及构建通过；另补索引旧候选撤权/删除保护测试并复测搜索 4 项。8080/8081 的成员权限烟测和 30/30 客户端协同烟测通过。真实搜索的标题/正文、高亮安全、10/1 分页、刷新保留页码、空结果和重试，以及双账号界面邀请/实时权限变化均通过。图片按钮选图、上传、另一端无刷新接收及刷新持久保留已在同一轮联合验收。

这些测试不替代每次启动时的环境检查。可选后续工作与现有边界：

- CODI-90 已按负责人授权完成本地技术验收；正式演示前仍须按验收清单重新核对运行环境，公网验收在 CODI-91 中另行完成。
- 本地草稿存储在当前浏览器的 `localStorage` 中，含文档正文；共享电脑使用后应退出并按需清理浏览器站点数据。
- 所需历史已清理或缺失时仍保留本地内容并转只读，需要先复制备份再人工处理；完整的长历史已支持分批恢复。
- 前端视觉素材与样式由负责人后续完善。
- 公网部署由负责人以后按需要决定，当前不提供线上演示地址；本地使用无需部署。
- RAG 仅提供[演进边界](docs/RAG演进边界.md)，当前不调用 AI 模型，不向第三方发送文档；实际问答是后续扩展。

页面按路由加载，React运行时单独缓存；2026-10-04构建不再有500 kB大包提示，生产登录页实际JS下载约673 kB（未压缩），较此前约1.15 MB减少约42%。页面代码下载失败时可手动重新加载。完整任务状态以[实施计划](docs/实施计划.md)为准。

## 常见问题

**容器没有全部 healthy？** 首次启动先等待初始化，再用 `docker compose logs --tail=100 <服务名>` 查看对应服务；`minio-init` 成功退出不需要保持运行。

**改了 `.env`，后端仍然连接失败？** 手动/IDEA 启动时检查后端环境变量是否同步，特别是 Compose 的 `MYSQL_ROOT_PASSWORD` 对应后端的 `MYSQL_PASSWORD`；本机 MySQL 端口为 `3308`。`local.ps1 start` 会传递连接变量，但不会给已有数据库改密码或替换已有服务；配置变化需先核对容器和原运行进程。

**编辑器是只读的？** 首次同步和重连追赶期间会暂时只读；只读协作者始终不可编辑。历史恢复失败时会保留本地内容并提示备份。

**图片链接打不开？** 检查 `MINIO_PUBLIC_ENDPOINT` 是否能从浏览器访问；它不能是仅容器内部可用的主机名。

停止基础服务并保留数据卷：

```powershell
docker compose down
```

重新执行初始化 SQL 不能靠普通重启完成。不要用删除数据卷作为日常重启手段；现有数据应先备份，再进行明确的迁移或重建。

## 项目文档

- [历史版本与保留策略](docs/历史版本与保留策略.md)：版本恢复、重要版本配额和清理开关。

- [实施计划与验收记录](docs/实施计划.md)：按 Multica CODI-81～CODI-93 顺序推进的小闭环与剩余事项。
- [RAG 演进边界草案](docs/RAG演进边界.md)：未来知识检索的数据来源、权限与版本边界；尚未实现 AI 功能。
- [交付验收清单](docs/交付验收清单.md)：演示前重跑的命令、人工步骤及部署交付门槛。
- [答辩演示提纲](docs/答辩演示提纲.md)：按当前实现讲解 OT、持久化与中间件职责，并主动说明未完成项。
- [接口约定](docs/接口约定.md)：HTTP / WebSocket 协议及重连规则。
- [数据库设计](docs/数据库设计.md)：业务表与数据关系；实际建表和升级逻辑以代码为准。
- [分工说明](docs/分工说明.md)：模块职责与协作边界。

开发按小闭环提交；`test` 用于集成，`main` 用于最终交付。当前优先推进后端，接口字段变化应同步协议文档与相关客户端。
