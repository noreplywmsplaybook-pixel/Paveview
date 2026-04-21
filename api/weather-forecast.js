function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

async function geocode(query) {
  const q = encodeURIComponent(query);
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${q}&count=1&language=en&format=json`;
  const resp = await fetch(url);
  const payload = await resp.json().catch(() => ({}));
  const item = Array.isArray(payload.results) ? payload.results[0] : null;
  if (!item) return null;
  return {
    latitude: item.latitude,
    longitude: item.longitude,
    label: [item.name, item.admin1, item.country].filter(Boolean).join(', ')
  };
}

async function forecast(latitude, longitude) {
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    timezone: 'auto',
    forecast_days: '16',
    hourly: [
      'temperature_2m',
      'dew_point_2m',
      'relative_humidity_2m',
      'precipitation',
      'precipitation_probability',
      'wind_speed_10m',
      'cloud_cover',
      'uv_index'
    ].join(',')
  });
  const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
  const resp = await fetch(url);
  if (!resp.ok) return null;
  return resp.json().catch(() => null);
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }
  const address = String(req.query?.address || '').trim();
  const lat = Number(req.query?.lat);
  const lon = Number(req.query?.lon);

  let resolved = null;
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    resolved = { latitude: lat, longitude: lon, label: 'Pinned coordinates' };
  } else if (address) {
    resolved = await geocode(address);
  }

  if (!resolved) {
    sendJson(res, 400, { error: 'Provide valid lat/lon or an address.' });
    return;
  }

  const data = await forecast(resolved.latitude, resolved.longitude);
  if (!data?.hourly?.time?.length) {
    sendJson(res, 502, { error: 'Unable to fetch forecast data.' });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    location: resolved,
    timezone: data.timezone,
    hourly: data.hourly
  });
};
