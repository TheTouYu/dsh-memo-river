# 从零到可用（GETTING-STARTED）

目标：拿到仓库地址的人，**三条命令**跑起来；起不来的每一条都有下一步。

```
git clone <repo> && cd dsh-memo-river
node scripts/setup.mjs      # ① 备类型 → 编译 lib → 备内核
node scripts/doctor.mjs     # ② 体检（全绿再往下）
# ③ 装进 DSH：GUI「插件 → 添加插件」选本目录（agent 里用 plugin_manager install_bundle）
```

然后在 GUI 新会话里选「**记忆河流（Memo River）**」。

---

## 0. 前置

| 需要 | 为什么 | 怎么装 |
|---|---|---|
| **DSH**（Desktop ≥0.2.2，或源码 checkout） | 这是 DSH 插件，不是独立服务 | Desktop 装好并**至少启动过一次**（`scripts/setup.mjs` 会读 asar 里的运行期版本、从 npm 装同版本类型包）；源码路线设 `DSH_CHECKOUT` |
| **Node ≥ 22.5**（建议 24 LTS） | 知识库用 `node:sqlite` | https://nodejs.org |
| **一个 OpenAI 兼容的嵌入端点** | 写入/召回要向量 | 任意外部端点，或本机 llama.cpp，见 [LOCAL-EMBED.md](./LOCAL-EMBED.md)。维度必须等于模型真实输出（缺省 1024） |
| Rust（可选） | 原生内核 `kernel/` | 有 cargo 就源码编译；**Windows x64 没 Rust 也能跑**（仓库带预编译 `.node`） |

> 不配嵌入端点也能启动：写路径会明确拒绝、注入跳过并给模型一条「召回未生效」通知——
> 但那就不是「用起来」了，先按 LOCAL-EMBED 搞定一个端点。

## 1. 备类型 + 编译 + 内核

```bash
node scripts/setup.mjs
```

它依次做（幂等，可反复跑）：

1. 校验 Node；缺 `typescript` 就 `npm install`；
2. 找**与运行期同一份**的 DSH 类型源并 link 进 `node_modules`：
   - Desktop：`app.asar` **不含 `.d.ts`**（被剥掉了）——先从 asar 读出运行期版本，
     `npm install --prefix .deps/types` 装**同版本**类型包，再抽运行期包到 `.deps/` 兜底；
   - npm 全局 dsh：直接链 `<prefix>/node_modules`；
   - 源码 checkout：链 `packages/` + `vendor/`。
3. `tsc` 编译 `src/ → lib/`，并校验产物不是 0 字节假成功；
4. 内核：有 `cargo` → `cargo build --release` 并原子换 `.node`；没有 → 用
   `kernel/prebuilt/<platform>-<arch>/`（目前只带 Windows x64）。

常用变体：

```bash
node scripts/setup.mjs --no-kernel    # 只准备 lib
node scripts/setup.mjs --kernel-only  # 只重编内核
node scripts/setup.mjs --force-types  # DSH 升级后强制重建类型链接
TSC=/path/to/tsc node scripts/setup.mjs   # 用现成编译器（离线环境）
```

退出码：`0` 全好；`1` 有硬失败；`2` 只有内核没就绪（其余可用，看它给的二选一提示）。

## 2. 体检

```bash
node scripts/doctor.mjs
```

七项：Node 版本、`lib/` 可 import 且不旧于 `src/`、`kernel/*.node` 可装载、嵌入端点真打一次
（维度/耗时/L2）、`~/.dsh/memo-river` 可写、DSH profile 里装了且选了 bundle。

全绿输出 `7 PASS · 0 WARN · 0 FAIL`；有 FAIL 时每条下面就是修法。

## 3. 装进 DSH

**GUI**：设置/插件页 → **添加插件** → 选仓库目录（它自己声明了 `dsh.bundle`）。

**Agent**（DSH 里的会话）：

```
plugin_manager  action=install_bundle  target=<仓库绝对路径>
```

安装完成后 **重启 DSH**（插件变更对运行中的 Host 需要重启才挂载干净），再新开会话选
「记忆河流（Memo River）」。首个会话会在 `~/.dsh/memo-river/<cwd hash>/` 下建桶，写
`memo-river.log` / `health.log`。

## 4. 怎么算「真的用起来了」

1. 新会话问一句你写过日记的话题 → 消息尾部应出现 `⟨memo-river·被动召回⟩` 块（带 D 编号 / role / Ω）。
2. 让 agent 调 `memo_write` 写一条 → 返回写入成功 + Tag 词汇回注。
3. 再问同一话题 → 召回里应看到刚写的那条。
4. `memo_stats` → 看桶里篇数 / 注入台账。

## 5. 配置在哪、怎么改

预设声明在 [`bundle/cordis.patch.yml`](../bundle/cordis.patch.yml)，**不用改文件也能覆盖**：

| 环境变量 | 缺省（Windows / 其它） | 含义 |
|---|---|---|
| `MEMO_EMBED_URL` | `127.0.0.1:8091` / `127.0.0.1:8099` | 嵌入端点根（不带 `/v1`） |
| `MEMO_EMBED_API_KEY` | `local` | 端点 key（外部端点必填） |
| `MEMO_EMBED_MODEL` | `Qwen3-Embedding-0.6B` / `baai/bge-m3` | 模型名 |
| `MEMO_EMBED_DIM` | `1024` | **必须等于模型真实输出维度** |
| `MEMO_EMBED_FALLBACK_*` | Linux 才有远端回退 | 主端点失败时的保底泳道 |

写进启动 DSH 的环境（Desktop 是进程级），或直接改 bundle 里的值后重装。

## 6. 故障排查

| 现象 | 原因 / 修法 |
|---|---|
| `setup` 报「找不到 DSH」 | 先启动一次 Desktop；或设 `DSH_CHECKOUT` / `DSH_INSTALL_DIR` |
| `npm install` 失败 | registry 不可达：`npm config set registry https://registry.npmmirror.com`，或挂代理；也可 `npm install` 后重跑 |
| `tsc: Cannot find module 'cordis'` | 类型链接没建：`node scripts/setup.mjs --force-types` |`n| Desktop 离线、npm 装不了类型包 | Desktop 的 asar 没有 `.d.ts`；改用源码：`DSH_CHECKOUT=<dsh 源码> node scripts/setup.mjs` |
| `kernel` 装载失败 | `node scripts/setup.mjs --kernel-only`；Windows 需 VS Build Tools 的 C++ 负载 |
| `doctor` 嵌入端点 FAIL | 起服务见 [LOCAL-EMBED.md](./LOCAL-EMBED.md)，或设 `MEMO_EMBED_*` 指向外部端点 |
| 维度不对（如 3072 vs 1024） | 插件**不发** `dimensions` 参数：`MEMO_EMBED_DIM` 必须等于模型真实输出 |
| 装了但 GUI 看不到预设 | 重启 DSH；确认 `profile/package.json` 的 `dsh.profile.bundles` 里有 `@dsh-external/dsh-memo-river`（doctor 会报） |
| 注入一直跳过 | 看桶日志 `inject-skip reason=embed-*`；`memo_stats` 看门控阈值 |

## 7. 卸载 / 更新

```bash
plugin_manager action=remove_bundle target=@dsh-external/dsh-memo-river   # 卸载
git pull && node scripts/setup.mjs && node scripts/doctor.mjs             # 更新后重建
# 预编译内核可能与 kernel/ 源码不同步：node scripts/setup.mjs --kernel-only
```
