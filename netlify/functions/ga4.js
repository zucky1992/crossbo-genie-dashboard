/**
 * Netlify Function: ga4.js v3
 * Full event inventory + rich dimension queries using all 35 registered custom dimensions.
 */

const GA4_PROPERTY_ID = '503373961';
const GA4_API_BASE = 'https://analyticsdata.googleapis.com/v1beta';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';

function base64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function getAccessToken(serviceAccount) {
  const crypto = require('crypto');
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/analytics.readonly',
    aud: TOKEN_URI, iat: now, exp: now + 3600,
  }));
  const signingInput = `${header}.${payload}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signingInput);
  const sig = base64url(sign.sign(serviceAccount.private_key));
  const jwt = `${signingInput}.${sig}`;
  const res = await fetch(TOKEN_URI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Token error: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function runReport(token, body) {
  const res = await fetch(`${GA4_API_BASE}/properties/${GA4_PROPERTY_ID}:runReport`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) { const err = await res.text(); throw new Error(`GA4 API error: ${err}`); }
  return res.json();
}

function moduleFilter(module) {
  const mods = Array.isArray(module) ? module : [module];
  if (mods.length === 1) return { filter: { fieldName: 'customEvent:source_module', stringFilter: { value: mods[0] } } };
  return { orGroup: { expressions: mods.map(m => ({ filter: { fieldName: 'customEvent:source_module', stringFilter: { value: m } } })) } };
}

function clickFilter(module, screen) {
  const expressions = [{ filter: { fieldName: 'eventName', stringFilter: { value: 'click_event' } } }];
  if (module) {
    const mods = Array.isArray(module) ? module : [module];
    if (mods.length === 1) expressions.push({ filter: { fieldName: 'customEvent:source_module', stringFilter: { value: mods[0] } } });
    else expressions.push({ orGroup: { expressions: mods.map(m => ({ filter: { fieldName: 'customEvent:source_module', stringFilter: { value: m } } })) } });
  }
  if (screen) expressions.push({ filter: { fieldName: 'customEvent:source_screen', stringFilter: { value: screen } } });
  return expressions.length === 1 ? expressions[0] : { andGroup: { expressions } };
}

function buildReportBody(report, startDate, endDate) {
  const dateRange = [{ startDate, endDate }];
  const clickDims = [
    { name: 'customEvent:label' },
    { name: 'customEvent:value' },
    { name: 'customEvent:source_screen' },
    { name: 'customEvent:source_module' },
  ];

  const reports = {

    // ── Screen views ──────────────────────────────────────────────────
    screen_views: {
      dateRanges: dateRange,
      dimensions: [{ name: 'unifiedScreenName' }],
      metrics: [{ name: 'screenPageViews' }, { name: 'userEngagementDuration' }],
      dimensionFilter: {
        notExpression: { filter: { fieldName: 'unifiedScreenName', stringFilter: { value: '(not set)' } } }
      },
      orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
      limit: 50,
    },

    // ── Booking funnel with dept breakdown ────────────────────────────
    booking_funnel: {
      dateRanges: dateRange,
      dimensions: [
        { name: 'eventName' },
        { name: 'customEvent:source_module' },
      ],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        orGroup: { expressions: [
          { filter: { fieldName: 'eventName', stringFilter: { value: 'booking_start' } } },
          { filter: { fieldName: 'eventName', stringFilter: { value: 'booking_complete' } } },
          { filter: { fieldName: 'eventName', stringFilter: { value: 'booking_abandoned' } } },
          { filter: { fieldName: 'eventName', stringFilter: { value: 'booking_view' } } },
        ]}
      },
      limit: 500,
    },

    // ── Abandonment by step — WHERE guests drop off ───────────────────
    abandon_by_step: {
      dateRanges: dateRange,
      dimensions: [
        { name: 'customEvent:source_module' },
        { name: 'customEvent:step' },
      ],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        filter: { fieldName: 'eventName', stringFilter: { value: 'booking_abandoned' } }
      },
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: 200,
    },

    // ── Booking complete enriched — value, guests, time, category ─────
    booking_complete_detail: {
      dateRanges: dateRange,
      dimensions: [
        { name: 'customEvent:source_module' },
        { name: 'customEvent:category' },
        { name: 'customEvent:service' },
        { name: 'customEvent:guest_count' },
        { name: 'customEvent:time_taken' },
        { name: 'customEvent:total' },
      ],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        filter: { fieldName: 'eventName', stringFilter: { value: 'booking_complete' } }
      },
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: 500,
    },

    // ── Revenue by dept (booking_complete total) ──────────────────────
    revenue_by_dept: {
      dateRanges: dateRange,
      dimensions: [
        { name: 'customEvent:source_module' },
        { name: 'customEvent:total' },
      ],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        filter: { fieldName: 'eventName', stringFilter: { value: 'booking_complete' } }
      },
      orderBys: [{ dimension: { dimensionName: 'customEvent:source_module' } }],
      limit: 500,
    },

    // ── Top services booked ───────────────────────────────────────────
    top_services: {
      dateRanges: dateRange,
      dimensions: [
        { name: 'customEvent:source_module' },
        { name: 'customEvent:category' },
        { name: 'customEvent:service' },
      ],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        filter: { fieldName: 'eventName', stringFilter: { value: 'booking_complete' } }
      },
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: 200,
    },

    // ── All click_events ──────────────────────────────────────────────
    click_events: {
      dateRanges: dateRange,
      dimensions: clickDims,
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: { filter: { fieldName: 'eventName', stringFilter: { value: 'click_event' } } },
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: 500,
    },

    // ── Home ──────────────────────────────────────────────────────────
    home: {
      dateRanges: dateRange,
      dimensions: clickDims,
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: clickFilter('home', null),
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: 100,
    },

    // ── IRD ───────────────────────────────────────────────────────────
    ird_menu: {
      dateRanges: dateRange,
      dimensions: clickDims,
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: clickFilter('dining', null),
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: 200,
    },

    // ── Cart ──────────────────────────────────────────────────────────
    cart: {
      dateRanges: dateRange,
      dimensions: clickDims,
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: clickFilter(null, 'cart'),
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: 100,
    },

    // ── Activity ──────────────────────────────────────────────────────
    activity: {
      dateRanges: dateRange,
      dimensions: clickDims,
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: clickFilter('activity', null),
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: 100,
    },

    // ── SPA ───────────────────────────────────────────────────────────
    spa: {
      dateRanges: dateRange,
      dimensions: clickDims,
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        orGroup: { expressions: [
          { filter: { fieldName: 'customEvent:source_module', stringFilter: { value: 'spa' } } },
          { filter: { fieldName: 'customEvent:source_module', stringFilter: { value: 'bms_spa' } } },
        ]}
      },
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: 100,
    },

    // ── Restaurant ────────────────────────────────────────────────────
    restaurant: {
      dateRanges: dateRange,
      dimensions: clickDims,
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: clickFilter('restaurant', null),
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: 100,
    },

    // ── Taxi ──────────────────────────────────────────────────────────
    taxi: {
      dateRanges: dateRange,
      dimensions: [
        { name: 'eventName' },
        { name: 'customEvent:label' },
        { name: 'customEvent:value' },
        { name: 'customEvent:vehicle' },
        { name: 'customEvent:step' },
      ],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        orGroup: { expressions: [
          { filter: { fieldName: 'customEvent:source_module', stringFilter: { value: 'taxi' } } },
          { filter: { fieldName: 'eventName', stringFilter: { value: 'taxi_time_selected' } } },
          { filter: { fieldName: 'eventName', stringFilter: { value: 'taxi_vehicle_selected' } } },
        ]}
      },
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: 100,
    },

    // ── Housekeeping ──────────────────────────────────────────────────
    housekeeping: {
      dateRanges: dateRange,
      dimensions: [
        { name: 'eventName' },
        { name: 'customEvent:label' },
        { name: 'customEvent:value' },
        { name: 'customEvent:total' },
      ],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        orGroup: { expressions: [
          { filter: { fieldName: 'customEvent:source_module', stringFilter: { value: 'housekeeping' } } },
          { filter: { fieldName: 'customEvent:source_module', stringFilter: { value: 'laundry' } } },
        ]}
      },
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: 100,
    },

    // ── Store ─────────────────────────────────────────────────────────
    store: {
      dateRanges: dateRange,
      dimensions: [
        { name: 'eventName' },
        { name: 'customEvent:label' },
        { name: 'customEvent:value' },
        { name: 'customEvent:total' },
        { name: 'customEvent:category' },
      ],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        orGroup: { expressions: [
          { filter: { fieldName: 'customEvent:source_module', stringFilter: { value: 'store' } } },
          { filter: { fieldName: 'eventName', stringFilter: { value: 'store_item_added_to_cart' } } },
        ]}
      },
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: 100,
    },

    // ── Chat ──────────────────────────────────────────────────────────
    chat: {
      dateRanges: dateRange,
      dimensions: [
        { name: 'customEvent:label' },
        { name: 'customEvent:value' },
        { name: 'customEvent:index' },
      ],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        andGroup: { expressions: [
          { filter: { fieldName: 'eventName', stringFilter: { value: 'click_event' } } },
          { filter: { fieldName: 'customEvent:source_screen', stringFilter: { value: 'chat' } } },
        ]}
      },
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: 100,
    },

    // ── Recommendations ───────────────────────────────────────────────
    recommendations: {
      dateRanges: dateRange,
      dimensions: [
        { name: 'eventName' },
        { name: 'customEvent:label' },
        { name: 'customEvent:value' },
        { name: 'customEvent:source_module' },
      ],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        orGroup: { expressions: [
          { filter: { fieldName: 'eventName', stringFilter: { value: 'recommendation_impression' } } },
          { filter: { fieldName: 'eventName', stringFilter: { value: 'recommendation_added_to_cart' } } },
          { andGroup: { expressions: [
            { filter: { fieldName: 'eventName', stringFilter: { value: 'click_event' } } },
            { filter: { fieldName: 'customEvent:label', stringFilter: { value: 'add_suggested_item' } } },
          ]}},
        ]}
      },
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: 200,
    },

    // ── Spotlight taps ────────────────────────────────────────────────
    spotlight: {
      dateRanges: dateRange,
      dimensions: [
        { name: 'customEvent:label' },
        { name: 'customEvent:value' },
        { name: 'customEvent:index' },
      ],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        andGroup: { expressions: [
          { filter: { fieldName: 'eventName', stringFilter: { value: 'click_event' } } },
          { filter: { fieldName: 'customEvent:label', stringFilter: { matchType: 'BEGINS_WITH', value: 'spotlight' } } },
        ]}
      },
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: 100,
    },

    // ── Daily trend ───────────────────────────────────────────────────
    daily_trend: {
      dateRanges: dateRange,
      dimensions: [{ name: 'date' }, { name: 'eventName' }],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        orGroup: { expressions: [
          { filter: { fieldName: 'eventName', stringFilter: { value: 'booking_start' } } },
          { filter: { fieldName: 'eventName', stringFilter: { value: 'booking_complete' } } },
          { filter: { fieldName: 'eventName', stringFilter: { value: 'click_event' } } },
        ]}
      },
      orderBys: [{ dimension: { dimensionName: 'date' } }],
      limit: 500,
    },
  };

  if (!reports[report]) throw new Error(`Unknown report: ${report}`);
  return reports[report];
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  try {
    const keyRaw = process.env.GA4_SERVICE_ACCOUNT_KEY;
    if (!keyRaw) throw new Error('GA4_SERVICE_ACCOUNT_KEY env var not set');
    const serviceAccount = JSON.parse(keyRaw);
    const { report = 'screen_views', startDate = '30daysAgo', endDate = 'today' } = event.queryStringParameters || {};
    const token = await getAccessToken(serviceAccount);
    const body = buildReportBody(report, startDate, endDate);
    const data = await runReport(token, body);
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  } catch (err) {
    console.error('GA4 function error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
