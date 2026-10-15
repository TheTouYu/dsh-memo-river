#!/usr/bin/env python3
"""
本地 bge-m3 嵌入服务（OpenAI 兼容 /v1/embeddings）—— 2026-10-15「本地推理路线」测试件。

官方依据：BAAI BGE 文档 BGE-M3 页（https://bge-model.com/bge/bge_m3.html）——dense 向量 =
归一化的 [CLS] 隐状态，1024 维；参考实现 `from FlagEmbedding import BGEM3FlagModel`。
本件只做**插件需要的那一面**：POST /v1/embeddings → 与 OpenAI/OpenRouter 同形状，
因此插件侧零代码改动（`embed.apiUrl = http://127.0.0.1:<port>`，插件自己拼 `/v1/embeddings`）。

用法：
    venv/bin/python scripts/local-embed/server.py --port 8099 [--device cuda:0|cpu] [--fp16]
环境变量：LOCAL_EMBED_MODEL（缺省 BAAI/bge-m3）、HF_HOME、HF_ENDPOINT（国内可设 hf-mirror）
"""
import argparse
import hashlib
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import torch

ARGS = None
MODEL = None
LOCK = threading.Lock()  # 单卡串行：并发请求排队，避免显存抖动

# ── 观测（2026-10-15 延迟归因）：每请求一行日志 + /health 计数器 ──
# 排队时延 = 拿 LOCK 的等待时间（单锁串行的直接受害者）；encode = 纯前向。
STATS_LOCK = threading.Lock()
STATS = {"requests": 0, "errors": 0, "started_at": None}
RECENT = []  # 最近 64 条请求的 {ts,n,chars,wait_ms,encode_ms,json_ms,total_ms}
RECENT_CAP = 64


def note_request(entry: dict):
    with STATS_LOCK:
        STATS["requests"] += 1
        RECENT.append(entry)
        if len(RECENT) > RECENT_CAP:
            del RECENT[0]


def stats_snapshot() -> dict:
    with STATS_LOCK:
        recent = list(RECENT)
    if recent:
        waits = sorted(e["wait_ms"] for e in recent)
        encs = sorted(e["encode_ms"] for e in recent)
        p = lambda a, q: a[min(len(a) - 1, int(len(a) * q))]
        summary = {
            "recent_n": len(recent),
            "wait_ms_p50": round(p(waits, 0.50), 1),
            "wait_ms_p95": round(p(waits, 0.95), 1),
            "wait_ms_max": round(waits[-1], 1),
            "encode_ms_p50": round(p(encs, 0.50), 1),
            "encode_ms_p95": round(p(encs, 0.95), 1),
            "encode_ms_max": round(encs[-1], 1),
        }
    else:
        summary = {"recent_n": 0}
    return {
        "requests": STATS["requests"],
        "errors": STATS["errors"],
        "uptime_s": round(time.time() - STATS["started_at"], 1) if STATS["started_at"] else 0,
        **summary,
        "recent": recent[-16:],
    }


def load_model(model_id: str, device: str, fp16: bool):
    from FlagEmbedding import BGEM3FlagModel

    devices = [device] if device and device != "cpu" else None
    t0 = time.time()
    model = BGEM3FlagModel(model_id, use_fp16=fp16, devices=devices)
    print(f"[local-embed] 模型就绪 {model_id} device={device} fp16={fp16} 用时 {time.time() - t0:.1f}s", flush=True)
    return model


