"""野外地调资料检索 · 后端服务

seekdb 承担的部分（不可替换）：
  1. 存储 16 条点位
  2. SQL 内计算 Haversine 距离
  3. SQL 内做半径硬过滤
  4. SQL 内做关键词匹配
  5. SQL 内排序并截断候选池

Python 只负责：接收候选池 → RRF 融合两路排名 → 组装返回。
如果把 seekdb 换成 JSON 文件，第 2~5 步都得自己重写，功能才成立。

运行：python backend/app.py   → http://127.0.0.1:8000
"""

import math
import os
from typing import Optional

import pymysql
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

DB = dict(
    host=os.getenv("SEEKDB_HOST", "127.0.0.1"),
    port=int(os.getenv("SEEKDB_PORT", "2881")),
    user=os.getenv("SEEKDB_USER", "root"),
    password=os.getenv("SEEKDB_PASSWORD", ""),
    database=os.getenv("SEEKDB_DB", "field_survey"),
    charset="utf8mb4",
    cursorclass=pymysql.cursors.DictCursor,
)

CANDIDATE_LIMIT = 50
app = FastAPI(title="野外地调资料检索")


def query(sql, params=None):
    with pymysql.connect(**DB) as c, c.cursor() as cur:
        cur.execute(sql, params or {})
        return cur.fetchall()


# ---------------------------------------------------------------- SQL 组装

DIST_EXPR = """ROUND(6371 * 2 * ASIN(SQRT(
    POW(SIN(RADIANS(lat - %(lat)s) / 2), 2) +
    COS(RADIANS(%(lat)s)) * COS(RADIANS(lat)) *
    POW(SIN(RADIANS(lon - %(lon)s) / 2), 2)
)), 3)"""


def build_search_sql(terms, has_geo):
    """候选池完全由 seekdb 产出：距离、过滤、匹配、排序都在 SQL 里。"""
    dist = f"{DIST_EXPR} AS dist_km" if has_geo else "NULL AS dist_km"

    if terms:
        hit_expr = " + ".join(
            f"(name LIKE %(t{i})s OR kind LIKE %(t{i})s OR note LIKE %(t{i})s)"
            for i in range(len(terms))
        )
    else:
        hit_expr = "0"

    sql = f"""
        SELECT * FROM (
            SELECT id, name, kind, lat, lon, collected_at, elevation_m, note,
                   {dist},
                   ({hit_expr}) AS kw_hit
            FROM records
        ) t
    """
    if has_geo:
        sql += " WHERE t.dist_km <= %(max_km)s"
    sql += """ ORDER BY t.kw_hit DESC, t.dist_km IS NULL, t.dist_km ASC, t.id ASC
               LIMIT %(lim)s"""
    return sql


# ---------------------------------------------------------------- 融合

def rrf(rank_lists, k=60):
    """Reciprocal Rank Fusion。两路 id 必须同源，否则融合会静默失效。"""
    scores = {}
    for ranking in rank_lists:
        for rank, rid in enumerate(ranking):
            scores[rid] = scores.get(rid, 0.0) + 1.0 / (k + rank + 1)
    return sorted(scores.items(), key=lambda x: -x[1])


def haversine_km(lat1, lon1, lat2, lon2):
    r = math.pi / 180
    dphi = (lat2 - lat1) * r
    dlam = (lon2 - lon1) * r
    a = (math.sin(dphi / 2) ** 2
         + math.cos(lat1 * r) * math.cos(lat2 * r) * math.sin(dlam / 2) ** 2)
    return 2 * 6371.0 * math.asin(math.sqrt(a))


# ---------------------------------------------------------------- 接口

@app.get("/api/records")
def api_records():
    return {"items": query(
        "SELECT id, name, kind, lat, lon, collected_at, elevation_m, note "
        "FROM records ORDER BY id")}


@app.get("/api/search")
def api_search(q: str = "", lat: Optional[float] = None,
               lon: Optional[float] = None, max_km: float = 10.0,
               topk: int = 6):
    terms = [t for t in q.split() if t]
    has_geo = lat is not None and lon is not None

    params = {"lim": CANDIDATE_LIMIT}
    if has_geo:
        params.update(lat=lat, lon=lon, max_km=max_km)
    for i, t in enumerate(terms):
        params[f"t{i}"] = f"%{t}%"

    # ← 这一步开始，工作全部发生在 seekdb 里
    rows = query(build_search_sql(terms, has_geo), params)
    if not rows:
        return {"items": [], "total": 0, "note": "没有命中的检索条件"}

    kw_rank = [r["id"] for r in sorted(rows, key=lambda x: -x["kw_hit"]) if r["kw_hit"] > 0]
    geo_rank = ([r["id"] for r in sorted(rows, key=lambda x: x["dist_km"])]
                if has_geo else [])
    rank_lists = [x for x in (kw_rank, geo_rank) if x]
    if not rank_lists:
        return {"items": [], "total": 0, "note": "没有命中的检索条件"}

    by_id = {r["id"]: r for r in rows}
    items = [by_id[rid] for rid, _ in rrf(rank_lists)][:topk]
    for it in items:
        it["reason"] = _reason(it, terms)
    return {"items": items, "total": len(items)}


def _reason(it, terms):
    bits = []
    text = f"{it['name']} {it['kind']} {it['note'] or ''}"
    if terms and it["kw_hit"]:
        bits.append("命中关键词 " + "、".join(t for t in terms if t in text))
    if it["dist_km"] is not None:
        bits.append(f"距离 {it['dist_km']} km")
    return " · ".join(bits) or "按相关性排序"


# ---------------------------------------------------------------- 静态页

app.mount("/static", StaticFiles(directory="site"), name="static")


@app.get("/")
def index():
    return FileResponse("site/index.html")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
