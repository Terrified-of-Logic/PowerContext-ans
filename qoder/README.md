# 野外地调资料检索

按「说话的方式」找回野外地调记录：输入一句自然语言，系统在 **seekdb** 里同时做
关键词命中与地理距离两道筛选，用 RRF 融合两路排名，返回最相关的点位。

**seekdb 承担的核心作用**：点位的存储、距离计算、半径过滤、关键词匹配、候选排序
**全部在 SQL 里完成**；后端只做两路排名的 RRF 融合与结果组装。

---

## 线上演示

**https://field-survey-search-88ks6uknvo5.qoder.website**

由 **Qoder Sites** 构建并发布。线上版使用内置的 16 条示例点位，与 `seekdb/schema.sql` 逐条一致；
完整的多路检索请按「二、运行步骤」在本地启动并连接真实 seekdb。

### 两套前端的分工

| 目录 | 是什么 | 数据来源 |
|---|---|---|
| `site/` | 本地版，随 `backend/app.py` 一起跑 | 每次检索实时查询 **seekdb** |
| `site-published/` | 线上版的构建产物，与上面那个网址**逐字节对应** | 内置 `data.js`（16 条，与 schema 一致） |

之所以不合并成一套：Qoder Sites 发布的是**静态站点**，它够不到内网的 seekdb；
而本地版必须真实查询数据库才能体现 seekdb 的作用。两者数据同源，展示与验证分工明确。

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

| 项 | 要求 |
|---|---|
| Python | 3.10 及以上 |
| seekdb | 三条获取路径，按平台选（见下） |
| 依赖 | `pymysql`（必需）、`fastapi` + `uvicorn`（仅网页需要） |

**选哪条路取决于你的系统和有没有现成实例：**

| 你的情况 | 用哪条 | 原因 |
|---|---|---|
| **Windows**，没有 seekdb | **路径 B：Docker** | `pylibseekdb` **不提供 Windows 预编译包**，嵌入式在 Windows 上装不上 |
| **Linux / macOS**，没有 seekdb | **路径 A：嵌入式** | 一条 `pip install` 起一个本地库，不需要端口 |
| 已经有 seekdb 实例 | **路径 C：直连** | 最省事 |

安装依赖：

```bash
pip install pymysql              # init / verify 只需要这个
pip install fastapi uvicorn      # 只有 serve 需要
```


---

## 二、运行步骤

### 路径 A：嵌入式（Linux / macOS，评审首选）

不需要服务器、不需要端口，`run.py` 会在当前目录建一个 `seekdb.db`。

```bash
pip install pylibseekdb pymysql
export SEEKDB_EMBEDDED=1
python3 run.py init
```

> ⚠️ `pylibseekdb` 只提供 Linux / macOS 的预编译包，**Windows 装不上**。Windows 请走路径 B。

### 路径 B：Docker（Windows 首选）

```bash
docker run -d --name seekdb -p 2881:2881 -v ./data:/var/lib/oceanbase oceanbase/seekdb:latest
```

等 30 秒左右让实例起来，然后：

```bash
# macOS / Linux
export SEEKDB_HOST=127.0.0.1
export SEEKDB_PORT=2881
export SEEKDB_USER=root
export SEEKDB_PASSWORD=

# Windows PowerShell
$env:SEEKDB_HOST="127.0.0.1"
$env:SEEKDB_PORT="2881"
$env:SEEKDB_USER="root"
$env:SEEKDB_PASSWORD=""

python run.py init
```

### 路径 C：直连已有实例

```bash
export SEEKDB_HOST=<seekdb主机>
export SEEKDB_PORT=2881
export SEEKDB_USER=root
export SEEKDB_PASSWORD=<密码>

python3 run.py init
```

### 四条路径共同的下一步

```bash
python3 run.py init      # 建库 + 建表 + 导入 16 条
python3 run.py verify    # 四组查询自检
```

`init` 成功会打印：

```
完成：field_survey.records 共 16 条
```

`verify` 会逐个用例打印 PASS/FAIL，最后一行是 `全部通过`。

### 启动网页

```bash
python3 run.py serve
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
│   └── index.html                  本地版前端，检索时调用后端
├── site-published/                 线上版构建产物（Qoder Sites 发布的那一版）
│   ├── index.html
│   ├── app.js
│   ├── data.js
│   └── styles.css
└── samples/
    └── verify.md                   验证样例（4 组输入与预期输出）
```

---

## 六、交付物对应

| 赛题要求 | 本项目位置 |
|---|---|
| 项目网站网址 | <https://field-survey-search-88ks6uknvo5.qoder.website> |
| 代码仓库 | 本仓库 `2026-competition-ecosystem` 分支下的 `qoder/` |
| 运行说明 | 本文档 |
| 验证样例 | `samples/verify.md` |
| Qoder 开发记录 | `qoder-deployment.md`（发布标识）+ Qoder 会话导出 |