def encode(texts):
    """返回 (vecs, queue_wait_ms, encode_ms)——排队与纯前向分开计时（2026-10-15 归因）。

    注：2026-10-15 实测「混合长度批拆单条前向」无收益（3800 字批：拆条 ~700ms vs
    整批 pad ~620-750ms，同噪声带）——瓶颈是每 token 线性项（分词+编组，CPU 侧），
    不是批内 padding；故维持整批单次前向，与原版数值路径一致。"""
    t_lock = time.time()
    with LOCK:
        queue_ms = (time.time() - t_lock) * 1000
        t_enc = time.time()
        out = MODEL.encode(
            texts,
            batch_size=ARGS.batch_size,
            max_length=ARGS.max_length,
            return_dense=True,
            return_sparse=False,
            return_colbert_vecs=False,
        )
        enc_ms = (time.time() - t_enc) * 1000
    # 显存优化（2026-10-15）：FlagEmbedding 每次 forward 的中间张量落进 PyTorch caching
    # allocator，长跑后 reserved 累积到 3.2G——而本服务真实工作集按文档实测只有 1.15G（fp16）。
    # 每次编码后归还缓存块：代价是下一次分配重走 cudaMalloc（微秒级），换来常驻显存下降。
    # 另在 unit 里开 PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True 抑制碎片。
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    return np.asarray(out["dense_vecs"], dtype=np.float32), queue_ms, enc_ms


# ── 去重缓存（2026-10-15 延迟修复）：插件联邦召回对同一批文本（主桶+父桶各自的
#    emb-cache）会连发两个内容完全相同的请求——单锁下第二个要白排第一个的队。
#    in-flight 合流：后到者等先到者编完直接拿结果；TTL 内重复请求直接命中。
_CACHE = {}  # key -> {"state": "inflight"|"done", "event": Event, "vecs", "q", "e", "ts"}
_CACHE_LOCK = threading.Lock()
_CACHE_TTL = 120.0
_CACHE_MAX = 512


def _cache_key(texts):
    return hashlib.sha1("\x00".join(texts).encode("utf-8")).hexdigest()


