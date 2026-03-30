function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function pickFirstNonEmpty(values) {
  for (const v of values) {
    const t = String(v || '').trim();
    if (t) return t;
  }
  return '';
}

function sanitizeUrlForLog(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const u = new URL(url);
    u.searchParams.delete('api_key');
    return u.toString();
  } catch {
    return url.replace(/([?&])api_key=[^&]*/g, '$1api_key=(redacted)');
  }
}

/** Vercel usually parses JSON; some runtimes leave body empty or as Buffer — normalize + optional stream read. */
async function parseJsonBody(req) {
  const b = req.body;
  if (b != null && typeof b === 'object' && !Buffer.isBuffer(b)) {
    return b;
  }
  if (Buffer.isBuffer(b)) {
    try {
      return JSON.parse(b.toString('utf8') || '{}');
    } catch {
      return {};
    }
  }
  if (typeof b === 'string') {
    try {
      return JSON.parse(b || '{}');
    } catch {
      return {};
    }
  }
  if (req.readable && typeof req[Symbol.asyncIterator] === 'function') {
    try {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      if (!chunks.length) return {};
      const raw = Buffer.concat(chunks).toString('utf8');
      return JSON.parse(raw || '{}');
    } catch {
      return {};
    }
  }
  return {};
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
  const fallbackKeys = [
    process.env.ROBOFLOW_API_KEY,
    process.env.NEXT_PUBLIC_ROBOFLOW_API_KEY,
    process.env.ROBOFLOW_KEY,
    process.env.RF_API_KEY
  ];

  /** Stall project (first pass). Optional override when main is a different Roboflow project. */
  const stallApiKey = pickFirstNonEmpty([
    process.env.ROBOFLOW_STALL_API_KEY,
    ...fallbackKeys
  ]);

  /** Main project (segmentation + detection hybrid). Optional override when stall is a different project. */
  const mainApiKey = pickFirstNonEmpty([
    process.env.ROBOFLOW_MAIN_API_KEY,
    ...fallbackKeys
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

  if (req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      service: 'roboflow-detect',
      has_stall_key: Boolean(stallApiKey),
      has_main_key: Boolean(mainApiKey),
      dual_project_keys: Boolean(
        pickFirstNonEmpty([process.env.ROBOFLOW_STALL_API_KEY])
        && pickFirstNonEmpty([process.env.ROBOFLOW_MAIN_API_KEY])
      ),
      vercelEnv: process.env.VERCEL_ENV || null,
      stall_model_id: stallModelId,
      main_model_id: mainModelId,
      hint: (!stallApiKey || !mainApiKey)
        ? 'Set ROBOFLOW_STALL_API_KEY + ROBOFLOW_MAIN_API_KEY (one Private key per Roboflow project) or a single ROBOFLOW_API_KEY if one key can run both models. Scope Preview + Production in Vercel.'
        : 'POST JSON with imageDataUrl or imageBase64. Stall requests use stall key; main outline/detect use main key.'
    });
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed. Use GET for health or POST to infer.' });
    return;
  }

  if (!stallApiKey || !mainApiKey) {
    sendJson(res, 500, {
      error: 'Missing Roboflow API key(s).',
      hint: 'Two separate projects: add ROBOFLOW_STALL_API_KEY (Private key from the stall project workspace) and ROBOFLOW_MAIN_API_KEY (Private key from the main project workspace). Optionally set ROBOFLOW_STALL_MODEL_ID and ROBOFLOW_MAIN_MODEL_ID. If both models are under one workspace, ROBOFLOW_API_KEY alone is enough for both passes.',
      diagnostics: {
        vercelEnv: process.env.VERCEL_ENV || null,
        has_stall_key: Boolean(stallApiKey),
        has_main_key: Boolean(mainApiKey)
      }
    });
    return;
  }

  let body = {};
  try {
    body = await parseJsonBody(req);
  } catch (e) {
    sendJson(res, 400, { error: 'Invalid JSON body.', detail: String(e?.message || e) });
    return;
  }

  const rawBase64 = String(body.imageBase64 || '').trim();
  const imageDataUrl = String(body.imageDataUrl || '').trim();
  const imageBase64 = rawBase64 || (imageDataUrl.includes(',') ? imageDataUrl.split(',')[1].trim() : '');
  if (!imageBase64) {
    sendJson(res, 400, {
      error: 'imageBase64 (or imageDataUrl) is required.',
      receivedKeys: Object.keys(body || {})
    });
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

  const parseRfBody = async (rfRes) => {
    const text = await rfRes.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return { error: text.trim().slice(0, 400) };
    }
  };

  /** Roboflow hosted V1: raw base64 in body. Official Python examples use Content-Type: application/json; many older samples use x-www-form-urlencoded — try both. */
  const isRoboflowSuccess = (rfRes, payload) => {
    if (!rfRes || !rfRes.ok) return false;
    if (!payload || typeof payload !== 'object') return false;
    if (payload.error) return false;
    return true;
  };

  const postImageToRoboflow = async (baseUrl, modelId, keyForRequest) => {
    const url = `${baseUrl}/${modelId}?api_key=${encodeURIComponent(keyForRequest)}&confidence=${confidence}&overlap=${overlap}`;
    let rfRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: imageBase64
    });
    let payload = await parseRfBody(rfRes);
    if (isRoboflowSuccess(rfRes, payload)) {
      return { ok: true, status: rfRes.status, payload, url, transport: 'json' };
    }
    const firstStatus = rfRes.status;
    const firstErr = payload?.error || payload?.message || `HTTP ${firstStatus}`;
    rfRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: imageBase64
    });
    payload = await parseRfBody(rfRes);
    if (isRoboflowSuccess(rfRes, payload)) {
      return { ok: true, status: rfRes.status, payload, url, transport: 'form' };
    }
    const secondErr = payload?.error || payload?.message || `HTTP ${rfRes.status}`;
    const shortAttempts = firstStatus === rfRes.status && String(firstErr) === String(secondErr)
      ? `HTTP ${rfRes.status}`
      : `json→${firstStatus}; form→${rfRes.status}`;
    return {
      ok: false,
      status: rfRes.status,
      payload,
      url,
      transport: 'form',
      attempts: shortAttempts
    };
  };

  const runDetectStall = async (modelId) => postImageToRoboflow('https://detect.roboflow.com', modelId, stallApiKey);
  const runDetectMain = async (modelId) => postImageToRoboflow('https://detect.roboflow.com', modelId, mainApiKey);
  const runOutlineMain = async (modelId) => postImageToRoboflow('https://outline.roboflow.com', modelId, mainApiKey);

  const roboflowErrorMessage = (result) => {
    const p = result?.payload;
    const base = p?.error || p?.message || p?.detail || `HTTP ${result?.status}`;
    if (result?.status === 403 || String(base).toLowerCase().includes('forbidden')) {
      return 'Forbidden (403)';
    }
    if (result?.attempts) return `${base} [${result.attempts}]`;
    return base;
  };

  const hintFor403 = () => 'Roboflow 403: that model rejected this API key. If stall and main are different Roboflow projects, set two env vars: ROBOFLOW_STALL_API_KEY (Private key from the stall project’s workspace) and ROBOFLOW_MAIN_API_KEY (Private key from the main project’s workspace), plus ROBOFLOW_STALL_MODEL_ID / ROBOFLOW_MAIN_MODEL_ID. Redeploy. If both models share one workspace, ROBOFLOW_API_KEY alone is enough.';

  try {
    if (mode === 'stall' || mode === 'detect') {
      const result = await runDetectStall(stallModelId);
      if (!result.ok) {
        sendJson(res, result.status || 502, {
          error: roboflowErrorMessage(result) || 'Roboflow stall model request failed.',
          hint: result.status === 403 ? hintFor403() : undefined,
          source: sanitizeUrlForLog(result.url),
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

    if (mode === 'main') {
      const [seg, det] = await Promise.all([
        runOutlineMain(mainModelId),
        runDetectMain(mainModelId)
      ]);
      if (!seg.ok && !det.ok) {
        sendJson(res, seg.status || det.status || 502, {
          error: roboflowErrorMessage(seg) || roboflowErrorMessage(det) || 'Roboflow main model failed.',
          source_seg: sanitizeUrlForLog(seg.url),
          source_det: sanitizeUrlForLog(det.url),
          meta: { main_model_id: mainModelId }
        });
        return;
      }
      const segPred = seg.ok && Array.isArray(seg.payload?.predictions) ? seg.payload.predictions : [];
      const detPred = det.ok && Array.isArray(det.payload?.predictions) ? det.payload.predictions : [];
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

    if (mode === 'segment') {
      const result = await runOutlineMain(mainModelId);
      if (!result.ok) {
        sendJson(res, result.status || 502, {
          error: roboflowErrorMessage(result) || 'Roboflow segmentation failed.',
          source: sanitizeUrlForLog(result.url)
        });
        return;
      }
      sendJson(res, 200, result.payload || { predictions: [], meta: { mode: 'segment' } });
      return;
    }

    const stallRes = await runDetectStall(stallModelId);
    const stallPreds = stallRes.ok && Array.isArray(stallRes.payload?.predictions)
      ? stallRes.payload.predictions
      : [];

    const [seg, det] = await Promise.all([
      runOutlineMain(mainModelId),
      runDetectMain(mainModelId)
    ]);

    if (!stallRes.ok && !seg.ok && !det.ok) {
      const e1 = roboflowErrorMessage(stallRes);
      const e2 = roboflowErrorMessage(seg);
      const e3 = roboflowErrorMessage(det);
      const allSame = e1 === e2 && e2 === e3;
      const any403 = stallRes.status === 403 || seg.status === 403 || det.status === 403;
      sendJson(res, 502, {
        error: allSame
          ? `Roboflow rejected all requests: ${e1}`
          : 'Roboflow failed on stall model and main model (segmentation + detection).',
        stall_error: allSame ? undefined : e1,
        seg_error: allSame ? undefined : e2,
        det_error: allSame ? undefined : e3,
        hint: any403 ? hintFor403() : undefined,
        meta: {
          stall_model_id: stallModelId,
          main_model_id: mainModelId,
          stall_status: stallRes.status,
          seg_status: seg.status,
          det_status: det.status
        },
        sources: {
          stall: sanitizeUrlForLog(stallRes.url),
          seg: sanitizeUrlForLog(seg.url),
          det: sanitizeUrlForLog(det.url)
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
