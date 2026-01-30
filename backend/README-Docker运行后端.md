# 使用 Docker 启动后端 + MySQL（先不管前端）

本说明教你在 **Windows + Docker Desktop + Cursor** 环境下，一条命令跑起：

- MySQL 数据库（容器内）
- Node.js 后端（容器内）

## 一、准备工作

1. 安装 **Docker Desktop for Windows**
   - 官网下载：`https://www.docker.com/products/docker-desktop/`
   - 安装过程中如果提示启用 WSL2，按提示操作即可
   - 安装完成后运行 Docker Desktop，确保右下角图标是 **绿色**（Running）

2. 打开 Cursor，打开你的项目目录：
   - `c:\wwwroot\index`

## 二、关键文件说明

已经为你创建了这些文件：

```text
c:\wwwroot\index\
  docker-compose.yml           # 后端 + MySQL 的组合编排
  backend\
    Dockerfile                 # 后端镜像构建规则
    .env.docker                # 后端在容器里用的环境变量
    src\...                    # 后端代码
```

### 2.1 docker-compose.yml

里面定义了两个服务：

- `db`：MySQL 8.0 容器
- `backend`：Node.js 后端容器

默认配置片段（简化）：

```yaml
services:
  db:
    image: mysql:8.0
    environment:
      MYSQL_ROOT_PASSWORD: root_password_here
      MYSQL_DATABASE: ip_proxy_platform
    ports:
      - "3306:3306"

  backend:
    build:
      context: ./backend
      dockerfile: Dockerfile
    depends_on:
      - db
    env_file:
      - ./backend/.env.docker
    ports:
      - "3000:3000"
```

### 2.2 backend/.env.docker

给容器里的后端用的数据库连接配置：

```env
DB_HOST=db        # 注意：这里是 db，对应 docker-compose 里的服务名
DB_PORT=3306
DB_USER=root
DB_PASSWORD=root_password_here
DB_NAME=ip_proxy_platform
```

> 使用前你需要改成自己的密码。

## 三、第一次使用前要修改的地方（很重要）

### 3.1 修改 MySQL root 密码（两处要一致）

1. 打开 `docker-compose.yml`，找到：

```yaml
MYSQL_ROOT_PASSWORD: root_password_here
```

改成你想要的密码，例如：

```yaml
MYSQL_ROOT_PASSWORD: MyRootPwd123!
```

2. 打开 `backend/.env.docker`，找到：

```env
DB_PASSWORD=root_password_here
```

改成 **同样的密码**：

```env
DB_PASSWORD=MyRootPwd123!
```

只要这两处一致，后端就能连上容器里的 MySQL。

### 3.2 可选：修改 JWT 密钥

在 `backend/.env.docker` 里：

```env
JWT_SECRET=change_this_to_a_long_random_string
```

建议改成一串更复杂的随机字符串。

## 四、一条命令启动后端 + 数据库

在 Cursor 里：

1. 打开终端：`Terminal → New Terminal`
2. 执行：

```powershell
cd c:\wwwroot\index

docker compose up -d
```

- 第一次执行会：
  - 拉取 `mysql:8.0` 镜像
  - 构建后端镜像（根据 `backend/Dockerfile`）
  - 启动 `db` 和 `backend` 两个容器

看到类似输出，最后有 `✅` 或 `done` 字样，说明启动成功。

## 五、检查容器是否正常运行

在终端执行：

```powershell
docker ps
```

应该能看到类似两条：

- `ip_proxy_db`（mysql:8.0）
- `ip_proxy_backend`（node 后端）

## 六、初始化数据库（在容器里操作）

> 注意：现在 MySQL 在容器里，你之前本机安装的那个可以先不管。

### 6.1 进入 MySQL 容器

```powershell
docker exec -it ip_proxy_db bash
```

进到容器里后，再执行：

```bash
mysql -u root -p
```

输入你在 `docker-compose.yml` 里设置的 root 密码（例如 `MyRootPwd123!`）。

### 6.2 创建数据库（如果还没自动创建）

理论上 `MYSQL_DATABASE` 已经自动创建了 `ip_proxy_platform`，你可以确认一下：

```sql
SHOW DATABASES;
USE ip_proxy_platform;
```

### 6.3 创建表结构

在项目根目录有 `db_example_basic.sql`，可创建库、表并插入示例套餐。将文件挂载进容器或拷贝到容器内后，在 MySQL 中执行：

```sql
SOURCE /path/to/db_example_basic.sql;
```

（Windows 下若从宿主机执行，可用绝对路径，例如 `SOURCE c:/wwwroot/index/db_example_basic.sql;`，或先把文件复制到容器再 SOURCE。）

## 七、测试后端接口（此时也是在容器里跑）

容器里的后端已经映射到宿主机的 3000 端口，你可以在浏览器里访问：

### 7.1 健康检查

```text
GET http://localhost:3000/api/health
```

正常会返回类似：

```json
{
  "code": 200,
  "message": "OK",
  "data": {
    "db": "connected"
  }
}
```

说明：

- `backend` 容器正常
- 能连上 `db` 容器里的 MySQL

### 7.2 注册 / 登录等接口

和本地运行后端时一样，只是现在后端在 Docker 里：

- 注册：`POST http://localhost:3000/api/auth/register`
- 登录：`POST http://localhost:3000/api/auth/login`
- 套餐列表：`GET http://localhost:3000/api/plans`

## 八、停止 / 重启

### 8.1 停止所有服务

在项目根目录：

```powershell
cd c:\wwwroot\index
docker compose down
```

### 8.2 重新启动

```powershell
cd c:\wwwroot\index
docker compose up -d
```

数据会保存在 `db_data` 卷里，不会因为重启容器而丢失。

## 九、遇到问题时怎么排查

### 9.1 看后端日志

```powershell
docker logs -f ip_proxy_backend
```

### 9.2 看数据库日志

```powershell
docker logs -f ip_proxy_db
```

### 9.3 常见问题

1. **端口占用（3306 或 3000）**
   - Windows 上本机已经装了 MySQL 占了 3306 端口 → 可以：
     - 关掉本机 MySQL 服务，或者
     - 修改 `docker-compose.yml` 里的映射端口，例如 `"13306:3306"`

2. **root 密码不对**
   - 确认 `docker-compose.yml` 和 `.env.docker` 里密码一致

3. **/api/health 报错**
   - 看 `ip_proxy_backend` 日志，通常是数据库连不上或表未创建

## 十、后续计划（前端容器化）

目前我们只是让：

- **后端 + MySQL** 在 Docker 里跑起来

后面等你准备好前端模板（比如 `vue-manage-system`）后，可以继续：

- 添加 `frontend` 服务（Vue 构建 + Nginx 容器）
- 在 `docker-compose.yml` 里一起管理，实现真正“一套 docker 全站跑起来”

