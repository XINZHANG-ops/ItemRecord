"""
库存商品 — VM 后端 API（端口 8080）
- GET  /health
- GET  /api/categories              → 返回 categories.json
- GET  /api/records                 → 返回所有存货记录
- POST /api/records                 → append-only 保存一条记录（UUID 幂等）
- POST /api/categories/update       → AI 更新分类（Ollama HTTP + 手动 messages 历史）
- GET  /api/categories/history      → 查看当前对话历史轮数
- DELETE /api/categories/history    → 清除对话历史（重新开始）

并发安全：
  存货记录：asyncio.Lock + .jsonl append（OS 原子 append）+ UUID 幂等
  分类更新：全局锁（同时只能跑一个 AI 任务）+ tmp→replace 原子写文件
"""

import asyncio
import json
import os
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ── 路径配置 ─────────────────────────────────────────────────────────────────
BASE_DIR        = Path("/home/ubuntu/itemrecord")
RECORDS_FILE    = BASE_DIR / "records.jsonl"
CATEGORIES_FILE = BASE_DIR / "data" / "categories.json"
PRODUCTS_FILE   = BASE_DIR / "data" / "products.json"
HISTORY_FILE    = BASE_DIR / "ai_chat_history.json"   # 持久化对话历史
SCRIPT_FILE     = BASE_DIR / "ai_categorize.py"       # AI 生成的分类脚本（可查看调试）

OLLAMA_URL      = "http://localhost:11434/api/chat"
MODEL           = "kimi-k2.7-code:cloud"   # 主分类模型（写 Python 代码）
COMPACT_MODEL   = "kimi-k2.6:cloud"        # 对话历史压缩模型

# ── 锁 ───────────────────────────────────────────────────────────────────────
_records_lock   = asyncio.Lock()
_ai_lock        = asyncio.Lock()   # 同时只能跑一个 AI 任务
_compact_event  = asyncio.Event()  # 压缩完成后通知等待的请求
_compact_event.set()               # 初始状态：未压缩中，可以直接通过

COMPACT_THRESHOLD = 20             # messages 总数超过此值触发压缩

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── 系统提示 ──────────────────────────────────────────────────────────────────
SYSTEM_PROMPT = """你是一个库存商品分类助手。

你的工作流程：
1. 用户会描述他们希望如何分类商品（自然语言，中文）
2. 你需要输出一段 Python 代码，该代码读取商品列表并生成新的分类规则 JSON
3. 代码必须可以直接运行，不需要任何额外依赖（只用标准库）

Python 代码要求：
- 在代码开头用注释说明分类逻辑
- 读取商品列表（已作为变量 `products` 传入，是一个 list of dict，每个 dict 有 "barcode" 和 "name" 字段）
- 用关键词匹配对每件商品分类（一件商品可以属于多个分类）
- 输出一个符合格式的 categories dict，赋值给变量 `result`

输出的 `result` 格式必须严格是：
{
  "version": <整数>,
  "name": "默认分类",
  "uncategorizedLabel": "未分类",
  "categories": [
    {
      "id": "<纯英文小写，无空格，如 classic>",
      "name": "<中文分类名>",
      "keywords": ["关键词1", "关键词2"],
      "catchAll": false,   // 可选，见下方说明
      "children": []
    }
  ]
}

特别说明 catchAll：
- 如果某个分类的含义是"其他所有商品"（不属于其他任何分类），将 "catchAll" 设为 true，keywords 设为空数组 []
- catchAll 分类会自动包含所有未被其他分类 keywords 匹配到的商品，不需要也不能用 keywords 来定义
- 每个 result 中最多只能有一个 catchAll 分类，且应放在 categories 列表的最后

回复格式：
- 先简短说明你的分类逻辑（1-3句话）
- 然后输出代码块，用 ```python 和 ``` 包裹
- 代码块之后不需要额外解释

重要：keywords 是用于前端实时筛选的，应该是商品名称中实际出现的关键词，不要用太宽泛或太罕见的词。"""


# ── 对话历史管理 ──────────────────────────────────────────────────────────────
def _load_history() -> list[dict]:
    try:
        return json.loads(HISTORY_FILE.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def _save_history(messages: list[dict]) -> None:
    HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)
    HISTORY_FILE.write_text(json.dumps(messages, ensure_ascii=False, indent=2))


