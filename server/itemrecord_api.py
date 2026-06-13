"""
库存商品 — VM 后端 API（端口 8081）
- GET  /health
- GET  /api/categories        → 返回 categories.json
- GET  /api/records           → 返回所有存货记录
- POST /api/records           → append-only 保存一条记录（UUID 幂等）
- POST /api/categories/update → AI 生成新分类规则（ollama launch claude + gemma4）

并发安全：
  存货记录：asyncio.Lock + .jsonl append（OS 原子 append）+ UUID 幂等
  分类更新：全局锁（同时只能跑一个 AI 任务）+ tmp→replace 原子写文件
"""

import asyncio
import json
import os
import subprocess
import sys
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ── 路径配置 ────────────────────────────────────────────────────────────────
BASE_DIR        = Path("/home/ubuntu/itemrecord")
RECORDS_FILE    = BASE_DIR / "records.jsonl"
CATEGORIES_FILE = BASE_DIR / "data" / "categories.json"
PRODUCTS_FILE   = BASE_DIR / "data" / "products.json"
SCRIPTS_DIR     = BASE_DIR / "ai_scripts"       # AI 生成的临时 Python 脚本存放处

OLLAMA          = "ollama"
MODEL           = "gemma4:31b-cloud"
CLAUDE_HOME     = "/home/ubuntu/.chatbot-claude"   # 复用 d2l 的沙盒用户

# ── 锁 ──────────────────────────────────────────────────────────────────────
_records_lock  = asyncio.Lock()
_ai_lock       = asyncio.Lock()       # 同时只能跑一个 AI 分类任务
_ai_session_id: str | None = None     # 跨请求 resume（若上次任务失败可续）

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── 基础路由 ─────────────────────────────────────────────────────────────────
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


# ── 存货记录（append-only + UUID 幂等） ─────────────────────────────────────
class RecordIn(BaseModel):
    id: str                 # 客户端生成的 UUID
    person: str
    submittedAt: str        # ISO 8601
    items: list[dict]


@app.post("/api/records")
async def save_record(rec: RecordIn):
    if not rec.id or not rec.person or not rec.items:
        raise HTTPException(status_code=400, detail="id/person/items required")

    async with _records_lock:
        RECORDS_FILE.parent.mkdir(parents=True, exist_ok=True)

        # 幂等检查：同一 UUID 已存在直接返回成功
        if RECORDS_FILE.exists():
            for line in RECORDS_FILE.read_text().splitlines():
                try:
                    if json.loads(line).get("id") == rec.id:
                        return {"ok": True, "duplicate": True}
                except json.JSONDecodeError:
                    pass

        entry = rec.model_dump()
        entry["savedAt"] = datetime.now(timezone.utc).isoformat()

        # append 对小写入是 OS 原子操作，不会 overwrite 其他并发写入
        with open(RECORDS_FILE, "a") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    return {"ok": True, "duplicate": False}


# ── AI 分类更新 ───────────────────────────────────────────────────────────────
class CategoryUpdateRequest(BaseModel):
    instruction: str        # 用户的自然语言指令（中文）
    session_id: str | None = None   # 可传上次失败的 session_id 来续对话


class CategoryUpdateResponse(BaseModel):
    ok: bool
    session_id: str
    message: str            # 给前端显示的结果摘要
    stats: dict | None = None       # {total, per_category, uncategorized}
    error: str | None = None


