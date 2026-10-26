# 野外地调资料检索

按「说话的方式」找回野外地调记录：输入一句自然语言，系统在 **seekdb** 里同时做
关键词命中与地理距离两道筛选，用 RRF 融合两路排名，返回最相关的点位。

**seekdb 承担的核心作用**：点位的存储、距离计算、半径过滤、关键词匹配、候选排序
**全部在 SQL 里完成**；后端只做两路排名的 RRF 融合与结果组装。

---

## 零、seekdb 到底承担了什么（可直接核对）

取自 `backend/app.py` 实际执行的 SQL：

```sql
SELECT * FROM (
    SELECT id, name, kind, lat, lon, collected_at, elevation_m, note,
           ROUND(6371 * 2 * ASIN(SQRT(
               POW(SIN(RADIANS(lat - ?) / 2), 2) +
               COS(RADIANS(?)) * COS(RADIANS(lat)) *
               POW(SIN(RADIANS(lon - ?) / 2), 2)
           )), 3) AS dist_km,
           ((name LIKE ? OR kind LIKE ? OR note LIKE ?)) AS kw_hit
    FROM records
) t
WHERE t.dist_km <= ?
ORDER BY t.kw_hit DESC, t.dist_km IS NULL, t.dist_km ASC, t.id ASC
LIMIT 50
```

逐条对应：

| 能力 | 在哪 |
|---|---|
| 数据存储 | `records` 表，16 条点位 |
| **Haversine 距离计算** | SQL 的 `ASIN/SQRT/POW/RADIANS` 表达式，不在 Python 里 |
| **半径硬过滤** | `WHERE t.dist_km <= ?` |
| **关键词匹配** | SQL 的 `LIKE`，覆盖 `name` / `kind` / `note` 三个字段 |
| **候选池排序与截断** | `ORDER BY ... LIMIT 50` |

**为什么这构成"实际作用"**：把 seekdb 换成读一个 JSON 文件，上面五项全部要在
Python 里重写一遍才能等价。也就是说这部分逻辑**是 seekdb 在提供，不是装饰**。

Python 侧只剩两件事：把候选池按 `kw_hit` 与 `dist_km` 各排一次，做 RRF 融合；组装返回。


---

## 一、环境要求

| 项 | 版本 |
|---|---|
| Python | 3.10 及以上 |
| seekdb | 已启动的实例，可连 2881 端口（MySQL 协议） |
| 依赖 | `pymysql`、`fastapi`、`uvicorn` |

安装依赖：

```bash
pip install pymysql fastapi uvicorn
```

---

## 二、运行步骤

### 1. 建库并导入示例数据

```bash
mysql -h <seekdb主机> -P 2881 -u root -p < seekdb/schema.sql
```

> 如果你的 seekdb 没有密码，去掉 `-p`。
> 执行完成后应生成数据库 `field_survey` 与表 `records`，共 **16 条**记录。

自检：

```bash
mysql -h <seekdb主机> -P 2881 -u root -p -e "SELECT COUNT(*) FROM field_survey.records;"
```

预期输出 `16`。

### 2. 配置连接串

用环境变量传，不要把密码写进代码：

```bash
# macOS / Linux
export SEEKDB_HOST=127.0.0.1
export SEEKDB_PORT=2881
export SEEKDB_USER=root
export SEEKDB_PASSWORD=你的密码

# Windows PowerShell
$env:SEEKDB_HOST="127.0.0.1"
$env:SEEKDB_PORT="2881"
$env:SEEKDB_USER="root"
$env:SEEKDB_PASSWORD="你的密码"
```

### 3. 启动服务

```bash
python backend/app.py
```

打开 <http://127.0.0.1:8000> 。

---

## 三、接口

| 接口 | 说明 |
|---|---|
| `GET /api/records` | 返回全部 16 条点位 |
| `GET /api/search` | 混合检索，参数见下 |

`/api/search` 参数：

| 参数 | 类型 | 说明 |
|---|---|---|
| `q` | string | 查询词，空格分隔多个词 |
| `lat` / `lon` | float | 查询中心坐标，不给则只走关键词路 |
| `max_km` | float | 距离上限，默认 10，给坐标时是硬约束 |
| `topk` | int | 返回条数，默认 6 |

示例：

```
http://127.0.0.1:8000/api/search?q=水源&lat=30.521&lon=114.402&max_km=6&topk=3
```

返回结构：

```json
{
  "items": [
    {"id": 3, "name": "磨山南麓露营地", "kind": "露营地",
     "lat": 30.538, "lon": 114.418, "dist_km": 2.4,
     "kw_hit": 1, "reason": "命中关键词 水源 · 距离 2.4 km"}
  ],
  "total": 1
}
```

---

## 四、常见问题

**连不上 seekdb**：先确认端口通不通，`telnet <主机> 2881`。seekdb 默认端口是 2881，不是 MySQL 的 3306。

**报 `Unknown database 'field_survey'`**：第 1 步没跑成功，或连的实例不对。重新执行 `schema.sql`。

**中文乱码**：`schema.sql` 里已指定 `utf8mb4`；如果客户端是 Windows 命令行，先执行 `chcp 65001`。

**检索返回空**：给了坐标但 `max_km` 太小。把 `max_km` 调到 10 以上再试。

---

## 五、目录结构

```
.
├── README.md                       运行说明（本文件）
├── seekdb/
│   └── schema.sql                  建库、建表、16 条示例数据、三条参考查询
├── backend/
│   └── app.py                      FastAPI 服务：seekdb 查询 + RRF 融合
├── site/
│   └── index.html                  前端页面
└── samples/
    └── verify.md                   验证样例（3 组输入与预期输出）
```
