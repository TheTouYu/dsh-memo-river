# ADR — 暗会话记忆覆盖决策

- **日期**：2026-09-15
- **状态**：已决策（分层纳入 · 维持预设作用域架构）
- **来源票据**：`.scratch/perf-funnel-0915/issues/09-dark-session-coverage-adr.md`
- **调查方法**：只读勘验——zstd 解压 `~/.dsh/sessions/` 会话事件流逐条计数、`~/.dsh/memo-river/plugin.log` 对账、DSH 发行包（dsh-agent-presets）与 web profile 挂载层源码阅读、预设注册表 mtime 取证。本票不改代码、不改配置、不碰生产桶。

---

## 1. 背景与问题

2026-09-15 生产评估发现多类「暗会话」：完全不经记忆系统（零注入、零 memo_* 工具调用）的会话，其中包括最有记忆价值的长自主会话：

| 暗会话样本 | 预设 | 体量 | 运行窗口 (UTC) | 记忆足迹 |
|---|---|---|---|---|
| agi-harness `a4806e5a`（`bec53ac7` 为其 isSeeded 续篇，同一逻辑会话） | standard → cordis | 16 turns / 191 A msgs / 245+ 工具调用 | 09-11 13:47 → 09-13 09:39 | memo 注入 0，memo_* 调用 0 |
| preset-composer `d418ade0` | plugin-dev | 246 A msgs / 314 工具调用（5.6h 自主） | 09-15 02:57 → 08:35 | 注入 0，plugin.log 无其 session-start |
| preset-composer `70f0f000` / `ac637c29` | plugin-dev | 1 turn / 0 turn | 09-15 02:55 起 | 注入 0 |

对照组（有记忆的会话）：preset-composer 子代理 `8f784e2a`/`9d78e09c`/`f9b85187`（预设 memo-river，注入 5/3/5 次）；genshin-ts `8a9607e7`（1 次注入，见 §2.3）。

---

## 2. 根因（证据链）

### 2.0 架构层：覆盖 = 预设作用域父子链，不是进程级

memo-river 的监听器覆盖范围由 DSH 预设挂载机制决定（`dsh-agent-presets/lib/index.js`）：

- `discoverPresets(roots)` 根序 = **system（发行包预设）→ config.roots → user（`~/.dsh/.agent-presets/`）**，first-root-wins ⇒ 同 id 用户预设**不能**覆盖发行版 standard/cordis；「带记忆的 standard」只能起新 preset id（现有 `memo-river` 用户预设正是 standard 复制 + 一行 memo-river 组）。
- `mount(agentCtx, id)` → `ensureStanding(preset)` → `bindScopeParent(agentKey, standing.key)`：**插件的注册与监听只覆盖挂进该 standing 作用域的 agent**。standing 挂载按组合文件代际存续，进程存活期不释放；但挂在别的预设下的 agent 父链不在其中，事件听不到。
- 宿主全局层（web profile）**明确禁用**：`~/.dsh/profiles/web/cordis.patch.yml` 有 `- id: dsh-memo-river disabled: true`（防 bundle patch 自装配），package.json bundles 只含 `@dsh-external/dsh-memo-tuner`（GUI 面板）。

⇒ **一个会话有记忆，当且仅当它选择的预设组合里有 memo-river 行**。进程内是否存在 memo-river 常驻挂载（别的会话挂的）无关紧要。

### 2.1 agi-harness（standard/cordis）：发行版预设无 memo-river 行

- 发行包 `@deepseek-ai/dsh-agent-presets/presets/{standard,cordis,minimal,ptc}` grep 无 memo-river 行（cordis 只在技能文档里提到 memo）。
- 直接证据：`a4806e5a` 内 2026-09-11 的 `dev_plugin_status` 全量 loader 快照（约 120 条）**无任何 dsh-memo-river 条目**——当时宿主全局层也没挂它（插件首次挂载是 09-12 01:29 UTC，plugin.log 首行）。
- 会话事件流直接计数：`⟨memo-river` 注入 0、memo_* 工具名 0（52 处 "memo" 全在正文闲聊）。
- 历史注脚：该会话用过旧记忆系统（`engram_store`×7）——engram 当时在全局层；engram 09-13 被定向移除（见 patch.yml 注释）后，此类 shipped 预设会话落入「无任何记忆」状态。

### 2.2 plugin-dev 三条：预设行加晚了 15 分钟