@app.post("/api/categories/update", response_model=CategoryUpdateResponse)
async def update_categories(req: CategoryUpdateRequest):
    if _ai_lock.locked():
        raise HTTPException(status_code=409, detail="AI 分类任务正在进行中，请稍后再试")

    if not PRODUCTS_FILE.exists():
        raise HTTPException(status_code=500, detail=f"找不到商品数据：{PRODUCTS_FILE}")

    products = json.loads(PRODUCTS_FILE.read_text())
    current_cats = json.loads(CATEGORIES_FILE.read_text()) if CATEGORIES_FILE.exists() else {}

    async with _ai_lock:
        session_id, new_cats, stats, error = await _run_ai_categorize(
            instruction=req.instruction,
            products=products,
            current_categories=current_cats,
            session_id=req.session_id,
        )

        if error:
            return CategoryUpdateResponse(
                ok=False,
                session_id=session_id,
                message=f"AI 生成失败：{error}",
                error=error,
            )

        # 原子替换：写临时文件 → os.replace（同目录，POSIX 原子）
        tmp = CATEGORIES_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(new_cats, ensure_ascii=False, indent=2))
        os.replace(tmp, CATEGORIES_FILE)

        return CategoryUpdateResponse(
            ok=True,
            session_id=session_id,
            message="分类规则已更新",
            stats=stats,
        )


# ── AI 核心逻辑 ───────────────────────────────────────────────────────────────
SYSTEM_PROMPT = """你是一个库存分类助手。你的唯一任务是：
1. 阅读商品列表（products.json）和当前分类规则（categories.json）
2. 根据用户的指令，生成一段 Python 代码，运行该代码将产生新的 categories.json
3. 确保每个商品都被正确分类，未分类商品尽可能少

你只能使用 Read 和 Bash 工具（仅用于运行你自己生成的 Python 代码）。
禁止访问 categories.json 以外的路径，禁止执行任何网络请求。

Python 代码要求：
- 读取 /home/ubuntu/itemrecord/data/products.json 获取完整商品列表
- 定义新的分类规则（keyword 匹配，支持多标签，一个商品可归入多个分类）
- 将结果写入 /home/ubuntu/itemrecord/ai_output_categories.json
- 最后打印统计：每个分类的商品数、未分类商品数和名称列表

输出格式（最终 JSON）必须严格符合：
{
  "version": <整数，比当前版本+1>,
  "name": "默认分类",
  "uncategorizedLabel": "未分类",
  "categories": [
    {
      "id": "<英文字母，无空格>",
      "name": "<中文分类名>",
      "keywords": ["关键词1", "关键词2"],
      "children": []   // 可以有子分类，也可以为空数组
    }
  ]
}"""


