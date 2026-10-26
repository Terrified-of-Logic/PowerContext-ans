-- ============================================================
-- 野外地调资料检索 · seekdb 侧建库脚本
-- 用途：Qoder 大赛项目中「结合 seekdb 实现核心功能」的数据与查询层
-- 运行：mysql -h127.0.0.1 -P2881 -uroot -p < seekdb_field_survey.sql
-- 说明：地名与坐标为演示用示例数据，不代表真实测绘成果
-- ============================================================

CREATE DATABASE IF NOT EXISTS field_survey DEFAULT CHARACTER SET utf8mb4;
USE field_survey;

DROP TABLE IF EXISTS records;

CREATE TABLE records (
  id           INT PRIMARY KEY AUTO_INCREMENT,
  name         VARCHAR(128) NOT NULL COMMENT '点位名称',
  kind         VARCHAR(32)  NOT NULL COMMENT '类型：剖面/采样点/观测点/露营地',
  lat          DECIMAL(9,6) NOT NULL COMMENT '纬度',
  lon          DECIMAL(9,6) NOT NULL COMMENT '经度',
  collected_at DATE         NOT NULL COMMENT '采集日期',
  elevation_m  INT          DEFAULT NULL COMMENT '海拔(米)',
  note         TEXT         COMMENT '现场记录',
  KEY idx_kind (kind),
  KEY idx_geo  (lat, lon)
) DEFAULT CHARSET = utf8mb4;

INSERT INTO records (name, kind, lat, lon, collected_at, elevation_m, note) VALUES
('南望山北坡剖面',   '剖面',   30.521000, 114.402000, '2026-09-12',  58, '第四系残坡积层出露，含砾黏土，层理清晰，适合教学观测'),
('东湖西岸采样点',   '采样点', 30.552000, 114.362000, '2026-09-13',  22, '表层水样 pH 7.8，周边有水草带，采样需穿防水靴'),
('磨山南麓露营地',   '露营地', 30.538000, 114.418000, '2026-09-14',  76, '林地空地，地面平整可扎两顶帐篷，附近有水源但需煮沸'),
('喻家山观景平台',   '观测点', 30.512000, 114.421000, '2026-09-15', 149, '视野开阔可俯瞰城区，适合全景记录与无人机起降'),
('南望山东侧探槽',   '剖面',   30.519500, 114.406000, '2026-09-16',  61, '槽深约两米，可见风化壳分层，边坡需注意落石'),
('珞珈山西坡土壤点', '采样点', 30.541000, 114.361000, '2026-09-17',  45, '林下腐殖层较厚，取 0-20cm 扰动样'),
('沙湖栈道观测点',   '观测点', 30.568000, 114.348000, '2026-09-18',  18, '城市湿地，适合记录水位变化与鸟类活动'),
('八分山防火道',     '剖面',   30.498000, 114.389000, '2026-09-19', 132, '人工切坡暴露基岩，岩性为砂岩夹页岩'),
('汤逊湖北岸露营地', '露营地', 30.462000, 114.372000, '2026-09-20',  20, '临水平地，车辆可达，夜间风大'),
('马鞍山森林公园',   '观测点', 30.531000, 114.442000, '2026-09-21',  88, '次生林覆盖，林窗处适合架设仪器'),
('严西湖水样点',     '采样点', 30.558000, 114.469000, '2026-09-22',  19, '湖水较浅，采样点需沿堤步行约 800 米'),
('九峰山脊线',       '观测点', 30.523000, 114.488000, '2026-09-23', 186, '山脊通风良好，适合连续气象观测'),
('白玉山废弃采石场', '剖面',   30.585000, 114.432000, '2026-09-24',  63, '裸露灰岩断面，节理发育，注意边坡稳定'),
('龙泉山断崖',       '剖面',   30.418000, 114.455000, '2026-09-25', 210, '断层崖地貌典型，需沿既有小径接近'),
('东湖南岸芦苇荡',   '采样点', 30.539000, 114.353000, '2026-09-26',  21, '芦苇密集，夏季蚊虫多，需长袖与驱蚊'),
('青山区江滩',       '观测点', 30.618000, 114.398000, '2026-09-27',  12, '长江冲积滩地，适合记录沉积构造与水位线');

-- ============================================================
-- 查询 1：关键词路（硬命中）
-- ============================================================
SELECT id, name, kind, collected_at, note
FROM records
WHERE note LIKE '%水源%' OR name LIKE '%水源%' OR note LIKE '%水%'
ORDER BY collected_at DESC
LIMIT 20;

-- ============================================================
-- 查询 2：空间路（以某点为中心，半径内的点按距离升序）
-- 注意：距离公式只算一次，放在派生表里再过滤，避免重复计算
-- ============================================================
SET @lat0 = 30.521000, @lon0 = 114.402000, @max_km = 6;

SELECT id, name, kind, elevation_m, dist_km
FROM (
  SELECT
    id, name, kind, elevation_m,
    ROUND(6371 * 2 * ASIN(SQRT(
        POW(SIN(RADIANS(lat - @lat0) / 2), 2) +
        COS(RADIANS(@lat0)) * COS(RADIANS(lat)) *
        POW(SIN(RADIANS(lon - @lon0) / 2), 2)
    )), 3) AS dist_km
  FROM records
) t
WHERE t.dist_km <= @max_km
ORDER BY t.dist_km
LIMIT 20;

-- ============================================================
-- 查询 3：混合候选集（两路信号一次取出，融合排序交给应用层）
-- 返回 kw_hit（关键词是否命中）+ dist_km，应用层做 RRF
-- ============================================================
SET @lat0 = 30.521000, @lon0 = 114.402000;
SET @kw = '水源';

SELECT
  id, name, kind, elevation_m, collected_at,
  (CASE WHEN note LIKE CONCAT('%', @kw, '%') THEN 1 ELSE 0 END) AS kw_hit,
  ROUND(6371 * 2 * ASIN(SQRT(
      POW(SIN(RADIANS(lat - @lat0) / 2), 2) +
      COS(RADIANS(@lat0)) * COS(RADIANS(lat)) *
      POW(SIN(RADIANS(lon - @lon0) / 2), 2)
  )), 3) AS dist_km
FROM records
ORDER BY kw_hit DESC, dist_km ASC
LIMIT 50;

-- ============================================================
-- 可选：给站点用的导出视图（走路线 B 时直接拿这个结果做静态数据）
-- ============================================================
SELECT id, name, kind, lat, lon, collected_at, elevation_m, note
FROM records
ORDER BY id;
