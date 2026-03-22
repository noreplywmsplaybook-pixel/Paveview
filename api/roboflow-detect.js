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
  const modelId = pickFirstNonEmpty([
    process.env.ROBOFLOW_MODEL_ID,
    process.env.NEXT_PUBLIC_ROBOFLOW_MODEL_ID,
    'my-first-project-ug0a7/4'
  ]);
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

  const imageBase64 = String(body.imageBase64 || '').trim();
  if (!imageBase64) {
    sendJson(res, 400, { error: 'imageBase64 is required.' });
    return;
  }

  const confidence = Number.isFinite(Number(body.confidence))
    ? Math.max(1, Math.min(99, Number(body.confidence)))
    : 25;
  const overlap = Number.isFinite(Number(body.overlap))
    ? Math.max(1, Math.min(99, Number(body.overlap)))
    : 30;

  try {
    const url = `https://detect.roboflow.com/${modelId}?api_key=${encodeURIComponent(apiKey)}&confidence=${confidence}&overlap=${overlap}`;
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

    if (!rfRes.ok) {
      sendJson(res, rfRes.status || 502, {
        error: payload?.error || payload?.message || 'Roboflow request failed.'
      });
      return;
    }

    sendJson(res, 200, payload || { predictions: [] });
  } catch (e) {
    sendJson(res, 500, { error: e.message || 'Roboflow request error.' });
  }
};
