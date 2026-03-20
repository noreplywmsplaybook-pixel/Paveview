const DEFAULT_SUPABASE_URL = 'https://rqgyqqyxlwjpbdkapvpz.supabase.co';
const DEFAULT_PRODUCT = 'takeoff';

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

async function fetchAuthUsers(serviceRoleKey) {
  const users = [];
  const perPage = 200;
  for (let page = 1; page <= 10; page += 1) {
    const { ok, payload } = await supabaseFetch(
      `/auth/v1/admin/users?page=${page}&per_page=${perPage}`,
      { serviceRoleKey }
    );
    if (!ok || !payload) break;
    const chunk = Array.isArray(payload.users) ? payload.users : [];
    users.push(...chunk);
    if (chunk.length < perPage) break;
  }
  return users.map((u) => ({
    id: u.id,
    email: u.email || '',
    created_at: u.created_at || null,
    last_sign_in_at: u.last_sign_in_at || null,
    user_metadata: u.user_metadata || {},
    full_name: u.user_metadata?.full_name || ''
  }));
}

async function handleGet(res, serviceRoleKey) {
  const [profilesRes, purchasesRes, projectsRes, authUsers] = await Promise.all([
    supabaseFetch('/rest/v1/profiles?select=*&order=created_at.desc', { serviceRoleKey }),
    supabaseFetch('/rest/v1/purchases?select=*&order=created_at.desc', { serviceRoleKey }),
    supabaseFetch('/rest/v1/projects?select=user_id,created_at,updated_at&order=created_at.desc', { serviceRoleKey }),
    fetchAuthUsers(serviceRoleKey)
  ]);

  sendJson(res, 200, {
    profiles: Array.isArray(profilesRes.payload) ? profilesRes.payload : [],
    purchases: Array.isArray(purchasesRes.payload) ? purchasesRes.payload : [],
    projects: Array.isArray(projectsRes.payload) ? projectsRes.payload : [],
    authUsers
  });
}

async function handlePost(req, res, serviceRoleKey) {
  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  } catch (e) {
    sendJson(res, 400, { error: 'Invalid JSON body.' });
    return;
  }
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const name = String(body.name || '').trim();
  const product = String(body.product || DEFAULT_PRODUCT).trim() || DEFAULT_PRODUCT;
  const amountDollars = Number(body.amountDollars || 0);
  const amountCents = Math.max(0, Math.round(amountDollars * 100));

  if (!email || !password) {
    sendJson(res, 400, { error: 'Email and password are required.' });
    return;
  }

  const createAuth = await supabaseFetch('/auth/v1/admin/users', {
    method: 'POST',
    serviceRoleKey,
    body: {
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: name || '' }
    }
  });
  if (!createAuth.ok) {
    sendJson(res, createAuth.status || 500, { error: createAuth.payload?.message || 'Failed to create auth user.' });
    return;
  }

  const user = createAuth.payload?.user || createAuth.payload || {};
  const userId = user.id;
  if (!userId) {
    sendJson(res, 500, { error: 'Auth user created without id.' });
    return;
  }

  // Upsert profile row (best effort).
  await supabaseFetch('/rest/v1/profiles?on_conflict=id', {
    method: 'POST',
    serviceRoleKey,
    prefer: 'resolution=merge-duplicates',
    body: [{
      id: userId,
      email,
      full_name: name || null,
      updated_at: new Date().toISOString()
    }]
  });

  const purchaseInsert = await supabaseFetch('/rest/v1/purchases', {
    method: 'POST',
    serviceRoleKey,
    body: [{
      user_id: userId,
      product,
      amount_paid: amountCents,
      status: 'active'
    }]
  });
  if (!purchaseInsert.ok) {
    sendJson(res, purchaseInsert.status || 500, { error: purchaseInsert.payload?.message || 'User created but purchase insert failed.' });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    user: {
      id: userId,
      email,
      full_name: name || ''
    }
  });
}

module.exports = async (req, res) => {
  const { serviceRoleKey } = getEnv();
  if (!serviceRoleKey) {
    sendJson(res, 500, { error: 'Missing SUPABASE_SERVICE_ROLE_KEY environment variable.' });
    return;
  }

  if (req.method === 'GET') {
    await handleGet(res, serviceRoleKey);
    return;
  }

  if (req.method === 'POST') {
    await handlePost(req, res, serviceRoleKey);
    return;
  }

  sendJson(res, 405, { error: 'Method not allowed.' });
};
