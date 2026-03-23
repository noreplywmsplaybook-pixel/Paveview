const DEFAULT_SUPABASE_URL = 'https://rqgyqqyxlwjpbdkapvpz.supabase.co';

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function getEnv() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
  return { url, serviceRoleKey };
}

function parseBearerToken(req) {
  const authHeader = req.headers?.authorization || req.headers?.Authorization || '';
  if (!authHeader || typeof authHeader !== 'string') return '';
  if (!authHeader.toLowerCase().startsWith('bearer ')) return '';
  return authHeader.slice(7).trim();
}

async function fetchUserByAccessToken(accessToken, { url, serviceRoleKey }) {
  if (!accessToken) return null;
  const resp = await fetch(`${url}/auth/v1/user`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${accessToken}`
    }
  });
  if (!resp.ok) return null;
  try {
    return await resp.json();
  } catch (e) {
    return null;
  }
}

async function supabaseFetch(path, { method = 'GET', serviceRoleKey, body, prefer } = {}) {
  const { url } = getEnv();
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (prefer) headers.Prefer = prefer;

  const resp = await fetch(`${url}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  let payload = null;
  try {
    payload = await resp.json();
  } catch (e) {
    payload = null;
  }
  return { ok: resp.ok, status: resp.status, payload };
}

function safeString(v, maxLen = 500) {
  const s = String(v || '').trim();
  return s ? s.slice(0, maxLen) : null;
}

function safeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function safeArray(v) {
  return Array.isArray(v) ? v : [];
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }

  const { serviceRoleKey, url } = getEnv();
  if (!serviceRoleKey) {
    sendJson(res, 500, { error: 'Missing SUPABASE_SERVICE_ROLE_KEY environment variable.' });
    return;
  }

  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  } catch (e) {
    sendJson(res, 400, { error: 'Invalid JSON body.' });
    return;
  }

  const accessToken = parseBearerToken(req) || safeString(body.accessToken, 4096) || '';
  const authUser = await fetchUserByAccessToken(accessToken, { url, serviceRoleKey });
  const userId = safeString(body.userId, 128) || safeString(authUser?.id, 128);
  if (!userId) {
    sendJson(res, 401, { error: 'Missing authenticated user.' });
    return;
  }

  const draftDetections = safeArray(body.draftDetections);
  const finalDetections = safeArray(body.finalDetections);
  const payload = {
    sample_schema_version: 1,
    client_sample_id: safeString(body.clientSampleId, 128),
    draftDetections,
    finalDetections,
    mapContext: body.mapContext && typeof body.mapContext === 'object' ? body.mapContext : {},
    summary: body.summary && typeof body.summary === 'object' ? body.summary : {}
  };

  const row = {
    user_id: userId,
    project_id: safeString(body.projectId, 128),
    plan_id: safeString(body.planId, 128),
    status: 'pending',
    address: safeString(body.mapContext?.address, 500),
    map_mode: safeString(body.mapContext?.mapMode, 64),
    map_year: safeString(body.mapContext?.mapYear, 32),
    zoom: safeNumber(body.mapContext?.zoom),
    lat: safeNumber(body.mapContext?.lat),
    lng: safeNumber(body.mapContext?.lng),
    model_id: safeString(body.mapContext?.modelId, 200),
    model_version: safeString(body.mapContext?.modelVersion, 64),
    draft_count: draftDetections.length,
    final_count: finalDetections.length,
    edit_distance: safeNumber(body.summary?.editDistance),
    payload,
    updated_at: new Date().toISOString()
  };

  const insert = await supabaseFetch('/rest/v1/learning_feedback', {
    method: 'POST',
    serviceRoleKey,
    prefer: 'return=representation',
    body: [row]
  });
  if (!insert.ok) {
    sendJson(res, insert.status || 500, {
      error: insert.payload?.message || 'Failed to store learning feedback.'
    });
    return;
  }

  const inserted = Array.isArray(insert.payload) ? insert.payload[0] : null;
  sendJson(res, 200, {
    ok: true,
    sampleId: inserted?.id || null,
    status: inserted?.status || 'pending'
  });
};

