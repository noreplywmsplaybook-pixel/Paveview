function sendJson(res, statusCode, payload, extraHeaders = {}) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  for (const [k, v] of Object.entries(extraHeaders)) {
    res.setHeader(k, v);
  }
  res.end(JSON.stringify(payload));
}

function pickFirstNonEmpty(values) {
  for (const v of values) {
    const t = String(v || '').trim();
    if (t) return t;
  }
  return '';
}

/**
 * Roboflow hosted V1 (detect.roboflow.com / outline.roboflow.com) expects confidence & overlap
 * as 0–1 fractions in the query string (see official Python HTTP examples).
 * Values > 1 are treated as legacy percent-style (e.g. 25 → 0.25).
 */
function toRoboflowFractionParam(n, def) {
  const raw = Number.isFinite(Number(n)) ? Number(n) : def;
  if (raw > 1) return Math.min(0.99, Math.max(0.01, raw / 100));
  return Math.min(0.99, Math.max(0.01, raw));
}

/** Map common env / UI values to detect | segment | hybrid */
function normalizeInferenceModeLabel(v) {
  const s = String(v || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
  if (!s) return '';
  if (s === 'detection' || s === 'det' || s === 'object-detection' || s === 'object_detection') return 'detect';
  if (s === 'segmentation' || s === 'seg' || s === 'instance' || s === 'instance-segmentation') return 'segment';
  if (s === 'hybrid' || s === 'both') return 'hybrid';
  return s;
}

/**
 * Vercel sometimes leaves req.body unset; read JSON from the stream when needed.
 */
function readJsonBody(req) {
  if (Buffer.isBuffer(req.body)) {
    try {
      return Promise.resolve(JSON.parse(req.body.toString('utf8')));
    } catch (e) {
      return Promise.resolve({});
    }
  }
  if (req.body != null && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return Promise.resolve(req.body);
  }
  if (typeof req.body === 'string' && req.body.length) {
    try {
      return Promise.resolve(JSON.parse(req.body));
    } catch (e) {
      return Promise.resolve({});
    }
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

/** Strip api_key from Roboflow URLs before returning JSON to clients. */
function sanitizeInferenceUrl(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const u = new URL(url);
    u.searchParams.delete('api_key');
    return u.toString();
  } catch (e) {
    return String(url).replace(/([?&])api_key=[^&]*/gi, '$1').replace(/\?&/, '?').replace(/[?&]$/, '');
  }
}

const ROBOFLOW_KEY_CANDIDATES = [
  'ROBOFLOW_API_KEY',
  'NEXT_PUBLIC_ROBOFLOW_API_KEY',
  'ROBOFLOW_KEY',
  'RF_API_KEY',
  'ROBOFLOW_PRIVATE_API_KEY',
  'VERCEL_ROBOFLOW_API_KEY',
  'ROBOFLOW_API_TOKEN',
  'ROBOFLOW_INFERENCE_API_KEY',
  'ROBOFLOW_TOKEN'
];

function roboflowApiKeyFromEnv() {
  return pickFirstNonEmpty(ROBOFLOW_KEY_CANDIDATES.map((k) => process.env[k]));
}

/** Names only (no values) — safe to return to the client for debugging. */
function listRoboflowRelatedEnvKeyNames() {
  try {
    return Object.keys(process.env)
      .filter((k) => /ROBOFLOW|RF_API/i.test(k))
      .sort();
  } catch (e) {
    return [];
  }
}

function findEmptyRoboflowEnvKeys() {
  const out = [];
  for (const k of ROBOFLOW_KEY_CANDIDATES) {
    if (process.env[k] !== undefined && !pickFirstNonEmpty([process.env[k]])) {
      out.push(k);
    }
  }
  return out;
}

function buildRoboflowEnvDiagnostics() {
  const vercelEnv = process.env.VERCEL_ENV || null;
  const relatedEnvKeyNames = listRoboflowRelatedEnvKeyNames();
  const emptyValueEnvKeys = findEmptyRoboflowEnvKeys();
  let hint = '';
  if (!relatedEnvKeyNames.length) {
    hint =
      'This server process has no ROBOFLOW_* / RF_API_* variables. In Vercel: Project → Settings → Environment Variables → add ROBOFLOW_API_KEY. Branch/preview deploys need the Preview checkbox enabled (not Production-only), then Redeploy.';
  } else if (emptyValueEnvKeys.length) {
    hint = `These variables exist but are empty: ${emptyValueEnvKeys.join(', ')}. Paste the Roboflow private key value and redeploy.`;
  } else if (vercelEnv === 'preview' || vercelEnv === 'development') {
    hint = `This run is Vercel "${vercelEnv}". If the key exists only for Production, open ROBOFLOW_API_KEY in Vercel and enable Preview (and Development) for branch URLs, then Redeploy.`;
  }
  return {
    vercelEnv,
    vercelGitBranch: process.env.VERCEL_GIT_COMMIT_REF || null,
    relatedEnvKeyNames,
    emptyValueEnvKeys,
    hint
  };
}

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    const configured = Boolean(roboflowApiKeyFromEnv());
    const primaryFromEnv = pickFirstNonEmpty([
      process.env.ROBOFLOW_MODEL_ID,
      process.env.NEXT_PUBLIC_ROBOFLOW_MODEL_ID,
      process.env.ROBOFLOW_PRIMARY_MODEL_ID,
      process.env.NEXT_PUBLIC_ROBOFLOW_PRIMARY_MODEL_ID
    ]);
    const carFromEnv = pickFirstNonEmpty([
      process.env.ROBOFLOW_CAR_MODEL_ID,
      process.env.NEXT_PUBLIC_ROBOFLOW_CAR_MODEL_ID
    ]);
    const resolvedModelId = pickFirstNonEmpty([primaryFromEnv, carFromEnv, 'my-first-project-ug0a7/4']);
    const modeFromEnv = normalizeInferenceModeLabel(
      pickFirstNonEmpty([
        process.env.ROBOFLOW_INFERENCE_MODE,
        process.env.ROBOFLOW_MODE,
        process.env.NEXT_PUBLIC_ROBOFLOW_INFERENCE_MODE,
        process.env.ROBOFLOW_INFERENCE,
        process.env.INFERENCE_MODE
      ])
    );
    const payload = configured
      ? {
          ok: true,
          roboflowConfigured: true,
          vercelEnv: process.env.VERCEL_ENV || null,
          inferenceModeFromEnv: modeFromEnv || null,
          resolvedModelId,
          resolvedCarModelId: pickFirstNonEmpty([carFromEnv, 'parking-lot-egjcr-an53v/1'])
        }
      : { ok: true, roboflowConfigured: false, ...buildRoboflowEnvDiagnostics() };
    sendJson(res, 200, payload, { 'Cache-Control': 'no-store' });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }

  const apiKey = roboflowApiKeyFromEnv();
  if (!apiKey) {
    sendJson(res, 500, {
      error: 'Missing Roboflow API key environment variable.',
      diagnostics: {
        nodeEnv: process.env.NODE_ENV || null,
        ...buildRoboflowEnvDiagnostics(),
        has_ROBOFLOW_API_KEY: Boolean(pickFirstNonEmpty([process.env.ROBOFLOW_API_KEY])),
        has_NEXT_PUBLIC_ROBOFLOW_API_KEY: Boolean(pickFirstNonEmpty([process.env.NEXT_PUBLIC_ROBOFLOW_API_KEY])),
        has_ROBOFLOW_KEY: Boolean(pickFirstNonEmpty([process.env.ROBOFLOW_KEY])),
        has_RF_API_KEY: Boolean(pickFirstNonEmpty([process.env.RF_API_KEY])),
        has_ROBOFLOW_PRIVATE_API_KEY: Boolean(pickFirstNonEmpty([process.env.ROBOFLOW_PRIVATE_API_KEY])),
        has_VERCEL_ROBOFLOW_API_KEY: Boolean(pickFirstNonEmpty([process.env.VERCEL_ROBOFLOW_API_KEY])),
        has_ROBOFLOW_API_TOKEN: Boolean(pickFirstNonEmpty([process.env.ROBOFLOW_API_TOKEN])),
        has_ROBOFLOW_INFERENCE_API_KEY: Boolean(pickFirstNonEmpty([process.env.ROBOFLOW_INFERENCE_API_KEY])),
        has_ROBOFLOW_TOKEN: Boolean(pickFirstNonEmpty([process.env.ROBOFLOW_TOKEN]))
      }
    });
    return;
  }

  let body = {};
  try {
    body = await readJsonBody(req);
    if (!body || typeof body !== 'object') body = {};
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

  const rawConf = Number.isFinite(Number(body.confidence)) ? Number(body.confidence) : 25;
  const rawOverlap = Number.isFinite(Number(body.overlap)) ? Number(body.overlap) : 30;
  const confFrac = toRoboflowFractionParam(rawConf, 0.25);
  const overlapFrac = toRoboflowFractionParam(rawOverlap, 0.3);
  const modeFromEnv = normalizeInferenceModeLabel(
    pickFirstNonEmpty([
      process.env.ROBOFLOW_INFERENCE_MODE,
      process.env.ROBOFLOW_MODE,
      process.env.NEXT_PUBLIC_ROBOFLOW_INFERENCE_MODE,
      process.env.ROBOFLOW_INFERENCE,
      process.env.INFERENCE_MODE
    ])
  );
  const modeFromBody = normalizeInferenceModeLabel(body.mode || 'hybrid');
  const mode =
    modeFromEnv === 'hybrid' || modeFromEnv === 'detect' || modeFromEnv === 'segment'
      ? modeFromEnv
      : modeFromBody === 'hybrid' || modeFromBody === 'detect' || modeFromBody === 'segment'
        ? modeFromBody
        : 'hybrid';

  /** Primary model: explicit ROBOFLOW_MODEL_ID, else fall back to car model id (single-model Vercel setups). */
  const primaryFromEnv = pickFirstNonEmpty([
    process.env.ROBOFLOW_MODEL_ID,
    process.env.NEXT_PUBLIC_ROBOFLOW_MODEL_ID,
    process.env.ROBOFLOW_PRIMARY_MODEL_ID,
    process.env.NEXT_PUBLIC_ROBOFLOW_PRIMARY_MODEL_ID
  ]);
  const carFromEnv = pickFirstNonEmpty([
    process.env.ROBOFLOW_CAR_MODEL_ID,
    process.env.NEXT_PUBLIC_ROBOFLOW_CAR_MODEL_ID
  ]);
  const modelId = pickFirstNonEmpty([primaryFromEnv, carFromEnv, 'my-first-project-ug0a7/4']);
  const carModelId = pickFirstNonEmpty([carFromEnv, 'parking-lot-egjcr-an53v/1']);

  try {
    const runRequest = async (baseUrl) => {
      const q = new URLSearchParams({
        api_key: apiKey,
        confidence: String(confFrac),
        overlap: String(overlapFrac)
      });
      const url = `${baseUrl}/${modelId}?${q.toString()}`;
      /** Official Roboflow V1 hosted examples: raw base64 in body + Content-Type: application/json */
      const postOpts = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: imageBase64
      };
      let rfRes = await fetch(url, postOpts);
      let payload = null;
      try {
        payload = await rfRes.json();
      } catch (e) {
        payload = null;
      }
      if (!rfRes.ok) {
        const retry = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: imageBase64
        });
        let retryPayload = null;
        try {
          retryPayload = await retry.json();
        } catch (e) {
          retryPayload = null;
        }
        if (retry.ok) {
          return { ok: true, status: retry.status, payload: retryPayload, url };
        }
      }
      return { ok: rfRes.ok, status: rfRes.status, payload, url };
    };

    /** Second model (cars) — merged as parking_stall for yellow-dot UX. Same key as primary. */
    const fetchCarModelPredictionsNormalized = async () => {
      if (!carModelId || carModelId === modelId) return [];
      try {
        const cq = new URLSearchParams({
          api_key: apiKey,
          confidence: String(confFrac),
          overlap: String(overlapFrac)
        });
        const carUrl = `https://detect.roboflow.com/${carModelId}?${cq.toString()}`;
        const carRes = await fetch(carUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: imageBase64
        });
        let carPayload = null;
        try {
          carPayload = await carRes.json();
        } catch (e) {
          return [];
        }
        if (!carRes.ok || !carPayload || !Array.isArray(carPayload.predictions)) return [];
        return carPayload.predictions.map((p) => ({
          ...p,
          class: 'parking_stall',
          confidence:
            typeof p.confidence === 'number'
              ? p.confidence
              : Number(p.confidence) || 0,
          detection_source: 'roboflow_car'
        }));
      } catch (e) {
        return [];
      }
    };

    const mergeCarModelIntoPrimaryResult = async (baseResult) => {
      if (!baseResult || !baseResult.ok || !baseResult.payload) return baseResult;
      const carNorm = await fetchCarModelPredictionsNormalized();
      if (!carNorm.length) return baseResult;
      const base = Array.isArray(baseResult.payload.predictions)
        ? baseResult.payload.predictions
        : [];
      return {
        ...baseResult,
        payload: {
          ...baseResult.payload,
          predictions: base.concat(carNorm),
          meta: {
            ...(typeof baseResult.payload.meta === 'object' && baseResult.payload.meta
              ? baseResult.payload.meta
              : {}),
            car_model_count: carNorm.length
          }
        }
      };
    };

    let result = null;
    if (mode === 'segment') {
      result = await mergeCarModelIntoPrimaryResult(
        await runRequest('https://outline.roboflow.com')
      );
    } else if (mode === 'detect') {
      result = await mergeCarModelIntoPrimaryResult(
        await runRequest('https://detect.roboflow.com')
      );
    } else {
      // hybrid: get segmentation for area classes and detection for symbol classes
      const [seg, det] = await Promise.all([
        runRequest('https://outline.roboflow.com'),
        runRequest('https://detect.roboflow.com')
      ]);
      if (!seg.ok && !det.ok) {
        result = seg;
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
            || c.includes('hatch')
            || c.includes('car')
            || c.includes('vehicle')
            || c.includes('parking');
        };
        const keepSeg = segPred.filter((p) => isAreaClass(p.class));
        let keepDet = detPred.filter((p) => isSymbolClass(p.class));
        // Do not merge detect-model area predictions: they are axis-aligned boxes only.
        // Lot/obstruction outlines must come from segmentation polygons.
        const areaFallbackFromDet = [];
        let merged = [...keepSeg, ...keepDet];
        // If class filters removed everything but the detect endpoint returned boxes, keep raw detections.
        let hybridFallbackAllDet = false;
        if (!merged.length && detPred.length) {
          merged = detPred.slice();
          hybridFallbackAllDet = true;
        }
        const carPred = await fetchCarModelPredictionsNormalized();
        merged = merged.concat(carPred);
        sendJson(res, 200, {
          predictions: merged,
          image,
          meta: {
            mode: 'hybrid',
            segmentation_count: keepSeg.length,
            area_fallback_count: areaFallbackFromDet.length,
            detection_count: keepDet.length,
            car_model_count: carPred.length,
            seg_ok: seg.ok,
            det_ok: det.ok,
            hybrid_fallback_all_det: hybridFallbackAllDet
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
      const rawErr = result.payload?.error || result.payload?.message || 'Roboflow request failed.';
      let errMsg =
        typeof rawErr === 'string' || typeof rawErr === 'number' ? String(rawErr) : 'Roboflow request failed.';
      if (
        result.status === 403 ||
        /forbidden/i.test(errMsg) ||
        /forbidden/i.test(JSON.stringify(result.payload || {}))
      ) {
        errMsg = `Roboflow Forbidden for model "${modelId}". Your API key is valid but cannot run this model. In Vercel: set ROBOFLOW_MODEL_ID to your main model (or leave it unset and use only ROBOFLOW_CAR_MODEL_ID — that value is used as the primary id when the primary slot is empty). For a detect-only model, set ROBOFLOW_INFERENCE_MODE=detect. Roboflow → Deploy → API for model ids.`;
      }
      sendJson(res, result.status || 502, {
        error: errMsg,
        source: sanitizeInferenceUrl(result.url),
        modelId
      });
      return;
    }

    sendJson(res, 200, result.payload || { predictions: [], meta: { mode } });
  } catch (e) {
    sendJson(res, 500, { error: e.message || 'Roboflow request error.' });
  }
};
