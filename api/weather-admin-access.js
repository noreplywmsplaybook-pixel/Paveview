const DEFAULT_SUPABASE_URL = 'https://rqgyqqyxlwjpbdkapvpz.supabase.co';
const WEATHER_PRODUCT = 'weather_calendar';

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function getEnv() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
  const adminUserIds = String(process.env.ADMIN_USER_IDS || process.env.ADMIN_USER_ID || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  const adminEmails = String(process.env.ADMIN_EMAILS || process.env.ADMIN_EMAIL || '')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  return { url, serviceRoleKey, adminUserIds, adminEmails };
}

function parseBearerToken(req) {
  const authHeader = req.headers?.authorization || req.headers?.Authorization || '';
  if (!authHeader || typeof authHeader !== 'string') return '';
  if (!authHeader.toLowerCase().startsWith('bearer ')) return '';
  return authHeader.slice(7).trim();
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

function isAuthorizedAdmin(user, { adminUserIds, adminEmails }) {
  if (!user?.id) return false;
  const email = String(user.email || '').trim().toLowerCase();
  return adminUserIds.includes(String(user.id)) || (!!email && adminEmails.includes(email));
}

module.exports = async (req, res) => {
  const { serviceRoleKey, url, adminUserIds, adminEmails } = getEnv();
  if (!serviceRoleKey) {
    sendJson(res, 500, { error: 'Missing SUPABASE_SERVICE_ROLE_KEY environment variable.' });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }

  const accessToken = parseBearerToken(req);
  const sessionUser = await fetchUserByAccessToken(accessToken, { url, serviceRoleKey });
  if (!sessionUser?.id) {
    sendJson(res, 401, { error: 'Unauthorized.' });
    return;
  }
  if (!isAuthorizedAdmin(sessionUser, { adminUserIds, adminEmails })) {
    sendJson(res, 403, { error: 'Admin access required.' });
    return;
  }

  const active = await supabaseFetch(
    `/rest/v1/purchases?select=id,product,status&user_id=eq.${encodeURIComponent(sessionUser.id)}&status=eq.active&product=eq.${encodeURIComponent(WEATHER_PRODUCT)}&limit=1`,
    { serviceRoleKey }
  );
  const hasAccess = Array.isArray(active.payload) && active.payload.length > 0;
  if (!hasAccess) {
    const insert = await supabaseFetch('/rest/v1/purchases', {
      method: 'POST',
      serviceRoleKey,
      body: [{
        user_id: sessionUser.id,
        product: WEATHER_PRODUCT,
        amount_paid: 0,
        status: 'active'
      }]
    });
    if (!insert.ok) {
      sendJson(res, insert.status || 500, { error: insert.payload?.message || 'Failed to grant weather admin access.' });
      return;
    }
  }

  sendJson(res, 200, {
    ok: true,
    granted: true,
    user_id: sessionUser.id,
    email: sessionUser.email || ''
  });
};
