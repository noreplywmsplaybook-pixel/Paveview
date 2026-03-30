function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function normalizeSecret(v) {
  let t = String(v || '').trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1).trim();
  }
  return t;
}

function pickFirstNonEmpty(values) {
  for (const v of values) {
    const t = normalizeSecret(v);
    if (t) return t;
  }
  return '';
}

/**
 * Which env var supplied the key matters: ROBOFLOW_STALL_API_KEY / ROBOFLOW_MAIN_API_KEY
 * take precedence over ROBOFLOW_API_KEY. A stale override in Vercel causes 401 even when ROBOFLOW_API_KEY is correct.
 */
function pickKeyWithSource(entries) {
  for (const { name, value } of entries) {
    const t = normalizeSecret(value);
    if (t) return { key: t, source: name };
  }
  return { key: '', source: null };
}

function keyTailFingerprint(key) {
  const k = String(key || '');
  if (!k.length) return null;
  return { length: k.length, tail: k.slice(-4) };
}

/** Server inference must use Private API keys. Do not use NEXT_PUBLIC_* here — it is often a publishable key and causes 401 Unauthorized. */
const serverInferenceFallbackKeys = (env) => [
  env.ROBOFLOW_API_KEY,
  env.ROBOFLOW_KEY,
  env.RF_API_KEY
];

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
  const stallEntries = [
    { name: 'ROBOFLOW_STALL_API_KEY', value: process.env.ROBOFLOW_STALL_API_KEY },
    { name: 'ROBOFLOW_API_KEY', value: process.env.ROBOFLOW_API_KEY },
    { name: 'ROBOFLOW_KEY', value: process.env.ROBOFLOW_KEY },
    { name: 'RF_API_KEY', value: process.env.RF_API_KEY }
  ];
  const mainEntries = [
    { name: 'ROBOFLOW_MAIN_API_KEY', value: process.env.ROBOFLOW_MAIN_API_KEY },
    { name: 'ROBOFLOW_API_KEY', value: process.env.ROBOFLOW_API_KEY },
    { name: 'ROBOFLOW_KEY', value: process.env.ROBOFLOW_KEY },
    { name: 'RF_API_KEY', value: process.env.RF_API_KEY }
  ];

  const stallPick = pickKeyWithSource(stallEntries);
  const mainPick = pickKeyWithSource(mainEntries);
  const stallApiKey = stallPick.key;
  const mainApiKey = mainPick.key;

  const stallModelId = pickFirstNonEmpty([
    process.env.ROBOFLOW_STALL_MODEL_ID,
    'parking-lot-egjcr-an53v/1'
  ]);

  const mainModelId = pickFirstNonEmpty([
    process.env.ROBOFLOW_MAIN_MODEL_ID,
    process.env.ROBOFLOW_MODEL_ID,
    'my-first-project-ug0a7/6'
  ]);

  /** Some deploy tabs show workspace/project/version — prepend workspace if ROBOFLOW_WORKSPACE is set. */
  const buildModelPath = (modelId) => {
    const id = String(modelId || '').trim().replace(/^\/+/, '');
    const ws = String(process.env.ROBOFLOW_WORKSPACE || '').trim().replace(/^\/+|\/+$/g, '');
    if (!ws) return id;
    return `${ws}/${id}`;
  };

  if (req.method === 'GET') {
    const sameKey = Boolean(stallApiKey && mainApiKey && stallApiKey === mainApiKey);
    sendJson(res, 200, {
      ok: true,
      service: 'roboflow-detect',
      has_stall_key: Boolean(stallApiKey),
      has_main_key: Boolean(mainApiKey),
      single_key_for_both: sameKey,
      dual_project_keys: Boolean(
        pickFirstNonEmpty([process.env.ROBOFLOW_STALL_API_KEY])
        && pickFirstNonEmpty([process.env.ROBOFLOW_MAIN_API_KEY])
      ),
      vercelEnv: process.env.VERCEL_ENV || null,
      stall_model_id: stallModelId,
      main_model_id: mainModelId,
      stall_path: buildModelPath(stallModelId),
      main_path: buildModelPath(mainModelId),
      workspace_prefix: pickFirstNonEmpty([process.env.ROBOFLOW_WORKSPACE]) || null,
      stall_key_from: stallPick.source,
      main_key_from: mainPick.source,
      stall_key_fingerprint: keyTailFingerprint(stallApiKey),
      main_key_fingerprint: keyTailFingerprint(mainApiKey),
      override_warning:
        (stallPick.source && stallPick.source !== 'ROBOFLOW_API_KEY')
        || (mainPick.source && mainPick.source !== 'ROBOFLOW_API_KEY')
          ? 'ROBOFLOW_STALL_API_KEY / ROBOFLOW_MAIN_API_KEY override ROBOFLOW_API_KEY. If those vars are set to an old key, you will get 401 until you delete them or update them to match your current private key.'
          : null,
      key_env_note:
        'This route reads ROBOFLOW_API_KEY, ROBOFLOW_STALL_API_KEY, ROBOFLOW_MAIN_API_KEY, ROBOFLOW_KEY, RF_API_KEY only. NEXT_PUBLIC_ROBOFLOW_API_KEY is ignored (often publishable; causes 401 if used server-side).',
      hint: (!stallApiKey || !mainApiKey)
        ? 'Set ROBOFLOW_API_KEY (Private key) for both passes, or separate ROBOFLOW_STALL_API_KEY / ROBOFLOW_MAIN_API_KEY if models live in different Roboflow workspaces. Enable Preview + Production in Vercel.'
        : (sameKey
          ? 'One key is used for stall + main. Roboflow must allow that key to run both model IDs (same workspace or shared access). If you get 403, the key cannot access one of the projects.'
          : 'Stall and main use different API keys. POST with imageDataUrl or imageBase64.')
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

  /**
   * Hosted V1: raw base64 in body with application/x-www-form-urlencoded (Roboflow docs).
   * application/json body must be valid JSON — use JSON.stringify(base64) for a JSON string value.
   * Order: documented form transports first, then Bearer, then JSON string bodies.
   */
  const postImageToRoboflow = async (baseUrl, modelId, keyForRequest) => {
    const path = buildModelPath(modelId);
    const qsWithKey = () => {
      const p = new URLSearchParams();
      p.set('api_key', keyForRequest);
      p.set('confidence', String(confidence));
      p.set('overlap', String(overlap));
      return p.toString();
    };
    const qsNoKey = () => {
      const p = new URLSearchParams();
      p.set('confidence', String(confidence));
      p.set('overlap', String(overlap));
      return p.toString();
    };
    const base = `${baseUrl.replace(/\/+$/, '')}/${path}`;
    const jsonBody = JSON.stringify(imageBase64);

    const tryOnce = async (url, contentType, body, extraHeaders = {}) => {
      const rfRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': contentType, ...extraHeaders },
        body
      });
      const payload = await parseRfBody(rfRes);
      return { rfRes, payload, url };
    };

    const attempts = [];
    let last = null;

    const run = async (label, url, ct, body, headers = {}) => {
      const t = await tryOnce(url, ct, body, headers);
      last = t;
      attempts.push(label);
      if (isRoboflowSuccess(t.rfRes, t.payload)) {
        return { ok: true, status: t.rfRes.status, payload: t.payload, url: t.url, transport: label };
      }
      return null;
    };

    let hit = await run('query+form', `${base}?${qsWithKey()}`, 'application/x-www-form-urlencoded', imageBase64);
    if (hit) return hit;
    hit = await run('bearer+form', `${base}?${qsNoKey()}`, 'application/x-www-form-urlencoded', imageBase64, {
      Authorization: `Bearer ${keyForRequest}`
    });
    if (hit) return hit;
    hit = await run('query+json', `${base}?${qsWithKey()}`, 'application/json', jsonBody);
    if (hit) return hit;
    hit = await run('bearer+json', `${base}?${qsNoKey()}`, 'application/json', jsonBody, {
      Authorization: `Bearer ${keyForRequest}`
    });
    if (hit) return hit;

    const t = last;
    return {
      ok: false,
      status: t?.rfRes?.status || 502,
      payload: t?.payload,
      url: t?.url,
      transport: 'failed',
      attempts: attempts.join(' → ')
    };
  };

  const runDetectStall = async (modelId) => postImageToRoboflow('https://detect.roboflow.com', modelId, stallApiKey);
  const runDetectMain = async (modelId) => postImageToRoboflow('https://detect.roboflow.com', modelId, mainApiKey);
  const runOutlineMain = async (modelId) => postImageToRoboflow('https://outline.roboflow.com', modelId, mainApiKey);

  const roboflowErrorMessage = (result) => {
    const p = result?.payload;
    const base = p?.error || p?.message || p?.detail || `HTTP ${result?.status}`;
    if (result?.status === 401 || String(base).toLowerCase().includes('unauthorized')) {
      const suffix = result?.attempts ? ` [${result.attempts}]` : '';
      return `Unauthorized (401)${suffix}`;
    }
    if (result?.status === 403 || String(base).toLowerCase().includes('forbidden')) {
      return 'Forbidden (403)';
    }
    if (result?.attempts) return `${base} [${result.attempts}]`;
    return base;
  };

  const hintFor401 = () =>
    'Roboflow 401: wrong key reaching the server, or ROBOFLOW_STALL_API_KEY / ROBOFLOW_MAIN_API_KEY overriding ROBOFLOW_API_KEY with an old value. Open GET /api/roboflow-detect and check stall_key_from, main_key_from, and key fingerprints (last 4 chars) against your Roboflow private key. Remove split-key env vars if you only use ROBOFLOW_API_KEY. Redeploy after env changes.';

  const hintFor403 = () => 'Roboflow 403: key rejected or model path wrong. Confirm Private API key and model IDs from Deploy → API. If the URL shows a workspace slug before project/version, set ROBOFLOW_WORKSPACE. This server tries query api_key and Authorization Bearer. Redeploy after env changes.';

  try {
    if (mode === 'stall' || mode === 'detect') {
      const result = await runDetectStall(stallModelId);
      if (!result.ok) {
        sendJson(res, result.status || 502, {
          error: roboflowErrorMessage(result) || 'Roboflow stall model request failed.',
          hint: result.status === 403 ? hintFor403() : result.status === 401 ? hintFor401() : undefined,
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
        const st = seg.status || det.status || 502;
        sendJson(res, st, {
          error: roboflowErrorMessage(seg) || roboflowErrorMessage(det) || 'Roboflow main model failed.',
          hint: st === 403 ? hintFor403() : st === 401 ? hintFor401() : undefined,
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
        const st = result.status || 502;
        sendJson(res, st, {
          error: roboflowErrorMessage(result) || 'Roboflow segmentation failed.',
          hint: st === 403 ? hintFor403() : st === 401 ? hintFor401() : undefined,
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
      const any401 = stallRes.status === 401 || seg.status === 401 || det.status === 401;
      sendJson(res, 502, {
        error: allSame
          ? `Roboflow rejected all requests: ${e1}`
          : 'Roboflow failed on stall model and main model (segmentation + detection).',
        stall_error: allSame ? undefined : e1,
        seg_error: allSame ? undefined : e2,
        det_error: allSame ? undefined : e3,
        hint: any403 ? hintFor403() : any401 ? hintFor401() : undefined,
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
