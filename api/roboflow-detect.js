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

function bboxFromPred(p) {
  const x = Number(p?.x) || 0;
  const y = Number(p?.y) || 0;
  const w = Math.abs(Number(p?.width) || 0);
  const h = Math.abs(Number(p?.height) || 0);
  return { cx: x, cy: y, w, h };
}

function centerDist(a, b) {
  const A = bboxFromPred(a);
  const B = bboxFromPred(b);
  return Math.hypot(A.cx - B.cx, A.cy - B.cy);
}

function boundsIouBoxes(a, b) {
  const ax = a.cx - a.w / 2;
  const ay = a.cy - a.h / 2;
  const bx = b.cx - b.w / 2;
  const by = b.cy - b.h / 2;
  const aMaxX = ax + a.w;
  const aMaxY = ay + a.h;
  const bMaxX = bx + b.w;
  const bMaxY = by + b.h;
  const ix = Math.max(0, Math.min(aMaxX, bMaxX) - Math.max(ax, bx));
  const iy = Math.max(0, Math.min(aMaxY, bMaxY) - Math.max(ay, by));
  const inter = ix * iy;
  const union = a.w * a.h + b.w * b.h - inter;
  if (union <= 1e-9) return 0;
  return inter / union;
}

function normalizedLower(cls) {
  return String(cls || '').trim().toLowerCase();
}

function isStallLikeClass(cls) {
  const c = normalizedLower(cls);
  return (
    c.includes('stall')
    || c.includes('ada')
    || c.includes('handicap')
    || c.includes('accessible')
    || c.includes('arrow')
    || c.includes('stencil')
    || c.includes('crosswalk')
    || c.includes('hatch')
  );
}

function isAreaClass(cls) {
  const c = normalizedLower(cls);
  return (
    c.includes('lot')
    || c.includes('obstruct')
    || c.includes('island')
    || c.includes('building')
    || c.includes('fire')
  );
}

function isSymbolClass(cls) {
  const c = normalizedLower(cls);
  return (
    c.includes('stall')
    || c.includes('ada')
    || c.includes('handicap')
    || c.includes('accessible')
    || c.includes('arrow')
    || c.includes('stencil')
    || c.includes('crosswalk')
    || c.includes('hatch')
  );
}

