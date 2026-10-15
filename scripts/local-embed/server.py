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
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

ARGS = None
MODEL = None
LOCK = threading.Lock()  # 单卡串行：并发请求排队，避免显存抖动


def load_model(model_id: str, device: str, fp16: bool):
    from FlagEmbedding import BGEM3FlagModel

    devices = [device] if device and device != "cpu" else None
    t0 = time.time()
    model = BGEM3FlagModel(model_id, use_fp16=fp16, devices=devices)
    print(f"[local-embed] 模型就绪 {model_id} device={device} fp16={fp16} 用时 {time.time() - t0:.1f}s", flush=True)
    return model


def encode(texts):
    with LOCK:
        out = MODEL.encode(
            texts,
            batch_size=ARGS.batch_size,
            max_length=ARGS.max_length,
            return_dense=True,
            return_sparse=False,
            return_colbert_vecs=False,
        )
    return np.asarray(out["dense_vecs"], dtype=np.float32)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code: int, payload: dict):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # 健康检查
        if self.path.startswith(("/health", "/v1/models")):
            self._send(200, {"object": "list", "data": [{"id": ARGS.model, "object": "model"}]})
        else:
            self._send(404, {"error": {"message": f"no route {self.path}"}})

    def do_POST(self):
        if not self.path.startswith("/v1/embeddings") and not self.path.startswith("/embeddings"):
            self._send(404, {"error": {"message": f"no route {self.path}"}})
            return
        try:
            n = int(self.headers.get("Content-Length", "0"))
            req = json.loads(self.rfile.read(n) or b"{}")
            inp = req.get("input")
            texts = [inp] if isinstance(inp, str) else list(inp or [])
            if not texts:
                self._send(400, {"error": {"message": "input 为空"}})
                return
            t0 = time.time()
            vecs = encode(texts)
            data = [
                {"object": "embedding", "index": i, "embedding": [float(x) for x in vecs[i]]}
                for i in range(len(texts))
            ]
            self._send(200, {
                "object": "list",
                "data": data,
                "model": req.get("model") or ARGS.model,
                "usage": {"prompt_tokens": sum(len(t) for t in texts), "total_tokens": sum(len(t) for t in texts)},
                "local_elapsed_ms": round((time.time() - t0) * 1000, 1),
            })
        except Exception as e:  # 明确报错，不静默
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
    srv = ThreadingHTTPServer((ARGS.host, ARGS.port), Handler)
    print(f"[local-embed] 监听 http://{ARGS.host}:{ARGS.port}/v1/embeddings", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