async def _compact_history_if_needed(history: list[dict]) -> list[dict]:
    """
    当 messages 总数超过阈值时，调用 Ollama 压缩对话历史。
    压缩期间用 _compact_event 阻塞后续 AI 请求。
    返回压缩后（或不需要压缩时原样返回）的 history。
    """
    if len(history) < COMPACT_THRESHOLD:
        return history

    _compact_event.clear()  # 通知其他请求等待
    try:
        compact_prompt = (
            "请把以下对话历史压缩成一段简洁的摘要，保留所有已确定的分类规则和关键词决策，"
            "丢弃中间的试错过程和重复内容。摘要将作为后续对话的上下文。\n\n"
            "对话历史：\n" +
            "\n".join(
                f"[{m['role'].upper()}]: {m['content'][:300]}{'...' if len(m['content']) > 300 else ''}"
                for m in history
            )
        )
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(OLLAMA_URL, json={
                "model": COMPACT_MODEL,
                "messages": [
                    {"role": "system", "content": "你是一个摘要助手，请用中文输出压缩后的对话摘要。"},
                    {"role": "user", "content": compact_prompt},
                ],
                "stream": False,
            })
        summary = resp.json()["message"]["content"]
        compacted = [{"role": "assistant", "content": f"[对话历史摘要]\n{summary}"}]
        _save_history(compacted)
        return compacted
    except Exception:
        # 压缩失败时只截取最近 10 条，不影响主流程
        trimmed = history[-10:]
        _save_history(trimmed)
        return trimmed
    finally:
        _compact_event.set()  # 解除阻塞


# ── 基础路由 ──────────────────────────────────────────────────────────────────
@app.get("/health")
async def health():
    return {"status": "ok", "ai_busy": _ai_lock.locked()}


@app.get("/api/categories")
async def get_categories():
    if not CATEGORIES_FILE.exists():
        raise HTTPException(status_code=404, detail="categories.json not found")
    return json.loads(CATEGORIES_FILE.read_text())


@app.get("/api/records")
async def get_records():
    if not RECORDS_FILE.exists():
        return []
    records = []
    for line in RECORDS_FILE.read_text().splitlines():
        line = line.strip()
        if line:
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return records


# ── 存货记录（append-only + UUID 幂等） ──────────────────────────────────────
class RecordIn(BaseModel):
    id: str
    person: str
    submittedAt: str
    items: list[dict]


@app.post("/api/records")
async def save_record(rec: RecordIn):
    if not rec.id or not rec.person or not rec.items:
        raise HTTPException(status_code=400, detail="id/person/items required")

    async with _records_lock:
        RECORDS_FILE.parent.mkdir(parents=True, exist_ok=True)
        if RECORDS_FILE.exists():
            for line in RECORDS_FILE.read_text().splitlines():
                try:
                    if json.loads(line).get("id") == rec.id:
                        return {"ok": True, "duplicate": True}
                except json.JSONDecodeError:
                    pass

        entry = rec.model_dump()
        entry["savedAt"] = datetime.now(timezone.utc).isoformat()
        with open(RECORDS_FILE, "a") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    return {"ok": True, "duplicate": False}


@app.delete("/api/records")
async def clear_records():
    """清空所有存货记录（不可恢复）。"""
    async with _records_lock:
        cleared = 0
        if RECORDS_FILE.exists():
            cleared = sum(1 for line in RECORDS_FILE.read_text().splitlines() if line.strip())
            RECORDS_FILE.unlink()
    return {"ok": True, "cleared": cleared}


# ── AI 分类历史管理 ───────────────────────────────────────────────────────────
@app.get("/api/categories/history")
async def get_history():
    history = _load_history()
    # 只返回元数据，不返回完整内容（可能很长）
    return {
        "turns": len([m for m in history if m["role"] == "user"]),
        "messages": len(history),
    }


@app.delete("/api/categories/history")
async def clear_history():
    HISTORY_FILE.unlink(missing_ok=True)
    return {"ok": True, "message": "对话历史已清除，下次从零开始"}


# ── AI 分类更新 ───────────────────────────────────────────────────────────────
class CategoryUpdateRequest(BaseModel):
    instruction: str


class CategoryUpdateResponse(BaseModel):
    ok: bool
    message: str
    stats: dict | None = None
    history_turns: int = 0
    error: str | None = None


