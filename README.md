# 在线协同文档系统

一个用于课程实训的在线协同文档系统基底。后端使用 Spring Boot 3 / Java 21，前端使用 React 18 / Vite；协同编辑核心将基于 Quill Delta 和 WebSocket 实现。

## 运行前提

- JDK 21
- Maven 3.9+
- Node.js 20+（本机 Node 24 亦可）
- Docker Desktop 已启动

## 一键启动中间件

```powershell
Copy-Item .env.example .env
docker compose up -d
docker compose ps
```

> ⚠️ **端口注意**：本项目的容器端口都**故意错开了常用端口**，以免和本机其他项目（如 `ai-commerce` 用的
> 3307 / 6379 / 5672 / 15672）撞车。**不要**把它们改回 3306 / 6379 / 5672 / 15672。

所有服务由 Docker Compose 统一管理。首次启动会执行 [schema.sql](backend/src/main/resources/db/schema.sql)，并建立 `testA`、`testB` 两个演示账号；两者初始密码均为 `123456`。

| 服务 | 地址 | 默认账号 |
| --- | --- | --- |
| MySQL | `localhost:3308`（库 `collab_doc`） | `root / 123456` |
| Redis | `localhost:6380` | 无 |
| RabbitMQ 管理台 | http://localhost:15673 | `collab / 123456` |
| Elasticsearch | http://localhost:9200 | 无认证（仅本地开发） |
| MinIO API | http://localhost:9000 | `minioadmin / minioadmin` |
| MinIO 控制台 | http://localhost:9001 | `minioadmin / minioadmin` |

## 启动应用

在两个独立终端执行：

```powershell
cd backend
mvn spring-boot:run
```

```powershell
cd frontend
npm install
npm run dev
```

前端默认地址为 http://localhost:5173，`/api` 和 `/ws` 已代理到后端 `8080`。

## 项目分工边界

- 负责人：`backend/**/ot`、`backend/**/collab`、`frontend/src/editor`、`frontend/src/ot`、`frontend/src/ws`、`frontend/src/pages/Editor.jsx`
- 队友 A：用户、文档 CRUD、搜索、上传、MQ，以及登录/列表/搜索页面接真实接口
- 队友 B：`docs/qa`、测试记录、README 完善与答辩材料

接口字段在 [接口约定.md](docs/接口约定.md) 定稿后应保持兼容；变更只能新增字段，已有字段改动需同步全组。

## 常用检查

```powershell
docker compose ps
cd backend; mvn test
cd frontend; npm run build
```

停止容器但保留数据：

```powershell
docker compose down
```

> 若要重新执行初始化 SQL，需要删除指定 Docker 卷后重新 `up`；这会清除本地开发数据，请先确认。
