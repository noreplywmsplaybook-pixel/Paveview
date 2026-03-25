const DEFAULT_SUPABASE_URL = 'https://rqgyqqyxlwjpbdkapvpz.supabase.co';

const PLAN_LIMIT_BY_PRODUCT = {
  takeoff_tier1_monthly: { limit: 15, label: 'Tier 1 Monthly' },
  takeoff_tier1_annual: { limit: 15, label: 'Tier 1 Annual' },
  takeoff_tier2_monthly: { limit: 30, label: 'Tier 2 Monthly' },
  takeoff_tier2_annual: { limit: 30, label: 'Tier 2 Annual' },
  takeoff_tier3_monthly: { limit: 60, label: 'Tier 3 Monthly' },
  takeoff_tier3_annual: { limit: 60, label: 'Tier 3 Annual' },
  // Backward compatibility.
  takeoff: { limit: Infinity, label: 'Legacy Lifetime' }
};

const PLAN_LIMIT_BY_AMOUNT = {
  9999: { limit: 15, label: 'Tier 1 Monthly' },
  99900: { limit: 15, label: 'Tier 1 Annual' },
  19999: { limit: 30, label: 'Tier 2 Monthly' },
  199999: { limit: 30, label: 'Tier 2 Annual' },
  39999: { limit: 60, label: 'Tier 3 Monthly' },
  399999: { limit: 60, label: 'Tier 3 Annual' },
  500000: { limit: Infinity, label: 'Legacy Lifetime' }
};

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

function isTrialPurchase(purchase) {
  const product = String(purchase?.product || '').toLowerCase();
  const hasExplicitFreeAmount = purchase?.amount_paid !== null && purchase?.amount_paid !== undefined && Number(purchase?.amount_paid) === 0;
  return product.includes('trial') || hasExplicitFreeAmount;
}

function resolveKnownPlan(purchase) {
  const product = String(purchase?.product || '').trim().toLowerCase();
  if (product && PLAN_LIMIT_BY_PRODUCT[product]) return PLAN_LIMIT_BY_PRODUCT[product];
  const amount = Number(purchase?.amount_paid || 0);
  if (PLAN_LIMIT_BY_AMOUNT[amount]) return PLAN_LIMIT_BY_AMOUNT[amount];
  return null;
}

function getBestPlanLimit(activePurchases) {
  let bestPlan = null;
  let hasPaidAccess = false;

  activePurchases.forEach((purchase) => {
    if (isTrialPurchase(purchase)) return;
    hasPaidAccess = true;
    const knownPlan = resolveKnownPlan(purchase);
    if (!knownPlan) {
      // Unknown paid product: do not risk falsely blocking a paid user.
      bestPlan = { limit: Infinity, label: 'Paid Access' };
      return;
    }
    if (!bestPlan) {
      bestPlan = knownPlan;
      return;
    }
    if (!Number.isFinite(knownPlan.limit)) {
      bestPlan = knownPlan;
      return;
    }
    if (!Number.isFinite(bestPlan.limit)) return;
    if (knownPlan.limit > bestPlan.limit) bestPlan = knownPlan;
  });

  if (bestPlan) return bestPlan;
  if (hasPaidAccess) return { limit: Infinity, label: 'Paid Access' };
  return { limit: Infinity, label: 'Trial' };
}

