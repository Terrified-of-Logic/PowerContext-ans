(() => {
  'use strict';

  const CENTER = window.DEMO_CENTER || { lat: 30.521, lon: 114.402 };
  const MAX_RADIUS_KM = 10;

  const TYPE_RULES = [
    { kind: '露营地', terms: ['露营地', '露营', '扎营', '帐篷', '过夜', '营地'] },
    { kind: '剖面', terms: ['剖面', '露头'] },
    { kind: '采样点', terms: ['采样点', '采样', '取样', '样品'] },
    { kind: '观测点', terms: ['观测点'] }
  ];

  const TYPE_GROUP = {
    露营地: 'camp',
    剖面: 'section',
    采样点: 'sample',
    观测点: 'observe'
  };

  const GROUPS = [
    {
      id: 'water',
      label: '水源',
      terms: ['水源', '取水', '饮水', '煮沸', '溪', '河', '湖', '水域', '水塘', '水样']
    },
    {
      id: 'camp',
      label: '露营',
      terms: ['露营', '扎营', '帐篷', '过夜', '营地', '空地', '草地', '扎两顶', '扎三顶']
    },
    {
      id: 'section',
      label: '剖面',
      terms: ['剖面', '露头', '岩层', '地层', '产状', '界线', '断面', '切坡', '岩性']
    },
    {
      id: 'sample',
      label: '采样',
      terms: ['采样', '取样', '样品', '土样', '水样', '岩样', '矿样', '岩石样']
    },
    {
      id: 'observe',
      label: '观测',
      terms: ['观测', '观察', '视野', '眺望', '全景', '拍摄', '拍照', '远眺']
    },
    {
      id: 'vehicle',
      label: '车辆可达',
      terms: ['车', '停车', '通车', '公路', '土路', '乡道', '便道', '直达', '开到', '开进', '越野']
    },
    {
      id: 'flat',
      label: '平整地面',
      terms: ['平整', '平坦', '平地', '开阔', '缓坡']
    }
  ];

  const STOP_PHRASES = [
    '附近', '我的位置', '位置', '地方', '这边', '那边', '周边', '一带',
    '适合', '可以', '能够', '能到', '能开', '一个', '一些', '哪些', '什么',
    '怎么', '我们', '需要', '有没有', '没有', '是否', '的话', '并且', '或者', '以及'
  ];

  const STOP_CHARS = new Set(
    Array.from('的了吗呢吧啊么有在和与或是我你他她它把被就都也还去到个些里上中下找要想看那可这能地')
  );

  const KIND_CLASS = {
    露营地: 'camp',
    剖面: 'section',
    采样点: 'sample',
    观测点: 'observe'
  };

  const KNOWN_TERMS = Array.from(new Set([
    ...TYPE_RULES.flatMap(rule => rule.terms),
    ...GROUPS.flatMap(group => group.terms)
  ])).sort((a, b) => b.length - a.length);

  const els = {
    form: document.getElementById('searchForm'),
    input: document.getElementById('searchInput'),
    clear: document.getElementById('clearSearch'),
    radius: document.getElementById('radius'),
    radiusWrap: document.getElementById('radiusWrap'),
    useLocation: document.getElementById('useLocation'),
    locationNote: document.getElementById('locationNote'),
    summary: document.getElementById('resultSummary'),
    list: document.getElementById('resultList'),
    empty: document.getElementById('emptyState'),
    emptyText: document.getElementById('emptyText'),
    widen: document.getElementById('widenRadius'),
    clearAll: document.getElementById('clearAll'),
    chips: Array.from(document.querySelectorAll('.example-chip'))
  };

  const catalogue = (Array.isArray(window.FIELD_POINTS) ? window.FIELD_POINTS : []).map(point => ({
    ...point,
    dist_km: distanceKm(CENTER, point)
  }));

  let renderTimer = 0;

  function distanceKm(from, to) {
    const earthRadiusKm = 6371;
    const toRad = degrees => (degrees * Math.PI) / 180;
    const dLat = toRad(to.lat - from.lat);
    const dLon = toRad(to.lon - from.lon);
    const h = Math.sin(dLat / 2) ** 2
      + Math.cos(toRad(from.lat)) * Math.cos(toRad(to.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * earthRadiusKm * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function normalizeQuery(value) {
    return String(value || '').trim().toLowerCase();
  }

  function detectType(query) {
    let best = null;
    for (const rule of TYPE_RULES) {
      for (const term of rule.terms) {
        const index = query.lastIndexOf(term);
        if (index !== -1 && (!best || index > best.index)) {
          best = { kind: rule.kind, index };
        }
      }
    }
    return best ? best.kind : null;
  }

  function extractExtras(query) {
    let rest = query;
    for (const term of KNOWN_TERMS) {
      rest = rest.split(term).join(' ');
    }
    for (const phrase of STOP_PHRASES) {
      rest = rest.split(phrase).join(' ');
    }
    const extras = rest
      .split(/[\s,，。、；;·/!?！？:：()（）"'“”‘’]+/)
      .map(token => Array.from(token).filter(char => !STOP_CHARS.has(char)).join(''))
      .filter(token => token.length >= 2);
    return Array.from(new Set(extras));
  }

  function search(rawQuery, options = {}) {
    const query = normalizeQuery(rawQuery);
    const useLocation = options.useLocation ?? els.useLocation.checked;
    const maxKm = options.maxKm ?? (Number(els.radius.value) || 6);
    const type = query ? detectType(query) : null;
    const typeGroupId = type ? TYPE_GROUP[type] : null;
    const groups = query
      ? GROUPS.filter(group => group.terms.some(term => query.includes(term)))
      : [];
    const extras = query ? extractExtras(query) : [];
    const found = [];

    for (const point of catalogue) {
      if (useLocation && point.dist_km > maxKm + 1e-9) {
        continue;
      }
      if (type && point.kind !== type) {
        continue;
      }

      const labels = [];
      let score = 0;

      if (type) {
        labels.push(type);
        score += 1;
      }

      const text = `${point.name} ${point.kind} ${point.note}`;

      for (const group of groups) {
        if (group.id === typeGroupId) {
          continue;
        }
        if (group.terms.some(term => text.includes(term))) {
          labels.push(group.label);
          score += 1;
        }
      }

      for (const extra of extras) {
        if (text.includes(extra) && !labels.includes(extra)) {
          labels.push(extra);
          score += 1;
        }
      }

      if (query && !type && score === 0) {
        continue;
      }

      let reason;
      if (labels.length > 0) {
        reason = `命中关键词 ${labels.join('、')} · 距离 ${point.dist_km.toFixed(2)} km`;
      } else if (useLocation) {
        reason = `半径 ${maxKm} km 内 · 距离 ${point.dist_km.toFixed(2)} km`;
      } else {
        reason = `全部点位 · 距离 ${point.dist_km.toFixed(2)} km`;
      }

      found.push({
        ...point,
        kw_hit: labels.length,
        reason,
        score
      });
    }

    found.sort((a, b) => (
      b.score - a.score
      || a.dist_km - b.dist_km
      || a.name.localeCompare(b.name, 'zh-CN')
    ));

    return {
      items: found,
      total: found.length,
      meta: { query, type, maxKm, useLocation }
    };
  }

  function createEl(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }

  function reasonIcon() {
    const namespace = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(namespace, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '12');
    svg.setAttribute('height', '12');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('aria-hidden', 'true');
    [
      'M12 4v2.6',
      'M12 17.4V20',
      'M4 12h2.6',
      'M17.4 12H20',
      'M6.35 6.35l1.84 1.84',
      'M15.81 15.81l1.84 1.84',
      'M17.65 6.35l-1.84 1.84',
      'M8.19 15.81l-1.84 1.84'
    ].forEach(pathData => {
      const path = document.createElementNS(namespace, 'path');
      path.setAttribute('d', pathData);
      svg.append(path);
    });
    return svg;
  }

  function renderCard(item) {
    const card = createEl('article', 'card');
    card.setAttribute('role', 'listitem');

    const tag = createEl('span', `tag tag--${KIND_CLASS[item.kind] || 'default'}`, item.kind);

    const distance = createEl('div', 'distance');
    const distanceValue = createEl('div', 'distance-value', item.dist_km.toFixed(2));
    distanceValue.append(createEl('span', 'distance-unit', 'km'));
    distance.append(distanceValue, createEl('div', 'distance-caption', '距示例点'));

    const top = createEl('div', 'card-top');
    top.append(tag, distance);

    const meta = createEl(
      'div',
      'meta',
      `${item.collected_at} · 海拔 ${item.elevation_m} m · ${item.lat.toFixed(6)}°N, ${item.lon.toFixed(6)}°E`
    );

    const reason = createEl('p', 'reason');
    reason.append(reasonIcon(), createEl('span', 'reason-text', item.reason));

    card.append(
      top,
      createEl('h2', 'card-title', item.name),
      meta,
      createEl('p', 'card-note', item.note),
      reason
    );

    return card;
  }

  function renderSummary(result) {
    const fragment = document.createDocumentFragment();
    fragment.append(createEl('strong', null, String(result.total)), document.createTextNode(' 个点位'));

    const parts = [];
    if (result.meta.query) {
      if (result.meta.type) {
        parts.push(`类型：${result.meta.type}`);
      }
      parts.push('按匹配度与距离排序');
    } else {
      parts.push(result.meta.useLocation ? `半径 ${result.meta.maxKm} km 内` : '全部点位');
      parts.push('按距离排序');
    }

    for (const part of parts) {
      const separator = createEl('span', 'summary-sep', '·');
      separator.setAttribute('aria-hidden', 'true');
      fragment.append(separator, createEl('span', null, part));
    }

    els.summary.replaceChildren(fragment);
  }

  function renderEmptyState(query, meta) {
    const hasQuery = query.length > 0;
    const canWiden = meta.useLocation
      && meta.maxKm < MAX_RADIUS_KM
      && search(query, { useLocation: true, maxKm: MAX_RADIUS_KM }).total > 0;

    if (hasQuery) {
      els.emptyText.textContent = canWiden
        ? '换个关键词，或把检索半径扩大到 10 km 再试一次。'
        : '换个关键词再试一次，或清空搜索查看全部点位。';
    } else {
      els.emptyText.textContent = canWiden
        ? '当前范围内还没有点位，试试扩大检索半径。'
        : '当前还没有可显示的点位。';
    }

    els.widen.hidden = !canWiden;
    els.clearAll.hidden = !hasQuery;
  }

  function updateLocationState() {
    const enabled = els.useLocation.checked;
    els.radius.disabled = !enabled;
    els.radiusWrap.classList.toggle('is-disabled', !enabled);
    els.locationNote.textContent = enabled
      ? '以示例坐标 30.521, 114.402 为圆心'
      : '未启用定位，显示全部点位；勾选后按半径筛选，距离按示例坐标估算';
  }

  function render() {
    const query = normalizeQuery(els.input.value);
    const result = search(query);

    els.clear.hidden = els.input.value.length === 0;
    for (const chip of els.chips) {
      chip.classList.toggle('is-active', normalizeQuery(chip.textContent) === query);
    }

    renderSummary(result);

    if (result.total > 0) {
      const fragment = document.createDocumentFragment();
      for (const item of result.items) {
        fragment.append(renderCard(item));
      }
      els.list.replaceChildren(fragment);
      els.list.hidden = false;
      els.empty.hidden = true;
    } else {
      els.list.replaceChildren();
      els.list.hidden = true;
      els.empty.hidden = false;
      renderEmptyState(query, result.meta);
    }
  }

  els.input.addEventListener('input', () => {
    els.clear.hidden = els.input.value.length === 0;
    window.clearTimeout(renderTimer);
    renderTimer = window.setTimeout(render, 200);
  });

  els.form.addEventListener('submit', event => {
    event.preventDefault();
    window.clearTimeout(renderTimer);
    render();
  });

  els.clear.addEventListener('click', () => {
    window.clearTimeout(renderTimer);
    els.input.value = '';
    els.clear.hidden = true;
    render();
    els.input.focus();
  });

  for (const chip of els.chips) {
    chip.addEventListener('click', () => {
      window.clearTimeout(renderTimer);
      els.input.value = chip.textContent.trim();
      render();
      els.input.focus({ preventScroll: true });
    });
  }

  els.radius.addEventListener('change', render);

  els.useLocation.addEventListener('change', () => {
    updateLocationState();
    render();
  });

  els.widen.addEventListener('click', () => {
    els.radius.value = String(MAX_RADIUS_KM);
    render();
    els.input.focus({ preventScroll: true });
  });

  els.clearAll.addEventListener('click', () => {
    window.clearTimeout(renderTimer);
    els.input.value = '';
    els.clear.hidden = true;
    render();
    els.input.focus({ preventScroll: true });
  });

  updateLocationState();
  render();
})();