/** Merge stall-model boxes with main-model stall-like symbols; keep non-stall symbols from main. */
function mergeDualPredictions(stallPreds, keepSeg, keepDet) {
  const stallFromPass1 = (stallPreds || []).map((p) => ({
    ...p,
    class: 'parking_stall',
    confidence: Number(p.confidence) || 0,
    _stallPass: 1
  }));

  const mainMerged = [...(keepSeg || []), ...(keepDet || [])];
  const mainNonStall = mainMerged.filter((p) => !isStallLikeClass(p?.class));
  const mainStallLike = mainMerged.filter((p) => isStallLikeClass(p?.class));

  const stallPool = [...stallFromPass1, ...mainStallLike.map((p) => ({ ...p, _stallPass: 2 }))];
  const mergedStalls = [];
  stallPool.forEach((p) => {
    const dup = mergedStalls.find((q) => {
      const d = centerDist(p, q);
      const iou = boundsIouBoxes(bboxFromPred(p), bboxFromPred(q));
      return d <= 36 || iou >= 0.35;
    });
    if (!dup) {
      mergedStalls.push(p);
      return;
    }
    const pc = Number(p.confidence) || 0;
    const qc = Number(dup.confidence) || 0;
    if (pc > qc) {
      const idx = mergedStalls.indexOf(dup);
      if (idx >= 0) mergedStalls[idx] = p;
    }
  });

  return [...mainNonStall, ...mergedStalls];
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }

  const apiKey = pickFirstNonEmpty([
    process.env.ROBOFLOW_API_KEY,
    process.env.NEXT_PUBLIC_ROBOFLOW_API_KEY,
    process.env.ROBOFLOW_KEY,
    process.env.RF_API_KEY
  ]);

  const stallModelId = pickFirstNonEmpty([
    process.env.ROBOFLOW_STALL_MODEL_ID,
    'parking-lot-egjcr-an53v/1'
  ]);

  const mainModelId = pickFirstNonEmpty([
    process.env.ROBOFLOW_MAIN_MODEL_ID,
    process.env.ROBOFLOW_MODEL_ID,
    'my-first-project-ug0a7/6'
  ]);

  if (!apiKey) {
    sendJson(res, 500, {
      error: 'Missing Roboflow API key environment variable.',
      diagnostics: {
        vercelEnv: process.env.VERCEL_ENV || null,
        has_ROBOFLOW_API_KEY: Boolean(pickFirstNonEmpty([process.env.ROBOFLOW_API_KEY]))
      }
    });
    return;
  }

  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  } catch (e) {
    sendJson(res, 400, { error: 'Invalid JSON body.' });
    return;
  }

  const rawBase64 = String(body.imageBase64 || '').trim();
  const imageDataUrl = String(body.imageDataUrl || '').trim();
  const imageBase64 = rawBase64 || (imageDataUrl.includes(',') ? imageDataUrl.split(',')[1].trim() : '');
  if (!imageBase64) {
    sendJson(res, 400, { error: 'imageBase64 (or imageDataUrl) is required.' });
    return;
  }

  const confidence = Number.isFinite(Number(body.confidence))
    ? Math.max(1, Math.min(99, Number(body.confidence)))
    : 25;
  const overlap = Number.isFinite(Number(body.overlap))
    ? Math.max(1, Math.min(99, Number(body.overlap)))
    : 30;

  let mode = String(body.mode || 'dual').toLowerCase();
  if (mode === 'hybrid') mode = 'dual';

  const runDetect = async (modelId) => {
    const url = `https://detect.roboflow.com/${modelId}?api_key=${encodeURIComponent(apiKey)}&confidence=${confidence}&overlap=${overlap}`;
    const rfRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: imageBase64
    });
    let payload = null;
    try {
      payload = await rfRes.json();
    } catch (e) {
      payload = null;
    }
    return { ok: rfRes.ok, status: rfRes.status, payload, url };
  };

  const runOutline = async (modelId) => {
    const url = `https://outline.roboflow.com/${modelId}?api_key=${encodeURIComponent(apiKey)}&confidence=${confidence}&overlap=${overlap}`;
    const rfRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: imageBase64
    });
    let payload = null;
    try {
      payload = await rfRes.json();
    } catch (e) {
      payload = null;
    }
    return { ok: rfRes.ok, status: rfRes.status, payload, url };
  };

  try {
    // Stall-only: zoom tile recall (object detection — every box is a stall).
    if (mode === 'stall' || mode === 'detect') {
      const result = await runDetect(stallModelId);
      if (!result.ok) {
        sendJson(res, result.status || 502, {
          error: result.payload?.error || result.payload?.message || 'Roboflow stall model request failed.',
          source: result.url,
          meta: { mode: 'stall', stall_model_id: stallModelId }
        });
        return;
      }
      const preds = Array.isArray(result.payload?.predictions) ? result.payload.predictions : [];
      const normalized = preds.map((p) => ({
        ...p,
        class: normalizedLower(p?.class).includes('stall') ? p.class : 'parking_stall'
      }));
      sendJson(res, 200, {
        ...result.payload,
        predictions: normalized,
        image: result.payload?.image || null,
        meta: {
          mode: 'stall',
          stall_model_id: stallModelId,
          prediction_count: normalized.length
        }
      });
      return;
    }

    // Main hybrid only (segmentation + detection on main model) — debugging / rare use.
    if (mode === 'main') {
      const [seg, det] = await Promise.all([
        runOutline(mainModelId),
        runDetect(mainModelId)
      ]);
      if (!seg.ok && !det.ok) {
        sendJson(res, seg.status || det.status || 502, {
          error: seg.payload?.error || det.payload?.error || 'Roboflow main model failed.',
          meta: { main_model_id: mainModelId }
        });
        return;
      }
      const segPred = Array.isArray(seg.payload?.predictions) ? seg.payload.predictions : [];
      const detPred = Array.isArray(det.payload?.predictions) ? det.payload.predictions : [];
      const keepSeg = segPred.filter((p) => isAreaClass(p.class));
      const keepDet = detPred.filter((p) => isSymbolClass(p.class));
      const merged = [...keepSeg, ...keepDet];
      const image = seg.payload?.image || det.payload?.image || null;
      sendJson(res, 200, {
        predictions: merged,
        image,
        meta: {
          mode: 'main',
          main_model_id: mainModelId,
          segmentation_count: keepSeg.length,
          detection_count: keepDet.length,
          seg_ok: seg.ok,
          det_ok: det.ok
        }
      });
      return;
    }

    // dual: (1) stall model first, (2) main hybrid second, merge stalls.
    if (mode === 'segment') {
      const result = await runOutline(mainModelId);
      if (!result.ok) {
        sendJson(res, result.status || 502, {
          error: result.payload?.error || result.payload?.message || 'Roboflow segmentation failed.',
          source: result.url
        });
        return;
      }
      sendJson(res, 200, result.payload || { predictions: [], meta: { mode: 'segment' } });
      return;
    }

    const stallRes = await runDetect(stallModelId);
    const stallPreds = stallRes.ok && Array.isArray(stallRes.payload?.predictions)
      ? stallRes.payload.predictions
      : [];

    const [seg, det] = await Promise.all([
      runOutline(mainModelId),
      runDetect(mainModelId)
    ]);

    if (!stallRes.ok && !seg.ok && !det.ok) {
      sendJson(res, 502, {
        error: 'Roboflow failed on stall model and main model (segmentation + detection).',
        meta: {
          stall_model_id: stallModelId,
          main_model_id: mainModelId,
          stall_status: stallRes.status,
          seg_status: seg.status,
          det_status: det.status
        }
      });
      return;
    }

    const segPred = seg.ok && Array.isArray(seg.payload?.predictions) ? seg.payload.predictions : [];
    const detPred = det.ok && Array.isArray(det.payload?.predictions) ? det.payload.predictions : [];
    const keepSeg = segPred.filter((p) => isAreaClass(p.class));
    const keepDet = detPred.filter((p) => isSymbolClass(p.class));

    const mergedPredictions = mergeDualPredictions(stallPreds, keepSeg, keepDet);

    const image = seg.payload?.image || det.payload?.image || stallRes.payload?.image || null;

    sendJson(res, 200, {
      predictions: mergedPredictions,
      image,
      meta: {
        mode: 'dual',
        stall_model_id: stallModelId,
        main_model_id: mainModelId,
        stall_pass_count: stallPreds.length,
        main_segmentation_count: keepSeg.length,
        main_detection_count: keepDet.length,
        stall_detect_ok: stallRes.ok,
        seg_ok: seg.ok,
        det_ok: det.ok,
        merged_count: mergedPredictions.length
      }
    });
  } catch (e) {
    sendJson(res, 500, { error: e.message || 'Roboflow request error.' });
  }
};