function monthRangeUtcIso(date = new Date()) {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

async function enforceMonthlyQuota({ userId, serviceRoleKey }) {
  const { startIso, endIso } = monthRangeUtcIso(new Date());
  const [purchasesRes, projectsRes] = await Promise.all([
    supabaseFetch(
      `/rest/v1/purchases?select=id,product,amount_paid,status,created_at&user_id=eq.${encodeURIComponent(userId)}&status=eq.active&order=created_at.desc&limit=100`,
      { serviceRoleKey }
    ),
    supabaseFetch(
      `/rest/v1/projects?select=id&user_id=eq.${encodeURIComponent(userId)}&created_at=gte.${encodeURIComponent(startIso)}&created_at=lt.${encodeURIComponent(endIso)}`,
      { serviceRoleKey }
    )
  ]);

  if (!purchasesRes.ok) {
    return { error: purchasesRes.payload?.message || 'Unable to load active purchases.' };
  }
  if (!projectsRes.ok) {
    return { error: projectsRes.payload?.message || 'Unable to load monthly project usage.' };
  }

  const activePurchases = Array.isArray(purchasesRes.payload) ? purchasesRes.payload : [];
  const plan = getBestPlanLimit(activePurchases);
  const monthlyProjects = Array.isArray(projectsRes.payload) ? projectsRes.payload.length : 0;

  if (Number.isFinite(plan.limit) && monthlyProjects >= plan.limit) {
    return {
      blocked: true,
      usage: {
        used: monthlyProjects,
        limit: plan.limit,
        planLabel: plan.label
      }
    };
  }

  return {
    blocked: false,
    usage: {
      used: monthlyProjects,
      limit: plan.limit,
      planLabel: plan.label
    }
  };
}

async function handlePost(req, res, serviceRoleKey) {
  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  } catch (e) {
    sendJson(res, 400, { error: 'Invalid JSON body.' });
    return;
  }

  const projectId = String(body.projectId || '').trim();
  const projectName = String(body.name || '').trim() || 'Untitled Project';
  const projectData = String(body.data || '');
  if (!projectData) {
    sendJson(res, 400, { error: 'Missing project payload.' });
    return;
  }

  const { url } = getEnv();
  const accessToken = parseBearerToken(req) || String(body.accessToken || '');
  const sessionUser = await fetchUserByAccessToken(accessToken, { url, serviceRoleKey });
  if (!sessionUser?.id) {
    sendJson(res, 401, { error: 'Unauthorized.' });
    return;
  }
  const userId = String(sessionUser.id);

  if (projectId) {
    const updateRes = await supabaseFetch(
      `/rest/v1/projects?id=eq.${encodeURIComponent(projectId)}&user_id=eq.${encodeURIComponent(userId)}`,
      {
        method: 'PATCH',
        serviceRoleKey,
        prefer: 'return=representation',
        body: { name: projectName, data: projectData, updated_at: new Date().toISOString() }
      }
    );
    if (!updateRes.ok) {
      sendJson(res, updateRes.status || 500, { error: updateRes.payload?.message || 'Failed to update project.' });
      return;
    }
    const updated = Array.isArray(updateRes.payload) ? updateRes.payload[0] : null;
    if (!updated?.id) {
      sendJson(res, 404, { error: 'Project not found or not owned by this account.' });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      projectId: String(updated.id),
      project_id: String(updated.id),
      updated: true
    });
    return;
  }

  const quota = await enforceMonthlyQuota({ userId, serviceRoleKey });
  if (quota.error) {
    sendJson(res, 500, { error: quota.error });
    return;
  }
  if (quota.blocked) {
    sendJson(res, 429, {
      error: `Monthly proposal limit reached (${quota.usage.used}/${quota.usage.limit}) for ${quota.usage.planLabel}.`,
      code: 'monthly_limit_reached',
      usage: quota.usage
    });
    return;
  }

  const insertRes = await supabaseFetch('/rest/v1/projects', {
    method: 'POST',
    serviceRoleKey,
    prefer: 'return=representation',
    body: [{
      user_id: userId,
      name: projectName,
      data: projectData,
      updated_at: new Date().toISOString()
    }]
  });
  if (!insertRes.ok) {
    sendJson(res, insertRes.status || 500, { error: insertRes.payload?.message || 'Failed to create project.' });
    return;
  }
  const created = Array.isArray(insertRes.payload) ? insertRes.payload[0] : null;
  const createdId = created?.id ? String(created.id) : null;
  sendJson(res, 200, {
    ok: true,
    projectId: createdId,
    project_id: createdId,
    created: true,
    usage: quota.usage
  });
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

  await handlePost(req, res, serviceRoleKey);
};
