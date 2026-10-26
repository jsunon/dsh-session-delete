# dsh-session-delete

给 DSH Web 侧栏的会话菜单补一条 **删除会话**。

DSH 自带的会话菜单只有置顶 / 重命名 / 分叉 / 归档 / 复制 Session ID —— 「归档」只是把会话藏起来，磁盘上的日志、投影缓存、工作区记录都还在。这个插件补的是真正的删除。

## 它做什么

点「删除会话」→ 确认框 → 宿主执行三步：

1. **先把这个会话从活存储里摘下来**：`workspace/session-stop` 取消它正在跑的回合 → `sessions.flush` 把缓冲事件落盘 → `entry.detach()` 派发 `session/disposed`，持久化后端在那一刻关掉文件句柄。摘不下来（仍被占用）才返回 409 `session-live`。
2. **删磁盘产物**：`~/.dsh/sessions/<项目键>/<会话 id>/`（会话日志）与 `~/.dsh/storages/session_projcache/sessions/<会话 id>.json`（投影缓存）。盘没删干净就返回 500，账本保持不动，方便重试。
3. **摘 workspace 账本**：逐个 workspace `detachSession`，再 `unarchiveSession` / `unpinSession`，走 registry 的正式写路径（活的 registry 会自己落盘并广播快照）。

浏览器侧确认成功后刷新会话列表，行随即消失。

## 安装

宿主会热重载 profile 的用户 patch 层（`$DSH_HOME/profiles/<profile>/cordis.patch.yml`），所以把包放进 profile 的 `node_modules` 再插一行即可，无需重启：

```yaml
- insert:
    - id: dsh-session-delete
      name: 'dsh-session-delete'
```

## HTTP 接口

- `GET  /dsh-session-delete/api/health` — 探活
- `POST /dsh-session-delete/api/delete` — body `{ "sessionId": "<id>" }`，要求 `content-type: application/json`

两条路由都过一道同源栅栏：拒绝 `sec-fetch-site: cross-site`、拒绝 `origin: "null"`、带 `Origin` 时其 host 必须等于 `Host`。