async def _run_ai_categorize(
    instruction: str,
    products: list[dict],
    current_categories: dict,
    session_id: str | None,
    max_retries: int = 2,
) -> tuple[str, dict | None, dict | None, str | None]:
    """
    调用 ollama launch claude（gemma4:31b-cloud），让 AI 生成 Python 分类脚本并运行。
    返回 (session_id, new_categories_dict, stats, error_or_None)
    """
    SCRIPTS_DIR.mkdir(parents=True, exist_ok=True)

    product_names = [p["name"] for p in products]
    current_version = current_categories.get("version", 0)

    prompt = f"""用户指令：{instruction}

当前分类规则（categories.json）：
{json.dumps(current_categories, ensure_ascii=False, indent=2)}

商品总数：{len(products)} 件
完整商品名称列表：
{json.dumps(product_names, ensure_ascii=False, indent=2)}

请按照以下步骤操作：
1. 分析用户指令，理解需要如何调整分类规则
2. 编写一个 Python 脚本（使用 Bash 工具运行），该脚本：
   a. 读取 /home/ubuntu/itemrecord/data/products.json
   b. 按照新的分类逻辑对每个商品进行分类
   c. 生成符合格式要求的新 categories.json（version 设为 {current_version + 1}）
   d. 将结果写入 /home/ubuntu/itemrecord/ai_output_categories.json
   e. 打印每个分类的商品数和未分类商品列表
3. 运行脚本，确认输出正确
4. 如果未分类商品超过 10 个，检查是否有关键词遗漏，调整后重新运行

安全检查：运行后验证 ai_output_categories.json 中记录的商品总数等于 {len(products)}（多标签商品可以出现在多个分类，未分类商品只出现一次）。"""

    attempts = 0
    last_session = session_id

    while attempts <= max_retries:
        attempts += 1

        claude_cmd = [
            OLLAMA, "launch", "claude",
            "--model", MODEL,
            "--yes",
            "--",
            "-p", prompt,
            "--output-format", "json",
            "--permission-mode", "default",   # 需要 Bash 运行 Python 脚本
            "--effort", "normal",
            "--append-system-prompt", SYSTEM_PROMPT,
            "--allowedTools", "Read,Bash",
        ]
        if last_session:
            claude_cmd.extend(["--resume", last_session])

        cmd = [
            "sudo", "-u", "chatbot",
            "env",
            f"HOME={CLAUDE_HOME}",
            "PATH=/home/ubuntu/.local/bin:/usr/local/bin:/usr/bin:/bin",
        ] + claude_cmd

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(BASE_DIR),
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=300)
        except asyncio.TimeoutError:
            return last_session or "", None, None, "AI 响应超时（5分钟）"
        except Exception as e:
            return last_session or "", None, None, str(e)

        output = stdout.decode("utf-8", errors="replace").strip()

        # 解析 claude CLI 的 JSON 输出
        try:
            result = json.loads(output)
            last_session = result.get("session_id", last_session or "")
        except json.JSONDecodeError:
            last_session = last_session or ""

        # 检查 AI 生成的输出文件
        ai_output = BASE_DIR / "ai_output_categories.json"
        if not ai_output.exists():
            if attempts <= max_retries:
                prompt = f"上次运行没有生成 ai_output_categories.json 文件，请检查脚本并重新运行。错误可能在脚本的写文件部分。"
                continue
            return last_session, None, None, "AI 未生成输出文件"

        try:
            new_cats = json.loads(ai_output.read_text())
        except json.JSONDecodeError as e:
            if attempts <= max_retries:
                prompt = f"生成的 JSON 文件格式错误：{e}，请修复脚本并重新运行。"
                continue
            return last_session, None, None, f"输出 JSON 格式错误：{e}"

        # 验证基本结构
        if "categories" not in new_cats:
            if attempts <= max_retries:
                prompt = "输出的 JSON 缺少 categories 字段，请修复。"
                continue
            return last_session, None, None, "输出 JSON 缺少 categories 字段"

        # 计算统计（用于前端显示）
        stats = _compute_stats(products, new_cats)

        # 安全检查：未分类超过 20% 时警告但不阻止（让前端展示给用户判断）
        uncat_ratio = stats["uncategorized"] / max(len(products), 1)
        if uncat_ratio > 0.20 and attempts <= max_retries:
            prompt = (
                f"警告：{stats['uncategorized']} 件商品未分类（占 {uncat_ratio:.0%}），"
                f"未分类商品名称：{json.dumps(stats['uncategorized_names'][:20], ensure_ascii=False)}，"
                f"请检查关键词是否有遗漏，修改后重新运行。"
            )
            continue

        # 清理临时文件
        ai_output.unlink(missing_ok=True)

        return last_session, new_cats, stats, None

    return last_session or "", None, None, f"经过 {max_retries + 1} 次尝试仍未通过验证"


def _compute_stats(products: list[dict], categories: dict) -> dict:
    """计算每个分类的商品数和未分类商品列表。"""
    cats = categories.get("categories", [])
    per_cat: dict[str, int] = {}
    uncategorized_names: list[str] = []

    for p in products:
        name = p["name"].lower()
        matched = False
        for cat in cats:
            kws = [k.lower() for k in cat.get("keywords", [])]
            if any(k in name for k in kws):
                per_cat[cat["name"]] = per_cat.get(cat["name"], 0) + 1
                matched = True
        if not matched:
            uncategorized_names.append(p["name"])

    return {
        "total": len(products),
        "per_category": per_cat,
        "uncategorized": len(uncategorized_names),
        "uncategorized_names": uncategorized_names,
    }