- `~/.dsh/.agent-presets/plugin-dev/agent.cordis.yml` mtime **2026-09-15 16:50:00 CST（= 08:50 UTC）**，其内容含 memo-river 组（`./preset-composer-mod-memo-river.mjs?v=40cef68a`，intervalMs=900000，inject gate/k=3/tokenBudget=3500/topology_v3）；同目录 `.bak`（改前版）无此行。
- 暗会话时间窗：`d418ade0` 最后事件 08:35:02 UTC（16:35:02 CST）——**比行落地早 15 分钟**结束；`70f0f000`/`ac637c29` 更早。
- 即便进程内另有 memo-river standing 挂载（02:37-02:55 UTC 期间 `2e8fca1f` 等 memo-river 预设会话正被服务），暗 trio 挂的是 plugin-dev 作用域，事件照不到——无需「挂载死过一代」假说。

### 2.3 对照复核与两个被否证的假说（记录防重蹈）

- **genshin-ts `8a9607e7` 的 1 次注入不是跨作用域泄漏**：该会话 header agentPreset="standard"（09-11 创建），但 09-13 02:39:57 UTC resume 时 seq 5 有 `agent-preset/selected {"agentPreset":"memo-river"}`——注入（02:55:34，turn 2 pre-step）是合法的预设成员关系。header 里的 agentPreset 只是创建时旧值，**resume 可以换预设**。
- **「挂载在 02:55:55-02:57:20 UTC 之间死过一代」不需要**：作用域父子链（§2.0）已完整解释暗 trio 零覆盖。
- `2e8fca1f`（genshin-model-studio）、`69109da6`（agent-messaging）等被 plugin.log 听到的会话复核均为 selected=memo-river。✓ 模型自洽。

### 2.4 全量普查（76 会话对账）

plugin.log（09-12 01:29 UTC 起）session-start id 与 `~/.dsh/sessions/*/session-*/` 对账：

| 工作区 | 会话数 | 有记忆 | 说明 |
|---|---|---|---|
| dsh-memo-river | 23 | 10 | 亮的=选 memo-river 预设 |
| dsh-preset-composer | 16 | 10 | 含 16:50 后的 plugin-dev 会话 |
| genshin-model-studio | 12 | 10 | memo-river 预设 |
| genshin-ts | 3 | 1 | 仅 09-13 换预设的 8a9607e7 |
| dsh-agent-messaging | 1 | 1 | memo-river 预设 |
| **dsh-agi-harness** | **4** | **0** | shipped standard/cordis |
| VCPToolBox / deepseek-harness / ~ | 12 / 4 / 4 | 0 | shipped 预设或早于插件 |
| **合计** | **76** | **32（42%）** | 暗 44（58%） |

---

## 3. 方案对比

| 方案 | 内容 | 成本 | 风险 | 判定 |
|---|---|---|---|---|
| **A. 宿主全局层启用** | 撤 patch.yml 的 disabled + bundles 加包，进程内全部 agent 覆盖（含 rosterless 子代理） | 每轮注入 mean 5.8s / p95 8.1s 压到**所有**会话（票 01-04 前）；embed 花费全局放大 | **engram 前车之鉴**：全局层把工具/提示/注入压进所有会话（含游戏会话），真实信号被稀释到 0.17%（context-audit-genshin-ts-0913.md），09-13 已定向移除 | ✗ 不采纳 |
| **B. 默认预设切换** | settings 默认预设切到 memo-river（或含记忆的新 preset id） | 新会话每轮注入时延同上；存量运行中会话不变 | 全部新会话默认有记忆——genshin-ts 类轻量工作区也被覆盖，重演信号稀释；应等性能票据落地 | ⏸ 暂缓（触发条件见 §5） |
| **C. 逐预设纳入（opt-in）** | 按会话类别在用户预设里加 memo-river 行（plugin-dev 模式），或开会话时手选 memo-river 预设 | 想要记忆的项目才付时延；每桶 daemon 15min、sqlite+日记磁盘 | 覆盖不自动——新项目要记得选；可能漏选（本票样本即漏选后果） | ✓ **采纳（已落地一项）** |
| **D. 轻量模式（仅 write-nudge 不注入）** | 新增 `injectEnabled:false` 开关：pre-step 在 embed 之前短路，保留 nudge 四锚 + memo_* 工具 + daemon | 约 20 行改动（src/injector.ts 短路 + src/config.ts InjectConfig）；无每轮 embed 时延 | 只写不读 → 语料单向增长，「从未使用」比例上升（体检⑤现 7%）；低价值工作区催出垃圾日记（D10 机械批准教训）——需配套更保守 nudge 阈值 | ○ 列为后续票 |
| **E. 明确排除** | 维持现状 + runbook 盲区登记 | 零 | 长自主会话（d418ade0 型：5.6h/246 A msgs）继续裸奔——正是记忆最有价值的场景（D5 长任务盲区诊断） | ✗ 不采纳 |

