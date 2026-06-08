#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function usage() {
  const cmd = path.basename(process.argv[1] || 'fix-claude-takeoff.js');
  return [
    'Normalize Claude takeoff JSON into PaveView schema.',
    '',
    `Usage: node scripts/${cmd} <input.json> [output.json]`,
    '',
    'Examples:',
    `  node scripts/${cmd} .local_inputs/claude.json`,
    `  node scripts/${cmd} .local_inputs/claude.json .local_inputs/claude.fixed.json`
  ].join('\n');
}

function isFiniteNum(v) {
  const n = Number(v);
  return Number.isFinite(n);
}

function toNum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clampNum(v, min, max, fallback) {
  const n = toNum(v, fallback);
  return Math.max(min, Math.min(max, n));
}

function clampPct(v, fallback) {
  return Math.round(clampNum(v, 0, 100, fallback));
}

function makeId(prefix, idx) {
  return `${prefix}-${Date.now().toString(36)}-${idx}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizePoint(raw) {
  if (Array.isArray(raw) && raw.length >= 2) {
    const x = Number(raw[0]);
    const y = Number(raw[1]);
    if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const x = Number(raw.x ?? raw.X ?? raw.left ?? raw.lng ?? raw.lon);
  const y = Number(raw.y ?? raw.Y ?? raw.top ?? raw.lat);
  if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
  return null;
}

function normalizePts(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const p of arr) {
    const n = normalizePoint(p);
    if (n) out.push(n);
  }
  return out;
}

function rectToPts(raw) {
  const x = toNum(raw?.x ?? raw?.left, NaN);
  const y = toNum(raw?.y ?? raw?.top, NaN);
  const w = toNum(raw?.width ?? raw?.w, NaN);
  const h = toNum(raw?.height ?? raw?.h, NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return [];
  }
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}

function circleToPts(raw, steps) {
  const cx = toNum(raw?.cx ?? raw?.centerX ?? raw?.x, NaN);
  const cy = toNum(raw?.cy ?? raw?.centerY ?? raw?.y, NaN);
  const r = toNum(raw?.r ?? raw?.radius, NaN);
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(r) || r <= 0) return [];
  const n = Math.max(8, steps || 20);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const t = (i / n) * Math.PI * 2;
    out.push({ x: cx + Math.cos(t) * r, y: cy + Math.sin(t) * r });
  }
  return out;
}

function polyArea(pts) {
  if (!Array.isArray(pts) || pts.length < 3) return 0;
  let a = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const j = (i + 1) % pts.length;
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return Math.abs(a) / 2;
}

function pickFirstArray(primary, fallback, keys) {
  for (const k of keys) {
    if (primary && Array.isArray(primary[k])) return primary[k];
  }
  for (const k of keys) {
    if (fallback && Array.isArray(fallback[k])) return fallback[k];
  }
  return [];
}

function unwrapPayload(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const keys = ['zones', 'markers', 'measurements', 'linearSegs', 'hatchZones', 'plans', 'planData', 'scalePx', 'scaleFt', 'scale'];
  if (keys.some((k) => Object.prototype.hasOwnProperty.call(raw, k))) return raw;
  const candidates = ['data', 'projectData', 'project', 'takeoff', 'result', 'payload', 'output'];
  for (const c of candidates) {
    const v = raw[c];
    if (v && typeof v === 'object' && keys.some((k) => Object.prototype.hasOwnProperty.call(v, k))) {
      return v;
    }
  }
  for (const c of candidates) {
    const v = raw[c];
    if (v && typeof v === 'object') {
      const nested = unwrapPayload(v);
      if (nested && nested !== v && Object.keys(nested).length) return nested;
    }
  }
  return raw;
}

function extractPlanPayload(payload) {
  let src = payload && typeof payload === 'object' ? payload : {};
  if (Array.isArray(src.plans) && src.plans.length) {
    const idx = Math.max(0, Math.min(src.plans.length - 1, parseInt(src.currentPlanIdx || 0, 10) || 0));
    src = src.plans[idx] || src.plans[0];
  }
  if (src && typeof src === 'object' && !Array.isArray(src) && src.planData && typeof src.planData === 'object' && !Array.isArray(src.planData)) {
    const keys = Object.keys(src.planData);
    if (keys.length) {
      const preferred = src.currentPlanId && src.planData[src.currentPlanId] ? src.currentPlanId : keys[0];
      src = src.planData[preferred];
    }
  } else if (payload && typeof payload === 'object' && payload.planData && typeof payload.planData === 'object' && !Array.isArray(payload.planData)) {
    const keys = Object.keys(payload.planData);
    if (keys.length) {
      const preferred = payload.currentPlanId && payload.planData[payload.currentPlanId] ? payload.currentPlanId : keys[0];
      src = payload.planData[preferred];
    }
  }
  if (src && typeof src === 'object' && src.data && typeof src.data === 'object') src = src.data;
  return src && typeof src === 'object' ? src : {};
}

function normalize(inputText, sourceFileName) {
  let raw;
  try {
    raw = JSON.parse(inputText);
  } catch (e) {
    throw new Error(`Invalid JSON: ${e?.message || 'parse failed'}`);
  }

  const payload = unwrapPayload(raw);
  const source = extractPlanPayload(payload);
  const warnings = [];

  const scalePxRaw = source.scalePx ?? payload.scalePx ?? payload.scale?.px ?? payload.scale?.pixels;
  const scaleFtRaw = source.scaleFt ?? payload.scaleFt ?? payload.scale?.ft ?? payload.scale?.feet;
  const scaleUnitRaw = String(source.scaleUnit ?? payload.scaleUnit ?? payload.scale?.unit ?? 'ft').toLowerCase();
  const scaleUnit = ['ft', 'm', 'yd'].includes(scaleUnitRaw) ? scaleUnitRaw : 'ft';
  const scalePx = isFiniteNum(scalePxRaw) && Number(scalePxRaw) > 0 ? Number(scalePxRaw) : 70;
  const scaleFt = isFiniteNum(scaleFtRaw) && Number(scaleFtRaw) > 0 ? Number(scaleFtRaw) : 40;
  const effectiveScale = scaleFt / scalePx;

  const rawZones = pickFirstArray(source, payload, ['zones', 'zonePolygons', 'polygons']);
  const rawMarkers = pickFirstArray(source, payload, ['markers', 'points', 'symbols']);
  const rawMeasurements = pickFirstArray(source, payload, ['measurements', 'measurementShapes', 'autoMeasurements']);
  const rawLinear = pickFirstArray(source, payload, ['linearSegs', 'linearSegments', 'linears']);
  const rawHatches = pickFirstArray(source, payload, ['hatchZones', 'hatches']);

  const palette = ['#f5c842', '#3b82f6', '#22c55e', '#ef4444', '#a855f7', '#f97316', '#06b6d4', '#ec4899'];

  const zones = [];
  rawZones.forEach((z, idx) => {
    let pts = normalizePts(z?.pts || z?.points || z?.vertices || z?.polygon || z?.path);
    if (pts.length < 3 && z && typeof z === 'object') pts = rectToPts(z);
    if (pts.length < 3) {
      warnings.push(`Skipped zone ${idx + 1}: missing polygon points.`);
      return;
    }
    const obstruct = !!(z?.obstruct || String(z?.type || z?.kind || '').toLowerCase() === 'obstruction');
    zones.push({
      id: String(z?.id || makeId('z', idx)),
      name: String(z?.name || z?.label || (obstruct ? 'Obstruction ' : 'Zone ') + (idx + 1)),
      color: String(z?.color || z?.stroke || palette[idx % palette.length]),
      pts,
      closed: z?.closed !== false,
      locked: !!z?.locked,
      showFill: z?.showFill !== false,
      obstruct,
      labelSize: clampNum(z?.labelSize, 8, 36, 12),
      opacity: clampPct(z?.opacity, 15),
      lineWidth: clampNum(z?.lineWidth, 0.5, 12, 2),
      lineDashed: !!z?.lineDashed,
      labelX: toNum(z?.labelX, 0),
      labelY: toNum(z?.labelY, 0)
    });
  });

  const markerTypeMap = {
    stall: 'stall',
    parking: 'stall',
    'parking-stall': 'stall',
    parking_stall: 'stall',
    ada: 'ada',
    bollard: 'bollard',
    stopblock: 'stopblock',
    'stop-block': 'stopblock',
    stop_block: 'stopblock',
    stencil: 'stencil',
    sign: 'bollard-sign',
    bollardsign: 'bollard-sign',
    'bollard-sign': 'bollard-sign',
    bollard_sign: 'bollard-sign'
  };
  const markers = [];
  rawMarkers.forEach((m, idx) => {
    const pt = normalizePoint(m?.pt || m?.point || m);
    if (!pt) {
      warnings.push(`Skipped marker ${idx + 1}: missing x/y.`);
      return;
    }
    const rawType = String(m?.type || 'stall').toLowerCase();
    markers.push({
      x: pt.x,
      y: pt.y,
      type: markerTypeMap[rawType] || 'stall',
      label: String(m?.label || m?.text || m?.name || '')
    });
  });

  const measurements = [];
  rawMeasurements.forEach((m, idx) => {
    let pts = normalizePts(m?.pts || m?.points || m?.vertices || m?.polygon || m?.path);
    const mType = String(m?.type || 'polygon').toLowerCase();
    if (pts.length < 3 && m && typeof m === 'object') {
      if (mType.includes('rect')) pts = rectToPts(m);
      else if (mType.includes('circle')) pts = circleToPts(m, 24);
    }
    if (pts.length < 3) {
      warnings.push(`Skipped measurement ${idx + 1}: missing polygon points.`);
      return;
    }
    const areaRaw = m?.sqft ?? m?.areaSqft ?? m?.area;
    const sqft = isFiniteNum(areaRaw)
      ? Math.max(0, Math.round(Number(areaRaw)))
      : Math.max(0, Math.round(polyArea(pts) * effectiveScale * effectiveScale));
    measurements.push({
      id: String(m?.id || makeId('m', idx)),
      label: String(m?.label || m?.name || `Measurement ${idx + 1}`),
      type: mType.includes('circle') ? 'circle' : (mType.includes('rect') ? 'rect' : 'poly'),
      pts,
      sqft,
      labelSize: clampNum(m?.labelSize, 8, 32, 12),
      color: String(m?.color || '#f5c842'),
      opacity: clampPct(m?.opacity, 20),
      lineWidth: clampNum(m?.lineWidth, 0.5, 12, 2),
      labelX: toNum(m?.labelX, 0),
      labelY: toNum(m?.labelY, 0)
    });
  });

  const linearSegs = [];
  rawLinear.forEach((s, idx) => {
    const pts = normalizePts(s?.pts || s?.points || s?.path);
    if (pts.length < 2) {
      warnings.push(`Skipped linear segment ${idx + 1}: requires 2+ points.`);
      return;
    }
    linearSegs.push({
      id: String(s?.id || makeId('lin', idx)),
      label: String(s?.label || s?.name || ''),
      pts,
      color: String(s?.color || '#06b6d4'),
      lineWidth: clampNum(s?.lineWidth, 0.5, 12, 2),
      labelSize: clampNum(s?.labelSize, 8, 32, 11)
    });
  });

  const hatchZones = [];
  rawHatches.forEach((h, idx) => {
    const pts = normalizePts(h?.pts || h?.points || h?.vertices || h?.polygon || h?.path);
    if (pts.length < 3) {
      warnings.push(`Skipped hatch ${idx + 1}: missing polygon points.`);
      return;
    }
    const rawType = String(h?.type || 'crosswalk').toLowerCase();
    const type = (rawType === 'ada' || rawType === 'ada_hatch' || rawType === 'ada-hatch') ? 'ada-hatch' : 'crosswalk';
    hatchZones.push({
      id: String(h?.id || makeId('h', idx)),
      type,
      pts,
      opacity: clampPct(h?.opacity, 20),
      lineWidth: clampNum(h?.lineWidth, 0.5, 12, 1.5)
    });
  });

  const manualRaw = source.manualCounts || payload.manualCounts || {};
  const manualCounts = {
    stall: Math.max(0, parseInt(manualRaw.stall || 0, 10) || 0),
    ada: Math.max(0, parseInt(manualRaw.ada || 0, 10) || 0),
    bollard: Math.max(0, parseInt(manualRaw.bollard || 0, 10) || 0),
    stopblock: Math.max(0, parseInt(manualRaw.stopblock || 0, 10) || 0),
    stencil: Math.max(0, parseInt(manualRaw.stencil || 0, 10) || 0)
  };

  const normalized = {
    scalePx,
    scaleFt,
    scaleUnit,
    zones,
    markers,
    measurements,
    linearSegs,
    hatchZones,
    manualCounts
  };

  return {
    normalized,
    report: {
      source: sourceFileName,
      generatedAt: new Date().toISOString(),
      counts: {
        zones: zones.length,
        markers: markers.length,
        measurements: measurements.length,
        linearSegs: linearSegs.length,
        hatchZones: hatchZones.length
      },
      warnings
    }
  };
}

function run() {
  const input = process.argv[2];
  const output = process.argv[3];
  if (!input) {
    process.stderr.write(`${usage()}\n`);
    process.exit(1);
  }

  const inPath = path.resolve(process.cwd(), input);
  const outPath = output
    ? path.resolve(process.cwd(), output)
    : path.join(path.dirname(inPath), `${path.basename(inPath, path.extname(inPath))}.fixed.json`);

  const text = fs.readFileSync(inPath, 'utf8');
  const { normalized, report } = normalize(text, path.basename(inPath));

  fs.writeFileSync(outPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');

  process.stdout.write(
    [
      `Fixed file written: ${outPath}`,
      `Counts => zones:${report.counts.zones}, markers:${report.counts.markers}, measurements:${report.counts.measurements}, linear:${report.counts.linearSegs}, hatches:${report.counts.hatchZones}`,
      `Warnings: ${report.warnings.length}`
    ].join('\n') + '\n'
  );

  if (report.warnings.length) {
    report.warnings.slice(0, 20).forEach((w) => process.stdout.write(` - ${w}\n`));
    if (report.warnings.length > 20) {
      process.stdout.write(` - ... ${report.warnings.length - 20} more\n`);
    }
  }
}

run();
