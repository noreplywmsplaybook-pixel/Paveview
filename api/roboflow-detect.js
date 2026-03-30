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
  const modelIdRaw = pickFirstNonEmpty([
    process.env.ROBOFLOW_MODEL_ID,
    process.env.NEXT_PUBLIC_ROBOFLOW_MODEL_ID,
    'my-first-project-ug0a7/4'
  ]);
  /** If Deploy → API shows https://detect.roboflow.com/workspace-slug/project/version, set ROBOFLOW_WORKSPACE=workspace-slug and ROBOFLOW_MODEL_ID=project/version */
  const buildModelPath = () => {
    const id = String(modelIdRaw || '').trim().replace(/^\/+/, '');
    const ws = String(process.env.ROBOFLOW_WORKSPACE || '').trim().replace(/^\/+|\/+$/g, '');
    if (!ws) return id;
    return `${ws}/${id}`;
  };
  const modelPath = buildModelPath();
  if (!apiKey) {
    sendJson(res, 500, {
      error: 'Missing Roboflow API key environment variable.',
      diagnostics: {
        vercelEnv: process.env.VERCEL_ENV || null,
        nodeEnv: process.env.NODE_ENV || null,
        has_ROBOFLOW_API_KEY: Boolean(pickFirstNonEmpty([process.env.ROBOFLOW_API_KEY])),
        has_NEXT_PUBLIC_ROBOFLOW_API_KEY: Boolean(pickFirstNonEmpty([process.env.NEXT_PUBLIC_ROBOFLOW_API_KEY])),
        has_ROBOFLOW_KEY: Boolean(pickFirstNonEmpty([process.env.ROBOFLOW_KEY])),
        has_RF_API_KEY: Boolean(pickFirstNonEmpty([process.env.RF_API_KEY]))
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
  const mode = String(body.mode || 'hybrid').toLowerCase(); // hybrid | detect | segment

  try {
    const runRequest = async (baseUrl) => {
      const url = `${baseUrl.replace(/\/+$/, '')}/${modelPath}?api_key=${encodeURIComponent(apiKey)}&confidence=${confidence}&overlap=${overlap}`;
      const rfRes = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
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

    let result = null;
    if (mode === 'segment') {
      result = await runRequest('https://outline.roboflow.com');
    } else if (mode === 'detect') {
      result = await runRequest('https://detect.roboflow.com');
    } else {
      // hybrid: get segmentation for area classes and detection for symbol classes
      const [seg, det] = await Promise.all([
        runRequest('https://outline.roboflow.com'),
        runRequest('https://detect.roboflow.com')
      ]);
      if (!seg.ok && !det.ok) {
        const st = seg.status || det.status || 502;
        const segMsg = seg.payload?.error || seg.payload?.message || `HTTP ${seg.status}`;
        const detMsg = det.payload?.error || det.payload?.message || `HTTP ${det.status}`;
        const hint403 =
          'Roboflow 403: your Private API key cannot run this model path, or the path is wrong. '
          + 'In Roboflow open Deploy → copy the exact Hosted Inference URL: path segments after detect.roboflow.com/ go into ROBOFLOW_MODEL_ID (and ROBOFLOW_WORKSPACE if the URL includes a workspace slug). '
          + 'Use the same workspace’s Private key. Redeploy after env changes.';
        sendJson(res, st, {
          error: segMsg || detMsg || 'Roboflow request failed.',
          seg_error: segMsg,
          det_error: detMsg,
          hint: st === 403 ? hint403 : undefined,
          source_seg: sanitizeUrlForLog(seg.url),
          source_det: sanitizeUrlForLog(det.url),
          model_path_used: modelPath
        });
        return;
      } else {
        const segPred = Array.isArray(seg.payload?.predictions) ? seg.payload.predictions : [];
        const detPred = Array.isArray(det.payload?.predictions) ? det.payload.predictions : [];
        const image = seg.payload?.image || det.payload?.image || null;
        const normalized = (s) => String(s || '').trim().toLowerCase();
        const isAreaClass = (cls) => {
          const c = normalized(cls);
          return c.includes('lot')
            || c.includes('obstruct')
            || c.includes('island')
            || c.includes('building')
            || c.includes('fire');
        };
        const isSymbolClass = (cls) => {
          const c = normalized(cls);
          return c.includes('stall')
            || c.includes('ada')
            || c.includes('handicap')
            || c.includes('accessible')
            || c.includes('arrow')
            || c.includes('stencil')
            || c.includes('crosswalk')
            || c.includes('hatch');
        };
        const keepSeg = segPred.filter((p) => isAreaClass(p.class));
        const keepDet = detPred.filter((p) => isSymbolClass(p.class));
        // Do not merge detect-model area predictions: they are axis-aligned boxes only.
        // Lot/obstruction outlines must come from segmentation polygons.
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
    }

    if (!result) {
      sendJson(res, 500, { error: 'Roboflow mode configuration failed.' });
      return;
    }

    if (!result.ok) {
      const st = result.status || 502;
      const hint403 =
        'Roboflow 403: key cannot access this model, or ROBOFLOW_MODEL_ID / ROBOFLOW_WORKSPACE does not match Deploy → API. Use the Private API key from that workspace. Redeploy after env changes.';
      sendJson(res, st, {
        error: result.payload?.error || result.payload?.message || 'Roboflow request failed.',
        hint: st === 403 ? hint403 : undefined,
        source: sanitizeUrlForLog(result.url),
        model_path_used: modelPath
      });
      return;
    }

    sendJson(res, 200, result.payload || { predictions: [], meta: { mode } });
  } catch (e) {
    sendJson(res, 500, { error: e.message || 'Roboflow request error.' });
  }
};
