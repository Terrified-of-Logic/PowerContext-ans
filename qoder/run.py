#!/usr/bin/env python3
"""野外地调资料检索 · 运行入口

三个模式，都不需要 mysql 客户端：

    python3 run.py init     建库 + 建表 + 导入 16 条示例数据
    python3 run.py verify   自检：跑 4 组查询，打印结果供核对
    python3 run.py serve    启动 Web 服务（需要 fastapi + uvicorn）

连接参数用环境变量传：
    SEEKDB_HOST / SEEKDB_PORT / SEEKDB_USER / SEEKDB_PASSWORD / SEEKDB_DB

兼容 Python 3.7+（init / verify 只需要 pymysql）。
"""

import math
import os
import re
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
SCHEMA = os.path.join(ROOT, "seekdb", "schema.sql")

CFG = dict(
    host=os.getenv("SEEKDB_HOST", "127.0.0.1"),
    port=int(os.getenv("SEEKDB_PORT", "2881")),
    user=os.getenv("SEEKDB_USER", "root"),
    password=os.getenv("SEEKDB_PASSWORD", ""),
    charset="utf8mb4",
    ssl=({} if os.getenv("SEEKDB_SSL", "") == "1" else None),
)
DBNAME = os.getenv("SEEKDB_DB", "field_survey")

EMBEDDED = os.getenv("SEEKDB_EMBEDDED", "") == "1"
EMBED_PATH = os.getenv("SEEKDB_EMBED_PATH", os.path.join(ROOT, "seekdb.db"))
_embed = None


def need_pymysql():
    try:
        import pymysql
        return pymysql
    except ImportError:
        sys.exit("缺少 pymysql：请先执行  python3 -m pip install pymysql")


def connect(with_db=False):
    """两种连接方式：
      默认    —— 连远端 seekdb（SEEKDB_HOST / SEEKDB_PORT）
      SEEKDB_EMBEDDED=1 —— 用 pylibseekdb 在本地起一个嵌入式库，不需要服务器
    """
    pymysql = need_pymysql()

    if EMBEDDED:
        global _embed
        if _embed is None:
            try:
                import pylibseekdb
            except ImportError:
                sys.exit("缺少 pylibseekdb：请先执行  python3 -m pip install pylibseekdb")
            _embed = pylibseekdb.open(EMBED_PATH)
            tell("嵌入式 seekdb 已打开：%s" % EMBED_PATH)
        kw = dict(_embed.connection_options())
        kw["charset"] = "utf8mb4"
        if with_db:
            kw["database"] = DBNAME
        return pymysql.connect(**kw)

    kw = dict(CFG)
    if with_db:
        kw["database"] = DBNAME
    return pymysql.connect(**kw)


def tell(msg):
    print(msg)


# ---------------------------------------------------------------- init

def split_sql(text):
    """按分号切分，跳过注释与空行。返回语句列表。"""
    lines = []
    for ln in text.splitlines():
        s = ln.strip()
        if not s or s.startswith("--"):
            continue
        lines.append(ln)
    body = "\n".join(lines)
    return [s.strip() for s in body.split(";") if s.strip()]


def cmd_init():
    if not os.path.exists(SCHEMA):
        sys.exit("找不到 %s" % SCHEMA)

    stmts = split_sql(open(SCHEMA, encoding="utf-8").read())
    # 只执行 DDL/DML，跳过文件末尾的演示查询
    keep = [s for s in stmts if re.match(r"(?is)^(create|drop|insert|use)\b", s)]

    # 托管实例（云试用）只给一个固定库，不允许 CREATE DATABASE
    skip_create = os.getenv("SEEKDB_SKIP_CREATE", "") == "1"
    if skip_create:
        keep = [s for s in keep
                if not re.match(r"(?is)^(create\s+database|use)\b", s)]
        tell("托管模式：跳过 CREATE DATABASE / USE，直接使用库 %s" % DBNAME)

    tell("准备执行 %d 条语句（共解析出 %d 条，跳过 %d 条演示查询）"
         % (len(keep), len(stmts), len(stmts) - len(keep)))

    conn = connect(with_db=skip_create)
    try:
        with conn.cursor() as cur:
            for s in keep:
                head = s.split(None, 1)[0][:24]
                cur.execute(s)
                tell("  ok  %s..." % head.replace("\n", " "))
        conn.commit()
    finally:
        conn.close()

    conn = connect(with_db=True)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM records")
            n = cur.fetchone()[0]
    finally:
        conn.close()

    tell("\n完成：%s.records 共 %d 条" % (DBNAME, n))
    if n != 16:
        tell("⚠️ 预期 16 条，实际 %d 条" % n)


