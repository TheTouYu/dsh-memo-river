//! memo_vector_pool —— VCP 2.0 复刻 P0.3：请求级共享 Tag 向量池。
//!
//! 上游对照：/home/h/app/VCPToolBox-2.0/rust-vexus-lite/src/storage.rs:984-1056。
//! 语义逐条对齐：
//! - load_vectors_by_ids：SQL 原件 FP32 行，无归一化无近似重建（usearch 索引只出 id，
//!   度量永远用 SQLite 原件）；批 128；行级故障隔离（坏行 continue，查询错传播）；
//!   长度≠dim*4 与非有限值缺席。
//! - TagVectorPool：请求局部权威行；Arc 克隆不复制 FP32 载荷（同 id 只查一次）。
//! - ensure_tag_vectors_loaded：只有 id>0 且未入池的缺口进 SQL，排序去重后批取。
//!
//! 消费方（P1 接线）：动态虫洞共鸣装载 / fuse_observation_with_pool /
//! solve_dual_fields_with_pool / 圈选投影并集补池。

use rusqlite::Connection;
use std::collections::HashMap;
use std::sync::Arc;

/// Read authoritative FP32 rows without normalization or approximate reconstruction.
pub(crate) fn load_vectors_by_ids(
    connection: &Connection,
    table: &str,
    ids: &[i64],
    dimension: usize,
) -> Result<HashMap<i64, Vec<f32>>, String> {
    if !matches!(table, "tags" | "chunks") {
        return Err("vector source table must be tags or chunks".into());
    }
    let byte_len = dimension
        .checked_mul(4)
        .filter(|_| dimension > 0)
        .ok_or_else(|| "invalid vector dimension".to_string())?;
    let mut unique = ids.iter().copied().filter(|id| *id > 0).collect::<Vec<_>>();
    unique.sort_unstable();
    unique.dedup();
    let mut output = HashMap::with_capacity(unique.len());
    for batch in unique.chunks(128) {
        let placeholders = vec!["?"; batch.len()].join(",");
        let sql = format!(
            "SELECT id, vector FROM {table} WHERE id IN ({placeholders}) AND vector IS NOT NULL"
        );
        let mut statement = connection
            .prepare(&sql)
            .map_err(|error| format!("prepare authoritative vectors failed: {error}"))?;
        let mut rows = statement
            .query(rusqlite::params_from_iter(batch.iter()))
            .map_err(|error| format!("query authoritative vectors failed: {error}"))?;
        while let Some(row) = rows.next().map_err(|error| error.to_string())? {
            let (Ok(id), Ok(bytes)) = (row.get::<_, i64>(0), row.get::<_, Vec<u8>>(1)) else {
                // Preserve row-level fault isolation; query/I/O failures still propagate.
                continue;
            };
            if bytes.len() != byte_len {
                continue;
            }
            let vector = bytes
                .chunks_exact(4)
                .map(|bytes| f32::from_le_bytes(bytes.try_into().unwrap()))
                .collect::<Vec<_>>();
            if vector.iter().all(|value| value.is_finite()) {
                output.insert(id, vector);
            }
        }
    }
    Ok(output)
}

/// Request-local authoritative Tag rows. Arc clones never copy FP32 payloads.
pub(crate) type TagVectorPool = HashMap<i64, Arc<[f32]>>;

#[derive(Default)]
pub(crate) struct TagVectorLoadStats {
    pub(crate) requested_nodes: usize,
    pub(crate) fetched_nodes: usize,
    pub(crate) sql_batches: usize,
}

/// Only the unique cache-miss IDs reach SQLite; load_vectors_by_ids batches at 128.
pub(crate) fn ensure_tag_vectors_loaded(
    connection: &Connection,
    pool: &mut TagVectorPool,
    requested_ids: &[i64],
    dimension: usize,
) -> Result<TagVectorLoadStats, String> {
    let mut missing: Vec<i64> = requested_ids
        .iter()
        .copied()
        .filter(|id| *id > 0 && !pool.contains_key(id))
        .collect();
    missing.sort_unstable();
    missing.dedup();
    let rows = load_vectors_by_ids(connection, "tags", &missing, dimension)?;
    let stats = TagVectorLoadStats {
        requested_nodes: missing.len(),
        fetched_nodes: rows.len(),
        sql_batches: missing.len().div_ceil(128),
    };
    pool.extend(rows.into_iter().map(|(id, vector)| (id, Arc::from(vector))));
    Ok(stats)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE tags(id INTEGER PRIMARY KEY, name TEXT, vector BLOB);",
            )
            .unwrap();
        for id in 1..=300i64 {
            let bytes: Vec<u8> = [(id % 7) as f32, 0.5, -0.25]
                .iter()
                .flat_map(|x| x.to_le_bytes())
                .collect();
            connection
                .execute("INSERT INTO tags VALUES (?1,?2,?3)", rusqlite::params![id, format!("t{id}"), bytes])
                .unwrap();
        }
        // id=7 错长度；id=8 含 NaN；id=9 NULL 向量——三者都应缺席。
        connection
            .execute("UPDATE tags SET vector=zeroblob(4) WHERE id=7", [])
            .unwrap();
        let nan: Vec<u8> = [1.0f32, f32::NAN, 0.0].iter().flat_map(|x| x.to_le_bytes()).collect();
        connection
            .execute("UPDATE tags SET vector=?1 WHERE id=8", rusqlite::params![nan])
            .unwrap();
        connection
            .execute("UPDATE tags SET vector=NULL WHERE id=9", [])
            .unwrap();
        connection
    }

    #[test]
    fn pool_loads_batches_and_isolates_bad_rows() {
        let connection = fixture();
        let ids: Vec<i64> = (1..=300).collect();
        let mut pool = TagVectorPool::new();
        let stats = ensure_tag_vectors_loaded(&connection, &mut pool, &ids, 3).unwrap();
        assert_eq!(stats.requested_nodes, 300);
        assert_eq!(stats.fetched_nodes, 297, "错长度/NaN/NULL 三行缺席");
        assert_eq!(stats.sql_batches, 3, "300 缺口 → ceil(300/128)=3 批");
        assert!(!pool.contains_key(&7) && !pool.contains_key(&8) && !pool.contains_key(&9));
        assert_eq!(pool[&1].as_ref(), &[1.0f32, 0.5f32, -0.25f32][..]);
    }

    #[test]
    fn pool_reuses_arcs_without_refetch() {
        let connection = fixture();
        let mut pool = TagVectorPool::new();
        ensure_tag_vectors_loaded(&connection, &mut pool, &[5, 5, 6], 3).unwrap();
        let first = pool.get(&5).unwrap().clone();
        let stats = ensure_tag_vectors_loaded(&connection, &mut pool, &[4, 5, 6], 3).unwrap();
        assert_eq!(stats.requested_nodes, 1, "只有 id=4 是缺口");
        assert_eq!(stats.sql_batches, 1);
        assert!(std::sync::Arc::ptr_eq(&first, pool.get(&5).unwrap()), "同 id 复用同一 Arc 载荷");
    }

    #[test]
    fn nonpositive_ids_never_reach_sql() {
        let connection = fixture();
        let mut pool = TagVectorPool::new();
        let stats = ensure_tag_vectors_loaded(&connection, &mut pool, &[0, -3, 2], 3).unwrap();
        assert_eq!(stats.requested_nodes, 1);
        assert!(pool.contains_key(&2) && !pool.contains_key(&0));
    }
}
