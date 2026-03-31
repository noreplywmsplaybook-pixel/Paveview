const DEFAULT_SUPABASE_URL = 'https://rqgyqqyxlwjpbdkapvpz.supabase.co';
const DEFAULT_PRODUCT = 'takeoff_tier1_monthly';

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

function isAuthorizedAdmin(user, { adminUserIds, adminEmails }) {
  if (!user?.id) return false;
  const email = String(user.email || '').trim().toLowerCase();
  return adminUserIds.includes(String(user.id)) || (!!email && adminEmails.includes(email));
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

async function fetchLearningFeedback(serviceRoleKey) {
  const columns = [
    'id',
    'created_at',
    'updated_at',
    'user_id',
    'project_id',
    'plan_id',
    'status',
    'address',
    'map_mode',
    'map_year',
    'zoom',
    'lat',
    'lng',
    'model_id',
    'model_version',
    'draft_count',
    'final_count',
    'edit_distance',
    'payload'
  ].join(',');
  const primary = await supabaseFetch(
    `/rest/v1/learning_feedback?select=${encodeURIComponent(columns)}&order=created_at.desc&limit=500`,
    { serviceRoleKey }
  );
  if (primary.ok) return Array.isArray(primary.payload) ? primary.payload : [];

  // Graceful fallback for older DB schemas (missing newer columns).
  const fallbackColumns = [
    'id',
    'created_at',
    'updated_at',
    'user_id',
    'project_id',
    'plan_id',
    'status',
    'address',
    'map_mode',
    'map_year',
    'zoom',
    'lat',
    'lng',
    'model_id',
    'model_version',
    'draft_count',
    'final_count',
    'payload'
  ].join(',');
  const fallback = await supabaseFetch(
    `/rest/v1/learning_feedback?select=${encodeURIComponent(fallbackColumns)}&order=created_at.desc&limit=500`,
    { serviceRoleKey }
  );
  return fallback.ok && Array.isArray(fallback.payload) ? fallback.payload : [];
}

async function handleGet(res, serviceRoleKey) {
  const [profilesRes, purchasesRes, projectsRes, authUsers, learningFeedback] = await Promise.all([
    supabaseFetch('/rest/v1/profiles?select=*&order=created_at.desc', { serviceRoleKey }),
    supabaseFetch('/rest/v1/purchases?select=*&order=created_at.desc', { serviceRoleKey }),
    supabaseFetch('/rest/v1/projects?select=user_id,created_at,updated_at&order=created_at.desc', { serviceRoleKey }),
    fetchAuthUsers(serviceRoleKey),
    fetchLearningFeedback(serviceRoleKey)
  ]);

  sendJson(res, 200, {
    profiles: Array.isArray(profilesRes.payload) ? profilesRes.payload : [],
    purchases: Array.isArray(purchasesRes.payload) ? purchasesRes.payload : [],
    projects: Array.isArray(projectsRes.payload) ? projectsRes.payload : [],
    authUsers,
    learningFeedback
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

async function handlePatch(req, res, serviceRoleKey) {
  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  } catch (e) {
    sendJson(res, 400, { error: 'Invalid JSON body.' });
    return;
  }

  const action = String(body.action || '').trim().toLowerCase();
  if (!action) {
    sendJson(res, 400, { error: 'Missing action.' });
    return;
  }

  if (action === 'revoke_access') {
    const userId = String(body.userId || '').trim();
    if (!userId) {
      sendJson(res, 400, { error: 'userId is required.' });
      return;
    }
    const revoke = await supabaseFetch(
      `/rest/v1/purchases?user_id=eq.${encodeURIComponent(userId)}&status=eq.active`,
      {
        method: 'PATCH',
        serviceRoleKey,
        prefer: 'return=representation',
        body: { status: 'revoked', updated_at: new Date().toISOString() }
      }
    );
    if (!revoke.ok) {
      sendJson(res, revoke.status || 500, { error: revoke.payload?.message || 'Failed to revoke access.' });
      return;
    }
    const revokedRows = Array.isArray(revoke.payload) ? revoke.payload.length : 0;
    if (revokedRows < 1) {
      sendJson(res, 404, { error: 'No active access records found for this user.' });
      return;
    }
    sendJson(res, 200, { ok: true, userId, revoked: revokedRows });
    return;
  }

  if (action === 'restore_access') {
    const purchaseId = String(body.purchaseId || '').trim();
    if (!purchaseId) {
      sendJson(res, 400, { error: 'purchaseId is required.' });
      return;
    }
    const restore = await supabaseFetch(
      `/rest/v1/purchases?id=eq.${encodeURIComponent(purchaseId)}`,
      {
        method: 'PATCH',
        serviceRoleKey,
        prefer: 'return=representation',
        body: { status: 'active', updated_at: new Date().toISOString() }
      }
    );
    if (!restore.ok) {
      sendJson(res, restore.status || 500, { error: restore.payload?.message || 'Failed to restore access.' });
      return;
    }
    const restoredRow = Array.isArray(restore.payload) ? restore.payload[0] : null;
    if (!restoredRow?.id) {
      sendJson(res, 404, { error: 'Purchase record not found.' });
      return;
    }
    sendJson(res, 200, { ok: true, purchaseId: String(restoredRow.id) });
    return;
  }

  if (action === 'set_account_type') {
    const userId = String(body.userId || '').trim();
    const accountType = String(body.accountType || '').trim();
    const billingType = String(body.billingType || 'paid').trim().toLowerCase();
    if (!userId) {
      sendJson(res, 400, { error: 'userId is required.' });
      return;
    }
    const PRODUCT_MAP = {
      inactive: null,
      trial_24h: { product: 'takeoff_trial_24h', amount_paid: 0 },
      takeoff_tier1_monthly: { product: 'takeoff_tier1_monthly', amount_paid: 9999 },
      takeoff_tier1_annual: { product: 'takeoff_tier1_annual', amount_paid: 99900 },
      takeoff_tier2_monthly: { product: 'takeoff_tier2_monthly', amount_paid: 19999 },
      takeoff_tier2_annual: { product: 'takeoff_tier2_annual', amount_paid: 199999 },
      takeoff_tier3_monthly: { product: 'takeoff_tier3_monthly', amount_paid: 39999 },
      takeoff_tier3_annual: { product: 'takeoff_tier3_annual', amount_paid: 399999 }
    };
    if (!Object.prototype.hasOwnProperty.call(PRODUCT_MAP, accountType)) {
      sendJson(res, 400, { error: 'Invalid accountType.' });
      return;
    }
    if (!['paid', 'free'].includes(billingType)) {
      sendJson(res, 400, { error: 'Invalid billingType.' });
      return;
    }

    const revoke = await supabaseFetch(
      `/rest/v1/purchases?user_id=eq.${encodeURIComponent(userId)}&status=eq.active`,
      {
        method: 'PATCH',
        serviceRoleKey,
        body: { status: 'revoked', updated_at: new Date().toISOString() }
      }
    );
    if (!revoke.ok) {
      sendJson(res, revoke.status || 500, { error: revoke.payload?.message || 'Failed to revoke current access.' });
      return;
    }

    if (accountType === 'inactive') {
      sendJson(res, 200, { ok: true, userId, accountType, revokedOnly: true });
      return;
    }

    const target = PRODUCT_MAP[accountType];
    const amountPaid = accountType === 'trial_24h' ? 0 : (billingType === 'free' ? 0 : target.amount_paid);
    const insert = await supabaseFetch('/rest/v1/purchases', {
      method: 'POST',
      serviceRoleKey,
      body: [{
        user_id: userId,
        product: target.product,
        amount_paid: amountPaid,
        status: 'active'
      }]
    });
    if (!insert.ok) {
      sendJson(res, insert.status || 500, { error: insert.payload?.message || 'Failed to set new account type.' });
      return;
    }
    sendJson(res, 200, { ok: true, userId, accountType, billingType, amount_paid: amountPaid });
    return;
  }

  if (action === 'set_learning_status') {
    const sampleId = String(body.sampleId || '').trim();
    const status = String(body.status || '').trim().toLowerCase();
    if (!sampleId) {
      sendJson(res, 400, { error: 'sampleId is required.' });
      return;
    }
    if (!['pending', 'approved', 'rejected', 'exported'].includes(status)) {
      sendJson(res, 400, { error: 'Invalid status.' });
      return;
    }
    const patch = await supabaseFetch(
      `/rest/v1/learning_feedback?id=eq.${encodeURIComponent(sampleId)}`,
      {
        method: 'PATCH',
        serviceRoleKey,
        body: { status, updated_at: new Date().toISOString() }
      }
    );
    if (!patch.ok) {
      sendJson(res, patch.status || 500, { error: patch.payload?.message || 'Failed to update learning sample status.' });
      return;
    }
    sendJson(res, 200, { ok: true, sampleId, status });
    return;
  }

  if (action === 'export_learning_samples') {
    const wanted = Array.isArray(body.statuses) && body.statuses.length
      ? body.statuses.map((s) => String(s || '').trim().toLowerCase()).filter(Boolean)
      : ['approved'];
    const validStatuses = wanted.filter((s) => ['pending', 'approved', 'rejected', 'exported'].includes(s));
    if (!validStatuses.length) {
      sendJson(res, 400, { error: 'No valid statuses provided for export.' });
      return;
    }
    const statusClause = validStatuses.map((s) => `status.eq.${s}`).join(',');
    const query = `/rest/v1/learning_feedback?select=id,created_at,updated_at,user_id,project_id,plan_id,status,address,map_mode,map_year,zoom,lat,lng,model_id,model_version,draft_count,final_count,payload&or=(${encodeURIComponent(statusClause)})&order=created_at.desc&limit=1000`;
    const rowsRes = await supabaseFetch(query, { serviceRoleKey });
    if (!rowsRes.ok) {
      sendJson(res, rowsRes.status || 500, { error: rowsRes.payload?.message || 'Failed to fetch learning samples for export.' });
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
    return;
  }

  sendJson(res, 400, { error: 'Unsupported PATCH action.' });
}

module.exports = async (req, res) => {
  const { serviceRoleKey, url, adminUserIds, adminEmails } = getEnv();
  if (!serviceRoleKey) {
    sendJson(res, 500, { error: 'Missing SUPABASE_SERVICE_ROLE_KEY environment variable.' });
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

  if (req.method === 'GET') {
    await handleGet(res, serviceRoleKey);
    return;
  }

  if (req.method === 'POST') {
    await handlePost(req, res, serviceRoleKey);
    return;
  }

  if (req.method === 'PATCH') {
    await handlePatch(req, res, serviceRoleKey);
    return;
  }

  sendJson(res, 405, { error: 'Method not allowed.' });
};
