/**
 * New-Testing-Grounds: main hybrid + optional stall model (dual mode).
 * Production main branch uses a simpler single-model handler.
 */

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
  const keyChain = [
    process.env.ROBOFLOW_API_KEY,
    process.env.NEXT_PUBLIC_ROBOFLOW_API_KEY,
    process.env.ROBOFLOW_KEY,
    process.env.RF_API_KEY
  ];
  const stallKey = pickFirstNonEmpty([process.env.ROBOFLOW_STALL_API_KEY, ...keyChain]);
  const mainKey = pickFirstNonEmpty([process.env.ROBOFLOW_MAIN_API_KEY, ...keyChain]);

  const mainModelIdRaw = pickFirstNonEmpty([
    process.env.ROBOFLOW_MODEL_ID,
    process.env.NEXT_PUBLIC_ROBOFLOW_MODEL_ID,
    'my-first-project-ug0a7/4'
  ]);
  const stallModelIdRaw = pickFirstNonEmpty([process.env.ROBOFLOW_STALL_MODEL_ID, '']);

  const mainWs = String(process.env.ROBOFLOW_WORKSPACE || '').trim().replace(/^\/+|\/+$/g, '');
  const stallWs = pickFirstNonEmpty([
    process.env.ROBOFLOW_STALL_WORKSPACE,
    process.env.ROBOFLOW_WORKSPACE,
    ''
  ]).replace(/^\/+|\/+$/g, '');

  const buildMainPath = () => {
    const id = String(mainModelIdRaw || '').trim().replace(/^\/+/, '');
    if (!mainWs) return id;
    return `${mainWs}/${id}`;
  };
  const buildStallPath = () => {
    const id = String(stallModelIdRaw || '').trim().replace(/^\/+/, '');
    if (!id) return '';
    if (!stallWs) return id;
    return `${stallWs}/${id}`;
  };

  const mainPath = buildMainPath();
  const stallPath = buildStallPath();

  const hint403 =
    'Roboflow 403: your Private API key cannot run this model path, or the path is wrong. '
    + 'Open Deploy → copy the Hosted Inference URL. '
    + 'Use ROBOFLOW_MODEL_ID (+ ROBOFLOW_WORKSPACE) for main; ROBOFLOW_STALL_MODEL_ID (+ ROBOFLOW_STALL_WORKSPACE or same WORKSPACE) for stall. '
    + 'Redeploy after env changes.';

  if (req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      branch: 'New-Testing-Grounds',
      features: ['stall_model', 'dual_mode', 'hybrid_main'],
      has_stall_key: Boolean(stallKey),
      has_main_key: Boolean(mainKey),
      main_model_path: mainPath,
      stall_model_path: stallPath || null,
      stall_model_configured: Boolean(stallPath),
      vercelEnv: process.env.VERCEL_ENV || null
    });
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed.' });
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

  const mode = String(body.mode || 'hybrid').toLowerCase();

  const runRequest = async (baseUrl, path, key) => {
    if (!path || !key) {
      return {
        ok: false,
        status: 500,
        payload: { error: 'Missing model path or API key.' },
        url: baseUrl
      };
    }
    const url = `${baseUrl.replace(/\/+$/, '')}/${path}?api_key=${encodeURIComponent(key)}&confidence=${confidence}&overlap=${overlap}`;
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
    /** Stall-only: detect.roboflow.com + stall model */
    if (mode === 'stall') {
      if (!stallKey || !stallPath) {
        sendJson(res, 500, {
          error: 'Stall mode requires ROBOFLOW_STALL_MODEL_ID and a valid API key.',
          hint: 'Set ROBOFLOW_STALL_MODEL_ID (and ROBOFLOW_STALL_WORKSPACE if needed).'
        });
        return;
      }
      const result = await runRequest('https://detect.roboflow.com', stallPath, stallKey);
      if (!result.ok) {
        const st = result.status || 502;
        sendJson(res, st, {
          error: result.payload?.error || result.payload?.message || 'Roboflow stall request failed.',
          hint: st === 403 ? hint403 : undefined,
          source: sanitizeUrlForLog(result.url),
          model_path_used: stallPath
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
          stall_model_id: stallModelIdRaw,
          stall_model_path: stallPath,
          prediction_count: normalized.length
        }
      });
      return;
    }

    /** Dual: stall detect + main hybrid (outline + detect), merged */
    if (mode === 'dual') {
      if (!mainKey || !mainPath) {
        sendJson(res, 500, { error: 'Dual mode requires main model env (ROBOFLOW_MODEL_ID, etc.).' });
        return;
      }
      if (!stallKey || !stallPath) {
        sendJson(res, 500, {
          error: 'Dual mode requires stall model: set ROBOFLOW_STALL_MODEL_ID.',
          hint: 'Optional ROBOFLOW_STALL_API_KEY if different from main; else ROBOFLOW_API_KEY is used.'
        });
        return;
      }

      const stallRes = await runRequest('https://detect.roboflow.com', stallPath, stallKey);
      const [seg, det] = await Promise.all([
        runRequest('https://outline.roboflow.com', mainPath, mainKey),
        runRequest('https://detect.roboflow.com', mainPath, mainKey)
      ]);

      if (!stallRes.ok && !seg.ok && !det.ok) {
        const st = stallRes.status || seg.status || det.status || 502;
        sendJson(res, st, {
          error: stallRes.payload?.error || seg.payload?.error || 'Roboflow failed (stall + main).',
          stall_error: stallRes.payload?.error || stallRes.payload?.message || `HTTP ${stallRes.status}`,
          seg_error: seg.payload?.error || seg.payload?.message || `HTTP ${seg.status}`,
          det_error: det.payload?.error || det.payload?.message || `HTTP ${det.status}`,
          hint: st === 403 ? hint403 : undefined,
          sources: {
            stall: sanitizeUrlForLog(stallRes.url),
            seg: sanitizeUrlForLog(seg.url),
            det: sanitizeUrlForLog(det.url)
          },
          model_paths: { stall: stallPath, main: mainPath }
        });
        return;
      }

      const stallPreds = stallRes.ok && Array.isArray(stallRes.payload?.predictions)
        ? stallRes.payload.predictions
        : [];
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
          stall_model_id: stallModelIdRaw,
          main_model_id: mainModelIdRaw,
          stall_model_path: stallPath,
          main_model_path: mainPath,
          stall_pass_count: stallPreds.length,
          main_segmentation_count: keepSeg.length,
          main_detection_count: keepDet.length,
          stall_ok: stallRes.ok,
          seg_ok: seg.ok,
          det_ok: det.ok,
          merged_count: mergedPredictions.length
        }
      });
      return;
    }

    if (!mainKey) {
      sendJson(res, 500, {
        error: 'Missing Roboflow API key environment variable.',
        diagnostics: {
          vercelEnv: process.env.VERCEL_ENV || null,
          has_main_key: Boolean(mainKey)
        }
      });
      return;
    }

    let result = null;
    if (mode === 'segment') {
      result = await runRequest('https://outline.roboflow.com', mainPath, mainKey);
    } else if (mode === 'detect') {
      result = await runRequest('https://detect.roboflow.com', mainPath, mainKey);
    } else {
      const [seg, det] = await Promise.all([
        runRequest('https://outline.roboflow.com', mainPath, mainKey),
        runRequest('https://detect.roboflow.com', mainPath, mainKey)
      ]);
      if (!seg.ok && !det.ok) {
        const st = seg.status || det.status || 502;
        const segMsg = seg.payload?.error || seg.payload?.message || `HTTP ${seg.status}`;
        const detMsg = det.payload?.error || det.payload?.message || `HTTP ${det.status}`;
        sendJson(res, st, {
          error: segMsg || detMsg || 'Roboflow request failed.',
          seg_error: segMsg,
          det_error: detMsg,
          hint: st === 403 ? hint403 : undefined,
          source_seg: sanitizeUrlForLog(seg.url),
          source_det: sanitizeUrlForLog(det.url),
          model_path_used: mainPath
        });
        return;
      }
      const segPred = Array.isArray(seg.payload?.predictions) ? seg.payload.predictions : [];
      const detPred = Array.isArray(det.payload?.predictions) ? det.payload.predictions : [];
      const image = seg.payload?.image || det.payload?.image || null;
      const keepSeg = segPred.filter((p) => isAreaClass(p.class));
      const keepDet = detPred.filter((p) => isSymbolClass(p.class));
      const areaFallbackFromDet = [];
      const merged = [...keepSeg, ...keepDet];
      sendJson(res, 200, {
        predictions: merged,
        image,
        meta: {
          mode: 'hybrid',
          segmentation_count: keepSeg.length,
          area_fallback_count: areaFallbackFromDet.length,
          detection_count: keepDet.length,
          seg_ok: seg.ok,
          det_ok: det.ok
        }
      });
      return;
    }

    if (!result) {
      sendJson(res, 500, { error: 'Roboflow mode configuration failed.' });
      return;
    }

    if (!result.ok) {
      const st = result.status || 502;
      sendJson(res, st, {
        error: result.payload?.error || result.payload?.message || 'Roboflow request failed.',
        hint: st === 403 ? hint403 : undefined,
        source: sanitizeUrlForLog(result.url),
        model_path_used: mainPath
      });
      return;
    }

    sendJson(res, 200, result.payload || { predictions: [], meta: { mode } });
  } catch (e) {
    sendJson(res, 500, { error: e.message || 'Roboflow request error.' });
  }
};