def encode_dedup(texts):
    """去重版 encode：返回 (vecs, queue_ms, encode_ms, hit)——hit∈{hit, join, miss}。

    事件语义（2026-10-15 v2，修 joiner 悬挂）：leader 持有的是它创建的那只 Event，
    完成/失败都 **set 原 Event**（joiner 拿的引用就是它）；失败时还要把 inflight 条目
    摘掉，joiner 二次检查不到 done 就自己升级成 leader 重编。"""
    key = _cache_key(texts)
    joined_wait = 0.0
    for attempt in range(2):
        created = None
        with _CACHE_LOCK:
            ent = _CACHE.get(key)
            if ent and ent["state"] == "done" and time.time() - ent["ts"] < _CACHE_TTL:
                return ent["vecs"], ent["q"], ent["e"], "hit"
            if ent and ent["state"] == "inflight" and attempt == 0:
                ev = ent["event"]
            else:
                created = threading.Event()
                if len(_CACHE) >= _CACHE_MAX:
                    _CACHE.pop(next(iter(_CACHE)))
                _CACHE[key] = {"state": "inflight", "event": created, "ts": time.time()}
        if created is None:  # 后到者：等先到者编完（不占 LOCK，不吃 GPU）
            t_w = time.time()
            ev.wait(timeout=120)
            joined_wait += (time.time() - t_w) * 1000
            with _CACHE_LOCK:
                ent = _CACHE.get(key)
                if ent and ent["state"] == "done":
                    return ent["vecs"], joined_wait, ent["e"], "join"
            continue  # 先到者失败/超时：自己当 leader 重编
        try:
            vecs, q, e = encode(texts)
        except Exception:
            with _CACHE_LOCK:
                if (_CACHE.get(key) or {}).get("event") is created:
                    _CACHE.pop(key, None)
            created.set()
            raise
        with _CACHE_LOCK:
            _CACHE[key] = {"state": "done", "event": created, "vecs": vecs, "q": q, "e": e, "ts": time.time()}
        created.set()
        return vecs, q, e, "miss"
    vecs, q, e = encode(texts)  # 兜底：两轮都没等到也没当上 leader
    return vecs, q, e, "miss"


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code: int, payload: dict):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # 健康检查（2026-10-15 起带排队/编码观测）
        if self.path.startswith("/health"):
            self._send(200, {"object": "list", "stats": stats_snapshot(), "data": [{"id": ARGS.model, "object": "model"}]})
        elif self.path.startswith("/v1/models"):
            self._send(200, {"object": "list", "data": [{"id": ARGS.model, "object": "model"}]})
        else:
            self._send(404, {"error": {"message": f"no route {self.path}"}})

    def do_POST(self):
        if not self.path.startswith("/v1/embeddings") and not self.path.startswith("/embeddings"):
            self._send(404, {"error": {"message": f"no route {self.path}"}})
            return
        try:
            t_body = time.time()
            n = int(self.headers.get("Content-Length", "0"))
            req = json.loads(self.rfile.read(n) or b"{}")
            body_ms = (time.time() - t_body) * 1000
            inp = req.get("input")
            texts = [inp] if isinstance(inp, str) else list(inp or [])
            if not texts:
                self._send(400, {"error": {"message": "input 为空"}})
                return
            t0 = time.time()
            vecs, queue_ms, enc_ms, hit = encode_dedup(texts)
            t_json = time.time()
            data = [
                {"object": "embedding", "index": i, "embedding": [float(x) for x in vecs[i]]}
                for i in range(len(texts))
            ]
            json_ms = (time.time() - t_json) * 1000
            self._send(200, {
                "object": "list",
                "data": data,
                "model": req.get("model") or ARGS.model,
                "usage": {"prompt_tokens": sum(len(t) for t in texts), "total_tokens": sum(len(t) for t in texts)},
                "local_elapsed_ms": round((time.time() - t0) * 1000, 1),
            })
            entry = {
                "ts": time.strftime("%H:%M:%S", time.localtime()) + f".{int(t0 % 1 * 1000):03d}",
                "n": len(texts),
                "chars": sum(len(t) for t in texts),
                "hit": hit,
                "body_ms": round(body_ms, 1),
                "wait_ms": round(queue_ms, 1),
                "encode_ms": round(enc_ms, 1),
                "json_ms": round(json_ms, 1),
                "total_ms": round((time.time() - t0) * 1000, 1),
            }
            note_request(entry)
            print(f"[req] {entry['ts']} from={self.client_address[1]} n={entry['n']} chars={entry['chars']} hit={hit} "
                  f"body={entry['body_ms']} wait={entry['wait_ms']} enc={entry['encode_ms']} "
                  f"json={entry['json_ms']} total={entry['total_ms']}", flush=True)
        except Exception as e:  # 明确报错，不静默
            with STATS_LOCK:
                STATS["errors"] += 1
            self._send(500, {"error": {"message": f"{type(e).__name__}: {e}"}})

    def log_message(self, fmt, *a):  # 降噪：只留错误
        if " 500 " in (fmt % a):
            print("[local-embed] " + fmt % a, flush=True)


def main():
    global ARGS, MODEL
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=8099)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--model", default="BAAI/bge-m3")
    p.add_argument("--device", default="cuda:0")
    p.add_argument("--no-fp16", dest="fp16", action="store_false")
    p.add_argument("--batch-size", type=int, default=32)
    p.add_argument("--max-length", type=int, default=8192)
    ARGS = p.parse_args()
    MODEL = load_model(ARGS.model, ARGS.device, ARGS.fp16)
    STATS["started_at"] = time.time()
    # 启动预热（2026-10-15）：首前向在内存压力下可冷到 4-6s，而注入路径嵌入超时只有
    # 3s——首个真实请求会因此超时回退远端。就绪前自己吃掉这次冷启动（任何失败都不挡启动）。
    try:
        encode(["启动预热：中长度文本预热前向，吃掉 CUDA 冷启动与首核编译。" * 60])
        print("[local-embed] 启动预热完成", flush=True)
    except Exception as e:  # 预热失败不挡启动
        print(f"[local-embed] 启动预热失败（忽略）：{type(e).__name__}: {e}", flush=True)
    srv = ThreadingHTTPServer((ARGS.host, ARGS.port), Handler)
    print(f"[local-embed] 监听 http://{ARGS.host}:{ARGS.port}/v1/embeddings", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
