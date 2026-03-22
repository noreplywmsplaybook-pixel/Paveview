function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }

  const apiKey = process.env.ROBOFLOW_API_KEY || '';
  const modelId = process.env.ROBOFLOW_MODEL_ID || 'my-first-project-ug0a7/4';
  if (!apiKey) {
    sendJson(res, 500, { error: 'Missing ROBOFLOW_API_KEY environment variable.' });
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