**注**：现状无 injectEnabled 开关；`gateThreshold=1.0` 能挡住注入但**仍付每轮 embed RTT**（今天 2 次串行单条 1.19-1.45s/条；票 01 合批后 1 次），不等于轻量模式。

---

## 4. 决策

1. **维持「预设作用域」架构**，按会话类别 opt-in 纳入（方案 C）。宿主全局层保持 disabled（方案 A 否决，engram 教训）。
2. **plugin-dev 已纳入并验证**（§6）：preset-composer 侧 09-15 16:50 在 plugin-dev 预设加了 memo-river 行，该类暗会话已复亮。
3. **agi-harness 型长自主会话**：立即可用路径 = 开会话时手选 memo-river 预设（零改动、零风险）；若要求默认覆盖，走方案 B（settings 默认预设切换），**触发条件 = 票 01-04 落地后**（注入 mean 5.8s → 目标 <1.5s）再评估。
4. **轻量模式（方案 D）开后续票**：给低频/轻量工作区一个「有写入节律、无注入时延」的中间档。
5. **明确不做的**：不启用宿主全局层；不用 gateThreshold=1.0 冒充轻量模式。

---

## 5. 影响面

**推荐执行后（手选路径，立即可用）**：
- 任何工作区（agi-harness / VCPToolBox / deepseek-harness / …）开会话选 memo-river 预设 → 该会话有记忆（注入 + memo_* 工具 + write-nudge + 本工作区独立桶）。不改任何全局状态。
- 不选的会话维持现状（暗）——runbook 盲区口径不变（`docs/EVAL-生产评估-runbook.md` §四「已知盲区」继续适用：shipped 预设会话无记忆）。

**已发生（plugin-dev 行落地后）**：
- dsh-preset-composer 工作区未来的 plugin-dev 会话默认有记忆。
- 存量暗会话（d418ade0 等）不会追溯变亮——它们已结束，事件不会再发生。

**若后续采纳方案 B（默认预设切换）**：
- 全部**新**会话默认有记忆（含 genshin-ts 游戏会话——需用户接受信号稀释风险，参照 0.17% 审计教训）；运行中存量会话不变。
- 桶数量随活跃工作区增长（每桶：sqlite + dailynote/ + daemon 15min 轮 + health.log）。

**永不覆盖（架构性排除面）**：
- 宿主全局层 disabled 保持；发行版 shipped 预设（standard/cordis/minimal/ptc）不带 memo-river（上游不改）；rosterless 子代理（无预设父链）不覆盖。

---

## 6. 验证（真实暗会话变亮）

plugin-dev 类从暗到亮的时间线（2026-09-15，CST）：

| 时刻 | 事件 |
|---|---|
| 10:55-16:35 | 暗 trio 运行：`70f0f000`（1 turn，0 注入）/ `ac637c29`（空）/ `d418ade0`（5.6h 自主，0 注入，plugin.log 无 session-start） |
| 16:50:00 | `~/.dsh/.agent-presets/plugin-dev/agent.cordis.yml` 加 memo-river 行（mtime 取证；.bak 无此行） |
| 16:51:14 | `6f297f13`（agentPreset=plugin-dev，根行取证）session-start 入 plugin.log，**23 次注入** |
| 17:05 / 17:11 | `a20e4270` **7 次**、`0ff8c384` **5 次**注入（均 plugin-dev） |

同一预设、同一工作区、行落地前后各一组会话：0 注入 → 23/7/5 注入。根因（预设行缺失）与修复路径（预设行落地）闭环验证。✓

---

## 7. 遗留与后续

- **后续票建议①（轻量模式）**：`src/config.ts` InjectConfig 加 `injectEnabled`；`src/injector.ts` pre-step 在 embed 之前短路（保留 nudge/session-start/daemon）。约 20 行。
- **后续票建议②（覆盖可见性）**：GUI/面板显示「本会话记忆：on(预设名)/off」，把「暗会话」从事后审计变成开票即见。
- **方案 B 复评触发条件**：票 01（注入合批+短超时）、02（连接保活）、03（写侧合批）、04（approve 并行）落地，注入 mean 降到 <1.5s 后，再议默认预设切换。
- 本票未改 runbook §四（票面限定唯一产出物为本 ADR；盲区口径维持「shipped 预设会话无记忆」仍然准确）。