@app.post("/api/categories/update", response_model=CategoryUpdateResponse)
async def update_categories(req: CategoryUpdateRequest):
    # 先判忙再立即加锁，两步之间无 await，保证 409 可靠（asyncio 协作式调度）
    if _ai_lock.locked():
        raise HTTPException(status_code=409, detail="AI 分类任务正在进行中，请稍后再试")
    if not PRODUCTS_FILE.exists():
        raise HTTPException(status_code=500, detail=f"找不到商品数据：{PRODUCTS_FILE}")

    async with _ai_lock:
        # 等待正在进行的压缩完成（最多等 2 分钟）
        await asyncio.wait_for(_compact_event.wait(), timeout=120)

        products = json.loads(PRODUCTS_FILE.read_text())
        current_cats = json.loads(CATEGORIES_FILE.read_text()) if CATEGORIES_FILE.exists() else {}

        new_cats, stats, error, history = await _run_ai_categorize(
            instruction=req.instruction,
            products=products,
            current_categories=current_cats,
        )

        turns = len([m for m in history if m["role"] == "user"])

        if error:
            return CategoryUpdateResponse(
                ok=False,
                message=f"AI 生成失败：{error}",
                error=error,
                history_turns=turns,
            )

        # 原子替换 categories.json
        tmp = CATEGORIES_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(new_cats, ensure_ascii=False, indent=2))
        os.replace(tmp, CATEGORIES_FILE)

        return CategoryUpdateResponse(
            ok=True,
            message="分类规则已更新",
            stats=stats,
            history_turns=turns,
        )


# ── AI 核心：Ollama HTTP + 手动 messages 历史 ─────────────────────────────────
async def _run_ai_categorize(
    instruction: str,
    products: list[dict],
    current_categories: dict,
    max_retries: int = 2,
) -> tuple[dict | None, dict | None, str | None, list[dict]]:
    """
    调用 Ollama /api/chat，手动维护 messages 列表实现多轮对话记忆。
    返回 (new_categories, stats, error, full_history)
    """
    history = _load_history()

    # 超过阈值时先压缩（会阻塞其他并发请求直到完成）
    history = await _compact_history_if_needed(history)

    current_version = current_categories.get("version", 0)
    product_names = [p["name"] for p in products]

    # 构建本次用户消息：包含当前分类状态 + 用户指令
    # 只在第一轮（history 为空）时附上完整商品列表，后续只传指令（模型已有上下文）
    if not history:
        user_content = f"""当前分类规则：
{json.dumps(current_categories, ensure_ascii=False, indent=2)}

完整商品列表（共 {len(products)} 件）：
{json.dumps(product_names, ensure_ascii=False, indent=2)}

用户指令：{instruction}

请生成 Python 代码，version 设为 {current_version + 1}。"""
    else:
        user_content = f"""当前分类规则（已更新到 version {current_version}）：
{json.dumps(current_categories, ensure_ascii=False, indent=2)}

用户新指令：{instruction}

请在上次基础上调整，生成新的 Python 代码，version 设为 {current_version + 1}。"""

    history.append({"role": "user", "content": user_content})

    messages = [{"role": "system", "content": SYSTEM_PROMPT}] + history

    attempt = 0
    ai_reply = ""

    while attempt <= max_retries:
        attempt += 1

        # 调用 Ollama
        try:
            async with httpx.AsyncClient(timeout=180.0) as client:
                resp = await client.post(OLLAMA_URL, json={
                    "model": MODEL,
                    "messages": messages,
                    "stream": False,
                })
            resp.raise_for_status()
            ai_reply = resp.json()["message"]["content"]
        except httpx.TimeoutException:
            _save_history(history)
            return None, None, "Ollama 请求超时（3分钟）", history
        except Exception as e:
            _save_history(history)
            return None, None, f"Ollama 请求失败：{e}", history

        # 从回复中提取 Python 代码块
        code = _extract_code(ai_reply)
        if not code:
            if attempt <= max_retries:
                messages.append({"role": "assistant", "content": ai_reply})
                messages.append({"role": "user", "content": "你的回复里没有找到 ```python 代码块，请重新输出包含完整代码的回复。"})
                continue
            history.append({"role": "assistant", "content": ai_reply})
            _save_history(history)
            return None, None, "AI 未输出有效的 Python 代码块", history

        # 运行代码，注入 products 变量
        new_cats, run_error = _run_categorize_code(code, products, current_version + 1)

        if run_error:
            if attempt <= max_retries:
                messages.append({"role": "assistant", "content": ai_reply})
                messages.append({"role": "user", "content": f"代码运行出错：{run_error}\n请修复后重新输出完整代码。"})
                continue
            history.append({"role": "assistant", "content": ai_reply})
            _save_history(history)
            return None, None, f"代码运行失败：{run_error}", history

        # 验证结构
        if "categories" not in new_cats:
            if attempt <= max_retries:
                messages.append({"role": "assistant", "content": ai_reply})
                messages.append({"role": "user", "content": "result 变量缺少 categories 字段，请修复代码。"})
                continue
            history.append({"role": "assistant", "content": ai_reply})
            _save_history(history)
            return None, None, "输出缺少 categories 字段", history

        stats = _compute_stats(products, new_cats)
        uncat_ratio = stats["uncategorized"] / max(len(products), 1)

        if uncat_ratio > 0.20 and attempt <= max_retries:
            uncat_sample = json.dumps(stats["uncategorized_names"][:15], ensure_ascii=False)
            messages.append({"role": "assistant", "content": ai_reply})
            messages.append({"role": "user", "content":
                f"未分类商品太多（{stats['uncategorized']} 件，占 {uncat_ratio:.0%}）。"
                f"未分类商品举例：{uncat_sample}。请检查关键词是否有遗漏，修改后重新输出完整代码。"
            })
            continue

        # 成功：把 AI 回复存入历史（不含自动校验的追问，保持对话清晰）
        history.append({"role": "assistant", "content": ai_reply})
        _save_history(history)

        # 保存脚本方便调试
        SCRIPT_FILE.write_text(code)

        return new_cats, stats, None, history

    history.append({"role": "assistant", "content": ai_reply})
    _save_history(history)
    return None, None, f"经过 {max_retries + 1} 次尝试仍未通过验证", history


