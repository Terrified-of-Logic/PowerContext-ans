// 线上演示使用内置示例数据；以下 16 条记录逐条取自项目的 seekdb_field_survey.sql。
// 字段形状与 GET /api/search 保持一致；距离、命中关键词和 reason 由 app.js 现算。
window.DEMO_CENTER = { lat: 30.521000, lon: 114.402000 };

window.FIELD_POINTS = [
  {
    id: 1,
    name: '南望山北坡剖面',
    kind: '剖面',
    lat: 30.521000,
    lon: 114.402000,
    collected_at: '2026-09-12',
    elevation_m: 58,
    note: '第四系残坡积层出露，含砾黏土，层理清晰，适合教学观测'
  },
  {
    id: 2,
    name: '东湖西岸采样点',
    kind: '采样点',
    lat: 30.552000,
    lon: 114.362000,
    collected_at: '2026-09-13',
    elevation_m: 22,
    note: '表层水样 pH 7.8，周边有水草带，采样需穿防水靴'
  },
  {
    id: 3,
    name: '磨山南麓露营地',
    kind: '露营地',
    lat: 30.538000,
    lon: 114.418000,
    collected_at: '2026-09-14',
    elevation_m: 76,
    note: '林地空地，地面平整可扎两顶帐篷，附近有水源但需煮沸'
  },
  {
    id: 4,
    name: '喻家山观景平台',
    kind: '观测点',
    lat: 30.512000,
    lon: 114.421000,
    collected_at: '2026-09-15',
    elevation_m: 149,
    note: '视野开阔可俯瞰城区，适合全景记录与无人机起降'
  },
  {
    id: 5,
    name: '南望山东侧探槽',
    kind: '剖面',
    lat: 30.519500,
    lon: 114.406000,
    collected_at: '2026-09-16',
    elevation_m: 61,
    note: '槽深约两米，可见风化壳分层，边坡需注意落石'
  },
  {
    id: 6,
    name: '珞珈山西坡土壤点',
    kind: '采样点',
    lat: 30.541000,
    lon: 114.361000,
    collected_at: '2026-09-17',
    elevation_m: 45,
    note: '林下腐殖层较厚，取 0-20cm 扰动样'
  },
  {
    id: 7,
    name: '沙湖栈道观测点',
    kind: '观测点',
    lat: 30.568000,
    lon: 114.348000,
    collected_at: '2026-09-18',
    elevation_m: 18,
    note: '城市湿地，适合记录水位变化与鸟类活动'
  },
  {
    id: 8,
    name: '八分山防火道',
    kind: '剖面',
    lat: 30.498000,
    lon: 114.389000,
    collected_at: '2026-09-19',
    elevation_m: 132,
    note: '人工切坡暴露基岩，岩性为砂岩夹页岩'
  },
  {
    id: 9,
    name: '汤逊湖北岸露营地',
    kind: '露营地',
    lat: 30.462000,
    lon: 114.372000,
    collected_at: '2026-09-20',
    elevation_m: 20,
    note: '临水平地，车辆可达，夜间风大'
  },
  {
    id: 10,
    name: '马鞍山森林公园',
    kind: '观测点',
    lat: 30.531000,
    lon: 114.442000,
    collected_at: '2026-09-21',
    elevation_m: 88,
    note: '次生林覆盖，林窗处适合架设仪器'
  },
  {
    id: 11,
    name: '严西湖水样点',
    kind: '采样点',
    lat: 30.558000,
    lon: 114.469000,
    collected_at: '2026-09-22',
    elevation_m: 19,
    note: '湖水较浅，采样点需沿堤步行约 800 米'
  },
  {
    id: 12,
    name: '九峰山脊线',
    kind: '观测点',
    lat: 30.523000,
    lon: 114.488000,
    collected_at: '2026-09-23',
    elevation_m: 186,
    note: '山脊通风良好，适合连续气象观测'
  },
  {
    id: 13,
    name: '白玉山废弃采石场',
    kind: '剖面',
    lat: 30.585000,
    lon: 114.432000,
    collected_at: '2026-09-24',
    elevation_m: 63,
    note: '裸露灰岩断面，节理发育，注意边坡稳定'
  },
  {
    id: 14,
    name: '龙泉山断崖',
    kind: '剖面',
    lat: 30.418000,
    lon: 114.455000,
    collected_at: '2026-09-25',
    elevation_m: 210,
    note: '断层崖地貌典型，需沿既有小径接近'
  },
  {
    id: 15,
    name: '东湖南岸芦苇荡',
    kind: '采样点',
    lat: 30.539000,
    lon: 114.353000,
    collected_at: '2026-09-26',
    elevation_m: 21,
    note: '芦苇密集，夏季蚊虫多，需长袖与驱蚊'
  },
  {
    id: 16,
    name: '青山区江滩',
    kind: '观测点',
    lat: 30.618000,
    lon: 114.398000,
    collected_at: '2026-09-27',
    elevation_m: 12,
    note: '长江冲积滩地，适合记录沉积构造与水位线'
  }
];
