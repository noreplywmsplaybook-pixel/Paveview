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

async function supabaseFetch(path, { method = 'GET', serviceRoleKey, body } = {}) {
  const { url } = getEnv();
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
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

function parseBody(req) {
  if (!req?.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body || '{}'); } catch (_) { return {}; }
  }
  return req.body || {};
}

module.exports = async (req, res) => {
  const { serviceRoleKey } = getEnv();
  if (!serviceRoleKey) {
    sendJson(res, 500, { error: 'Missing SUPABASE_SERVICE_ROLE_KEY environment variable.' });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }

  const body = parseBody(req);
  const statuses = Array.isArray(body.statuses) && body.statuses.length
    ? body.statuses.map((s) => String(s || '').trim().toLowerCase()).filter(Boolean)
    : ['approved'];
  const validStatuses = statuses.filter((s) => ['pending', 'approved', 'rejected', 'exported'].includes(s));
  if (!validStatuses.length) {
    sendJson(res, 400, { error: 'No valid statuses provided.' });
    return;
  }

  const statusClause = validStatuses.map((s) => `status.eq.${s}`).join(',');
  const query = `/rest/v1/learning_feedback?select=id,created_at,updated_at,user_id,project_id,plan_id,status,address,map_mode,map_year,zoom,lat,lng,model_id,model_version,draft_count,final_count,payload&or=(${encodeURIComponent(statusClause)})&order=created_at.desc&limit=1000`;
  const rowsRes = await supabaseFetch(query, { serviceRoleKey });
  if (!rowsRes.ok) {
    sendJson(res, rowsRes.status || 500, { error: rowsRes.payload?.message || 'Failed to fetch learning samples.' });
    return;
  }
  const rows = Array.isArray(rowsRes.payload) ? rowsRes.payload : [];
  sendJson(res, 200, {
    ok: true,
    exportedAt: new Date().toISOString(),
    statuses: validStatuses,
    count: rows.length,
    samples: rows
  });
};