def _extract_code(text: str) -> str | None:
    """从 AI 回复中提取第一个 ```python ... ``` 代码块。"""
    import re
    m = re.search(r"```python\s*(.*?)```", text, re.DOTALL)
    return m.group(1).strip() if m else None


def _run_categorize_code(code: str, products: list[dict], new_version: int) -> tuple[dict | None, str | None]:
    """
    在独立进程中运行 AI 生成的 Python 代码。
    代码可以直接使用 `products` 变量（list of dict），最终把结果赋给 `result`。
    返回 (result_dict, error_or_None)
    """
    wrapper = f"""
import json

products = {json.dumps(products, ensure_ascii=False)}

{code}

# 确保 version 正确
if isinstance(result, dict):
    result['version'] = {new_version}
    print('__RESULT__' + json.dumps(result, ensure_ascii=False))
else:
    print('__ERROR__result 变量不是 dict')
"""
    try:
        proc = subprocess.run(
            ["python3", "-c", wrapper],
            capture_output=True, text=True, timeout=30,
        )
        output = proc.stdout + proc.stderr
        if "__RESULT__" in proc.stdout:
            json_str = proc.stdout.split("__RESULT__", 1)[1].strip()
            return json.loads(json_str), None
        elif "__ERROR__" in proc.stdout:
            return None, proc.stdout.split("__ERROR__", 1)[1].strip()
        else:
            err = (proc.stderr or proc.stdout or "无输出").strip()[:500]
            return None, err
    except subprocess.TimeoutExpired:
        return None, "代码运行超时（30秒）"
    except Exception as e:
        return None, str(e)


def _compute_stats(products: list[dict], categories: dict) -> dict:
    cats = categories.get("categories", [])
    normal_cats = [c for c in cats if not c.get("catchAll")]
    catchall_cat = next((c for c in cats if c.get("catchAll")), None)
    per_cat: dict[str, int] = {}
    uncategorized_names: list[str] = []

    for p in products:
        name = p["name"].lower()
        matched = False
        for cat in normal_cats:
            kws = [k.lower() for k in cat.get("keywords", [])]
            if any(k in name for k in kws):
                per_cat[cat["name"]] = per_cat.get(cat["name"], 0) + 1
                matched = True
        if not matched:
            if catchall_cat:
                per_cat[catchall_cat["name"]] = per_cat.get(catchall_cat["name"], 0) + 1
            else:
                uncategorized_names.append(p["name"])

    return {
        "total": len(products),
        "per_category": per_cat,
        "uncategorized": len(uncategorized_names),
        "uncategorized_names": uncategorized_names,
    }
