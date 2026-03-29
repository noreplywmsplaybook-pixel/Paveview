const sharp = require('sharp');

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function pickFirstNonEmpty(values) {
  for (const v of values) {
    const t = String(v || '').trim();
    if (t) return t;
  }
  return '';
}

function roboflowApiKeyFromEnv() {
  return pickFirstNonEmpty([
    process.env.ROBOFLOW_API_KEY,
    process.env.NEXT_PUBLIC_ROBOFLOW_API_KEY,
    process.env.ROBOFLOW_KEY,
    process.env.RF_API_KEY,
    process.env.ROBOFLOW_PRIVATE_API_KEY,
    process.env.VERCEL_ROBOFLOW_API_KEY
  ]);
}

/** Douglas–Peucker on open polyline */
function simplifyRdp(points, epsilon) {
  if (!points || points.length < 3) return points ? points.slice() : [];
  const eps = Math.max(0, Number(epsilon) || 1);
  const dist = (p, a, b) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    if (l2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
    let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    const nx = a[0] + t * dx;
    const ny = a[1] + t * dy;
    return Math.hypot(p[0] - nx, p[1] - ny);
  };
  const mark = new Uint8Array(points.length);
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = -1;
    let idx = -1;
    const pa = points[a];
    const pb = points[b];
    for (let i = a + 1; i < b; i++) {
      const d = dist(points[i], pa, pb);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > eps) {
      mark[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out = [];
  for (let i = 0; i < points.length; i++) {
    if (i === 0 || i === points.length - 1 || mark[i]) out.push(points[i]);
  }
  return out;
}

/** Closed polygon via RDP on duplicated first vertex */
function approxPolyDPClosed(pts, epsilon) {
  if (!pts || pts.length < 4) {
    return pts ? pts.map((p) => [p[0], p[1]]) : [];
  }
  const ring = pts.map((p) => [p[0], p[1]]);
  const dup = ring.concat([ring[0]]);
  const s = simplifyRdp(dup, epsilon);
  if (s.length >= 2) return s.slice(0, -1);
  return ring;
}

function contourArea(poly) {
  let a = 0;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += poly[i][0] * poly[j][1] - poly[j][0] * poly[i][1];
  }
  return Math.abs(a) / 2;
}

function largestBinaryComponent(data, w, h, fgMin) {
  const fg = fgMin == null ? 128 : fgMin;
  const visited = new Uint8Array(w * h);
  let bestPixels = null;
  let bestArea = 0;
  const idx = (x, y) => y * w + x;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = idx(x, y);
      if (data[i] < fg || visited[i]) continue;
      const stack = [[x, y]];
      visited[i] = 1;
      const pixels = [];
      while (stack.length) {
        const [cx, cy] = stack.pop();
        pixels.push([cx, cy]);
        const nbs = [
          [cx + 1, cy],
          [cx - 1, cy],
          [cx, cy + 1],
          [cx, cy - 1],
        ];
        for (const [nx, ny] of nbs) {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = idx(nx, ny);
          if (visited[ni] || data[ni] < fg) continue;
          visited[ni] = 1;
          stack.push([nx, ny]);
        }
      }
      if (pixels.length > bestArea) {
        bestArea = pixels.length;
        bestPixels = pixels;
      }
    }
  }
  return bestPixels;
}

function boundaryPixelsFromComponent(data, w, h, pixels, fgMin) {
  const fg = fgMin == null ? 128 : fgMin;
  const boundary = [];
  const isFg = (x, y) =>
    x >= 0 && y >= 0 && x < w && y < h && data[y * w + x] >= fg;
  for (const [x, y] of pixels) {
    if (
      !isFg(x + 1, y) ||
      !isFg(x - 1, y) ||
      !isFg(x, y + 1) ||
      !isFg(x, y - 1)
    ) {
      boundary.push([x, y]);
    }
  }
  return boundary;
}

function orderBoundaryByAngle(boundary) {
  if (!boundary.length) return [];
  let sx = 0;
  let sy = 0;
  boundary.forEach(([x, y]) => {
    sx += x;
    sy += y;
  });
  const cx = sx / boundary.length;
  const cy = sy / boundary.length;
  return boundary
    .map((p) => ({
      p,
      ang: Math.atan2(p[1] - cy, p[0] - cx),
    }))
    .sort((a, b) => a.ang - b.ang)
    .map((o) => o.p);
}

