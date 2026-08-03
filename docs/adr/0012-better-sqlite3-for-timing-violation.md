# better-sqlite3 作为时序违例数据存储

时序违例数据使用 `better-sqlite3` 存储，启用 WAL 模式 + PRAGMA 优化（synchronous=NORMAL, cache_size=10000, temp_store=MEMORY, mmap_size=256MB），不使用连接池。

Python 版本使用连接池是因为 Python `sqlite3` 模块是同步阻塞的，需要多连接实现并发。`better-sqlite3` 是同步 API，天然串行化，在 Electron 主进程中安全使用，不需要连接池和线程锁。批量插入性能可达 10 万+/秒（使用 `transaction()` + `prepare()` + `executemany`）。

数据库文件路径用户可配置，默认 `.socverify/timing-violation/tv.db`，与现有 `.socverify/coverage/` 约定一致。Schema 保持 3 张表（violations / confirmations / patterns）但重新设计字段和索引：violations 表新增 `seed`、`subsys` 字段，唯一键改为 `(case_name, corner, seed, hier, check_info, time_fs)`。

Considered options:
- `node:sqlite`（Node.js 22+ 内置）——API 仍在实验阶段，Electron 43 兼容性不确定。
- 保留 Python 版本的连接池——同步 API 不需要，增加复杂度。
