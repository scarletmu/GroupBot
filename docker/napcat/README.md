# NapCat Docker（本地调试用）

用 [`mlikiowa/napcat-docker`](https://github.com/NapNeko/NapCat-Docker) 起一个本地 NapCatQQ 容器，给本仓库的 QQBot 当 OneBot 11 客户端用。**只用于调试**，别拿去跑生产。整个 `docker/` 目录已加到根 `.gitignore`，不会进 git。

## 端口约定

为了不和本机其它服务撞，宿主机端口都改成了 5 位（`1xxxx`），容器内端口保持上游默认：

| 用途 | 容器端口 | 宿主机端口 | 怎么访问 |
|---|---|---|---|
| WebUI | 6099 | **16099** | http://localhost:16099/webui |
| OneBot11 HTTP | 3000 | 13000 | （QQBot 用不到，留着方便手动戳）|
| OneBot11 正向 WS | 3001 | 13001 | （QQBot 用反向 WS，这个也用不到）|

QQBot 跑的是反向 WS 服务端（默认监听 `:6700`），是 NapCat 主动连过来——所以这边不需要额外暴露端口。

## 启动前的准备

1. **让 QQBot 监听容器能到达的地址。** `config/bot.json5` 里默认是 `listen.host: "127.0.0.1"`，容器里的 NapCat 连不上。改成 `"0.0.0.0"`，然后重启 QQBot 进程（`listen.*` 不支持热更新）。
2. **token 要对上。** WebUI 里配反向 WS 时填的 token，必须和 `bot.json5` 的 `listen.token` 一致。

## 启动

```bash
./run.sh
```

`run.sh` 就是一条 `docker run`：会先把同名容器干掉再起一个新的，第一次跑会自动建 `data/` 目录持久化账号和配置（已 ignore）。

看日志、停容器：

```bash
docker logs -f qqbot-napcat
docker stop qqbot-napcat        # 停掉，data/ 保留
docker rm -f qqbot-napcat       # 彻底删容器，data/ 还在
rm -rf data                     # 真要重置账号 / 配置才动这个
```

## 在 WebUI 里配 QQ + 反向 WS

1. 打开 http://localhost:16099/webui ，默认 token：`napcat`（首次登录强制改）。
2. 扫码登录调试 QQ 号。登录成功后把这个号填到 `config/bot.json5` 的 `selfId`。
3. 进 **OneBot11 配置** → 新建一条 **反向 WebSocket**：
   - URL：`ws://host.docker.internal:6700/`
   - Token：和 `bot.json5` 的 `listen.token` 一字不差
   - 启用消息上报、心跳。
4. 保存。NapCat 应该立刻发起连接，QQBot 的日志里能看到握手记录。

> NapCat 的 `onebot11_<uin>.json` 是 WebUI 自己管的，别手动改。

## 排错速查

- **NapCat 一直连不上 QQBot**：容器里测一下连通性 `docker exec qqbot-napcat sh -c 'nc -zv host.docker.internal 6700'`。连不上多半是 QQBot 还在 `127.0.0.1` 上，或者防火墙拦了。
- **WebUI 打不开**：检查 16099 是否被占用：`lsof -iTCP:16099 -sTCP:LISTEN`。
- **登录后掉线 / 风控**：调试用老号、固定 IP；新号扫码很容易被风控。
- **换 QQ 号**：`docker rm -f qqbot-napcat && rm -rf data/qq && ./run.sh` 再扫码。
