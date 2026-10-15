/**
 * src/schema-local.ts — **插件自有** DDL（与自动生成的 `src/schema.ts` 分开）。
 *
 * 为什么必须分开（2026-10-15，G3 语料有效性）：
 * `src/schema.ts` 由 `scripts/gen-schema.mjs` 从上游参考库
 * （`/home/h/app/VCPToolBox/sandbox/classroom-flow/full/knowledge_base.sqlite`）的
 * `sqlite_master` **逐字**镜像生成——文件头写着「自动生成，请勿手改」，共 53 条 DDL。
 * 在它里面加表/加列有两个后果：① 下次 `gen-schema.mjs` 一跑就被无声覆盖；
 * ② 「DDL 逐字取自 VCPToolBox」这条 DESIGN.md §9 的不变量失效（内核/差分验证都依赖它）。
 *
 * 所以本仓的**自有**扩展一律落在这里，由 `src/store.ts` 在 `SCHEMA_STATEMENTS` 之后
 * 追加执行。约定：
 *   · 每条必须自带 `IF NOT EXISTS`（store 侧还有 already-exists 兜底，但别依赖它）；
 *   · **不加外键**——`store.ts` 开着 `PRAGMA foreign_keys = ON`，而 `memo_merge`
 *     会 `DELETE FROM files`（`src/tools.ts` 归档退役路径）。引用 `files(id)` 的外键
 *     会让归档直接失败。悬挂行改由「读取时 JOIN files 过滤」+「归档处顺手清理」处理。
 */

export const LOCAL_SCHEMA_STATEMENTS: readonly string[] = [
  /**
   * 记忆取代关系（G3）：`old_file_id` 的**结论**已被 `new_file_id` 取代。
   *
   * 语义边界（别和既有机制混）：
   *   · `memo_update` = 原地重写，旧内容消失 → **不存在**过期条目；
   *   · `memo_merge` = 并入后归档退役（行级删除）→ **不存在**过期条目；
   *   · 本表处理的是第三种情形：**新写的日记推翻了某篇旧日记的结论，两篇都留着**。
   *     这类条目「过程/教训仍有价值，但结论已不是当前事实」——被动注入不该再当事实喂进去
   *     （否则模型会基于一个已经不成立的世界做诊断），而主动查询时应当看得见全貌。
   *
   * `new_file_id IS NULL` = **已废止**（没有继任篇，纯撤回）。
   */
  `CREATE TABLE IF NOT EXISTS memo_supersessions (
        old_file_id INTEGER NOT NULL PRIMARY KEY,
        new_file_id INTEGER,
        reason TEXT,
        marked_at INTEGER NOT NULL,
        marked_by TEXT NOT NULL
    );`,
  `CREATE INDEX IF NOT EXISTS idx_memo_supersessions_new
        ON memo_supersessions(new_file_id);`,
]