async function runRoboflowHybrid(imageBase64) {
  const apiKey = roboflowApiKeyFromEnv();
  const modelId = pickFirstNonEmpty([
    process.env.ROBOFLOW_MODEL_ID,
    process.env.NEXT_PUBLIC_ROBOFLOW_MODEL_ID,
    'my-first-project-ug0a7/4',
  ]);
  const carModelId = pickFirstNonEmpty([
    process.env.ROBOFLOW_CAR_MODEL_ID,
    process.env.NEXT_PUBLIC_ROBOFLOW_CAR_MODEL_ID,
    'parking-lot-egjcr-an53v/1',
  ]);
  if (!apiKey) {
    return { ok: false, error: 'Missing Roboflow API key.' };
  }
  const runRequest = async (baseUrl) => {
    const url = `${baseUrl}/${modelId}?api_key=${encodeURIComponent(apiKey)}&confidence=25&overlap=30`;
    const rfRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: imageBase64,
    });
    let payload = null;
    try {
      payload = await rfRes.json();
    } catch (e) {
      payload = null;
    }
    return { ok: rfRes.ok, status: rfRes.status, payload };
  };
  const [seg, det] = await Promise.all([
    runRequest('https://outline.roboflow.com'),
    runRequest('https://detect.roboflow.com'),
  ]);
  const normalized = (s) => String(s || '').trim().toLowerCase();
  const isAreaClass = (cls) => {
    const c = normalized(cls);
    return (
      c.includes('lot') ||
      c.includes('obstruct') ||
      c.includes('island') ||
      c.includes('building') ||
      c.includes('fire')
    );
  };
  const isSymbolClass = (cls) => {
    const c = normalized(cls);
    return (
      c.includes('stall') ||
      c.includes('ada') ||
      c.includes('handicap') ||
      c.includes('accessible') ||
      c.includes('arrow') ||
      c.includes('stencil') ||
      c.includes('crosswalk') ||
      c.includes('hatch')
    );
  };
  const segPred = Array.isArray(seg.payload?.predictions)
    ? seg.payload.predictions
    : [];
  const detPred = Array.isArray(det.payload?.predictions)
    ? det.payload.predictions
    : [];
  const image = seg.payload?.image || det.payload?.image || null;
  const keepSeg = segPred.filter((p) => isAreaClass(p.class));
  const keepDet = detPred.filter((p) => isSymbolClass(p.class));
  let merged = [...keepSeg, ...keepDet];
  if (carModelId && carModelId !== modelId && apiKey) {
    try {
      const carUrl = `https://detect.roboflow.com/${carModelId}?api_key=${encodeURIComponent(apiKey)}&confidence=25&overlap=30`;
      const carRes = await fetch(carUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: imageBase64,
      });
      let carPayload = null;
      try {
        carPayload = await carRes.json();
      } catch (e) {
        carPayload = null;
      }
      if (carRes.ok && carPayload && Array.isArray(carPayload.predictions)) {
        const carPred = carPayload.predictions.map((p) => ({
          ...p,
          class: 'parking_stall',
          confidence:
            typeof p.confidence === 'number'
              ? p.confidence
              : Number(p.confidence) || 0,
          detection_source: 'roboflow_car',
        }));
        merged = merged.concat(carPred);
      }
    } catch (e) {
      /* car model optional */
    }
  }
  return {
    ok: seg.ok || det.ok,
    predictions: merged,
    image,
    meta: { seg_ok: seg.ok, det_ok: det.ok },
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }

  let body = {};
  try {
    body =
      typeof req.body === 'string'
        ? JSON.parse(req.body || '{}')
        : (req.body || {});
  } catch (e) {
    sendJson(res, 400, { error: 'Invalid JSON body.' });
    return;
  }

  const rawBase64 = String(body.imageBase64 || '').trim();
  const imageDataUrl = String(body.imageDataUrl || '').trim();
  let buf = Buffer.from(
    rawBase64 ||
      (imageDataUrl.includes(',') ? imageDataUrl.split(',')[1].trim() : ''),
    'base64',
  );
  if (!buf.length) {
    sendJson(res, 400, { error: 'imageBase64 or imageDataUrl is required.' });
    return;
  }

  const crop = body.crop || {};
  let cx = Math.max(0, Math.floor(Number(crop.x) || 0));
  let cy = Math.max(0, Math.floor(Number(crop.y) || 0));
  let cw = Math.floor(Number(crop.w));
  let ch = Math.floor(Number(crop.h));
  const threshold = Math.max(0, Math.min(255, Number(body.threshold) || 100));
  const runRf = body.runDetections !== false;

  let meta;
  try {
    meta = await sharp(buf).metadata();
  } catch (e) {
    sendJson(res, 400, { error: 'Invalid image data.', detail: e.message });
    return;
  }
  const iw = meta.width || 0;
  const ih = meta.height || 0;
  if (!iw || !ih) {
    sendJson(res, 400, { error: 'Could not read image dimensions.' });
    return;
  }

  if (!Number.isFinite(cw) || cw <= 0) cw = iw;
  if (!Number.isFinite(ch) || ch <= 0) ch = ih;
  cw = Math.max(1, Math.min(iw, cw));
  ch = Math.max(1, Math.min(ih, ch));
  if (cx + cw > iw) cx = Math.max(0, iw - cw);
  if (cy + ch > ih) cy = Math.max(0, ih - ch);

  let cropBuf;
  try {
    cropBuf = await sharp(buf)
      .extract({ left: cx, top: cy, width: cw, height: ch })
      .greyscale()
      .threshold(threshold)
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch (e) {
    sendJson(res, 400, { error: 'Crop/threshold failed.', detail: e.message });
    return;
  }

  const { data, info } = cropBuf;
  const w = info.width;
  const h = info.height;
  const comp = largestBinaryComponent(data, w, h, 128);
  let polygon = [];
  if (comp && comp.length > 50) {
    const bnd = boundaryPixelsFromComponent(data, w, h, comp, 128);
    const ordered = orderBoundaryByAngle(bnd);
    const stride = Math.max(1, Math.floor(ordered.length / 800));
    const sampled = ordered.filter((_, i) => i % stride === 0);
    const peri = sampled.reduce((acc, p, i) => {
      const q = sampled[(i + 1) % sampled.length];
      return acc + Math.hypot(q[0] - p[0], q[1] - p[1]);
    }, 0);
    const epsilon = Math.max(1.5, 0.01 * peri);
    polygon = approxPolyDPClosed(sampled.map((p) => [p[0], p[1]]), epsilon);
    if (polygon.length > 3 && contourArea(polygon) < comp.length * 0.25) {
      polygon = [
        [0, 0],
        [w - 1, 0],
        [w - 1, h - 1],
        [0, h - 1],
      ];
    }
  } else {
    polygon = [
      [0, 0],
      [w - 1, 0],
      [w - 1, h - 1],
      [0, h - 1],
    ];
  }

  const polygonInImageSpace = polygon.map(([x, y]) => [x + cx, y + cy]);

  let stalls = [];
  let rfImage = null;
  if (runRf) {
    let jpegB64;
    try {
      jpegB64 = await sharp(buf)
        .extract({ left: cx, top: cy, width: cw, height: ch })
        .jpeg({ quality: 88 })
        .toBuffer()
        .then((b) => b.toString('base64'));
    } catch (e) {
      sendJson(res, 500, {
        error: 'Could not encode crop for detection.',
        detail: e.message,
      });
      return;
    }
    const rf = await runRoboflowHybrid(jpegB64);
    if (rf.ok || (rf.predictions && rf.predictions.length)) {
      stalls = rf.predictions || [];
      rfImage = rf.image;
    }
  }

  sendJson(res, 200, {
    polygon: polygonInImageSpace,
    polygonCropLocal: polygon.slice(),
    stalls,
    crop: { x: cx, y: cy, w: cw, h: ch },
    image: rfImage || { width: cw, height: ch },
    threshold,
  });
};