# ---------------------------------------------------------------- verify

def haversine(lat1, lon1, lat2, lon2):
    r = math.pi / 180
    dphi = (lat2 - lat1) * r
    dlam = (lon2 - lon1) * r
    a = (math.sin(dphi / 2) ** 2
         + math.cos(lat1 * r) * math.cos(lat2 * r) * math.sin(dlam / 2) ** 2)
    return 2 * 6371.0 * math.asin(math.sqrt(a))


DIST = """ROUND(6371 * 2 * ASIN(SQRT(
    POW(SIN(RADIANS(lat - %(lat)s) / 2), 2) +
    COS(RADIANS(%(lat)s)) * COS(RADIANS(lat)) *
    POW(SIN(RADIANS(lon - %(lon)s) / 2), 2)
)), 3)"""


def cmd_verify():
    conn = connect(with_db=True)
    ok = True

    def check(name, cond, detail=""):
        nonlocal ok
        ok = ok and cond
        print("  [%s] %s %s" % ("PASS" if cond else "FAIL", name, detail))

    try:
        with conn.cursor() as cur:
            tell("== 用例 0：记录条数 ==")
            cur.execute("SELECT COUNT(*) FROM records")
            n = cur.fetchone()[0]
            check("records 共 16 条", n == 16, "实际 %d" % n)

            tell("\n== 用例 1：关键词水源 + 6km 半径 ==")
            cur.execute(
                "SELECT * FROM (SELECT id, name, lat, lon, note, %s AS dist_km "
                "FROM records) t WHERE t.dist_km <= %%(max_km)s "
                "ORDER BY t.dist_km LIMIT 5" % DIST,
                {"lat": 30.521, "lon": 114.402, "max_km": 6.0},
            )
            rows = cur.fetchall()
            for r in rows:
                print("    %-16s %6.2f km  %s" % (r[1], float(r[5]), "含水源" if "水源" in (r[4] or "") else ""))
            top = rows[0] if rows else None

            tell("\n== 用例 2：关键词剖面（不限半径）==")
            cur.execute("SELECT COUNT(*) FROM records WHERE kind LIKE %s OR name LIKE %s OR note LIKE %s",
                        ("%剖面%", "%剖面%", "%剖面%"))
            print("    命中 %d 条（预期 5）" % cur.fetchone()[0])

            tell("\n== 用例 3：无命中（温泉）==")
            cur.execute("SELECT COUNT(*) FROM records WHERE name LIKE %s OR note LIKE %s",
                        ("%温泉%", "%温泉%"))
            print("    命中 %d 条（预期 0）" % cur.fetchone()[0])

            tell("\n== 用例 4：1km 硬过滤 ==")
            cur.execute(
                "SELECT * FROM (SELECT id, name, lat, lon, %s AS dist_km FROM records) t "
                "WHERE t.dist_km <= %%(max_km)s ORDER BY t.dist_km" % DIST,
                {"lat": 30.521, "lon": 114.402, "max_km": 1.0},
            )
            rows = cur.fetchall()
            print("    桶内 %d 条（预期 2）" % len(rows))
            for r in rows:
                print("    %-16s %6.2f km" % (r[1], float(r[4])))
    finally:
        conn.close()

    print("\n%s" % ("全部通过" if ok else "有失败项，见上面的 FAIL"))
    return 0 if ok else 1


# ---------------------------------------------------------------- serve

def cmd_serve():
    try:
        import uvicorn
    except ImportError:
        sys.exit("缺少依赖：python3 -m pip install fastapi uvicorn")

    os.chdir(ROOT)
    sys.path.insert(0, os.path.join(ROOT, "backend"))
    import app as backend
    tell("服务启动： http://127.0.0.1:8000")
    uvicorn.run(backend.app, host="0.0.0.0", port=8000)


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode == "init":
        cmd_init()
    elif mode == "verify":
        sys.exit(cmd_verify())
    elif mode == "serve":
        cmd_serve()
    else:
        print(__doc__)
        sys.exit(1)
