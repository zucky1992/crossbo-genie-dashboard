/**
 * Netlify Function: ga4.js v4
 * Adds: server-side 5-min cache, 429 retry, excludeTest filter (default off).
 */

const GA4_PROPERTY_ID = '503373961';
const GA4_API_BASE = 'https://analyticsdata.googleapis.com/v1beta';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';

// In-memory cache — persists across warm Netlify function invocations
const _cache = {};
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

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

async function runReport(token, body, retries = 1) {
  const res = await fetch(`${GA4_API_BASE}/properties/${GA4_PROPERTY_ID}:runReport`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 429 && retries > 0) {
    await new Promise(r => setTimeout(r, 2000));
    return runReport(token, body, retries - 1);
  }
  if (!res.ok) { const err = await res.text(); throw new Error(`GA4 API error (${res.status}): ${err}`); }
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

    // ── Booking abandoned enriched — what items get abandoned ─────────
    abandon_detail: {
      dateRanges: dateRange,
      dimensions: [
        { name: 'customEvent:source_module' },
        { name: 'customEvent:category' },
        { name: 'customEvent:service' },
        { name: 'customEvent:step' },
        { name: 'customEvent:total' },
      ],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        filter: { fieldName: 'eventName', stringFilter: { value: 'booking_abandoned' } }
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

    // ── Recommendations — impression + tap + add ──────────────────────
    recommendations: {
      dateRanges: dateRange,
      dimensions: [
        { name: 'eventName' },
        { name: 'customEvent:source_module' },
        { name: 'customEvent:value' },
        { name: 'customEvent:label' },
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

    // ── Notifications funnel ──────────────────────────────────────────
    notifications: {
      dateRanges: dateRange,
      dimensions: [{ name: 'eventName' }],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        orGroup: { expressions: [
          { filter: { fieldName: 'eventName', stringFilter: { value: 'notification_receive' } } },
          { filter: { fieldName: 'eventName', stringFilter: { value: 'notification_open' } } },
          { filter: { fieldName: 'eventName', stringFilter: { value: 'notification_dismiss' } } },
          { filter: { fieldName: 'eventName', stringFilter: { value: 'notification_foreground' } } },
        ]}
      },
      limit: 20,
    },

    // ── App health ────────────────────────────────────────────────────
    app_health: {
      dateRanges: dateRange,
      dimensions: [
        { name: 'eventName' },
        { name: 'customUser:property' },
      ],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        orGroup: { expressions: [
          { filter: { fieldName: 'eventName', stringFilter: { value: 'app_exception' } } },
          { filter: { fieldName: 'eventName', stringFilter: { value: 'app_remove' } } },
          { filter: { fieldName: 'eventName', stringFilter: { value: 'first_open' } } },
          { filter: { fieldName: 'eventName', stringFilter: { value: 'app_update' } } },
          { filter: { fieldName: 'eventName', stringFilter: { value: 'app_session_start' } } },
          { filter: { fieldName: 'eventName', stringFilter: { value: 'sustainability_tray_opened' } } },
          { filter: { fieldName: 'eventName', stringFilter: { value: 'sustainability_action_completed' } } },
        ]}
      },
      limit: 20,
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

    // ── Portfolio metrics — total sessions, users, engagement ──────────
    // Powers the Portfolio Health section at top of App Analytics.
    // Note: screenPageViewsPerSession is a GA4 built-in derived metric.
    // If screen_view events don't fire in the app, this returns 0.
    portfolio_metrics: {
      dateRanges: dateRange,
      dimensions: [],
      metrics: [
        { name: 'sessions' },
        { name: 'totalUsers' },
        { name: 'activeUsers' },
        { name: 'engagedSessions' },
        { name: 'screenPageViews' },
        { name: 'screenPageViewsPerSession' },
      ],
      limit: 1,
    },

    // ── Sessions by hotel — property-scoped custom dimension ───────────
    // property = hotel name (registered dimension). Sorted by session count desc.
    sessions_by_hotel: {
      dateRanges: dateRange,
      dimensions: [{ name: 'customUser:property' }],
      metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: 20,
    },

    // ── Booking funnel by hotel — for Hotel Comparison matrix ──────────
    // Same events as booking_funnel but grouped by hotel (property) AND dept
    // (source_module). Matrix aggregates by hotel; drilldown filters by hotel
    // and groups by dept. No extra API call needed.
    booking_funnel_by_hotel: {
      dateRanges: dateRange,
      dimensions: [
        { name: 'eventName' },
        { name: 'customUser:property' },
        { name: 'customEvent:source_module' },
      ],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        orGroup: { expressions: [
          { filter: { fieldName: 'eventName', stringFilter: { value: 'booking_start' } } },
          { filter: { fieldName: 'eventName', stringFilter: { value: 'booking_complete' } } },
          { filter: { fieldName: 'eventName', stringFilter: { value: 'booking_abandoned' } } },
        ]}
      },
      limit: 1000,
    },

    // ── Department entry source — where guests enter each dept from ────
    // source_screen tells us: home widget, nav bar, deep link, etc.
    // If source_screen is (not set), it's an instrumentation gap.
    dept_entry_source: {
      dateRanges: dateRange,
      dimensions: [
        { name: 'customEvent:source_module' },
        { name: 'customEvent:source_screen' },
      ],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        filter: { fieldName: 'eventName', stringFilter: { value: 'booking_start' } }
      },
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: 200,
    },
    // ── Daily sparkline metrics — session-level daily time series ──────
    // Powers sparkline charts on hero KPI tiles. Returns one row per day
    // with sessions, users, engaged sessions, and screen views. Rendered
    // client-side as small line charts inside each KPI tile.
    daily_sparkline: {
      dateRanges: dateRange,
      dimensions: [{ name: 'date' }],
      metrics: [
        { name: 'sessions' },
        { name: 'totalUsers' },
        { name: 'engagedSessions' },
      ],
      orderBys: [{ dimension: { dimensionName: 'date' } }],
      limit: 200,
    },

    // ── Daily booking sparkline — event-based daily time series ────────
    // For starts / completes / abandons / crashes sparklines.
    daily_events_sparkline: {
      dateRanges: dateRange,
      dimensions: [{ name: 'date' }, { name: 'eventName' }],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        orGroup: { expressions: [
          { filter: { fieldName: 'eventName', stringFilter: { value: 'booking_start' } } },
          { filter: { fieldName: 'eventName', stringFilter: { value: 'booking_complete' } } },
          { filter: { fieldName: 'eventName', stringFilter: { value: 'booking_abandoned' } } },
          { filter: { fieldName: 'eventName', stringFilter: { value: 'app_exception' } } },
        ]}
      },
      orderBys: [{ dimension: { dimensionName: 'date' } }],
      limit: 800,
    },
  };

  if (!reports[report]) throw new Error(`Unknown report: ${report}`);
  return reports[report];
}

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    const keyRaw = process.env.GA4_SERVICE_ACCOUNT_KEY;
    if (!keyRaw) throw new Error('GA4_SERVICE_ACCOUNT_KEY env var not set');
    const serviceAccount = JSON.parse(keyRaw);
    const { report = 'screen_views', startDate = '30daysAgo', endDate = 'today', prevStartDate, prevEndDate, hotelId, excludeTest = 'false', multi } = req.query || {};

    // Shared filter application
    function applyFilters(body) {
      if (hotelId) {
        const hf = { filter: { fieldName: 'customEvent:hotel_id', stringFilter: { value: hotelId } } };
        body.dimensionFilter = body.dimensionFilter ? { andGroup: { expressions: [body.dimensionFilter, hf] } } : hf;
      }
      if (excludeTest === 'true') {
        const ef = { notExpression: { filter: { fieldName: 'customUser:environment', stringFilter: { value: 'development' } } } };
        body.dimensionFilter = body.dimensionFilter ? { andGroup: { expressions: [body.dimensionFilter, ef] } } : ef;
      }
      return body;
    }

    // ── MULTI MODE: fetch several reports SEQUENTIALLY in one call ──
    // Sequential = max 1 concurrent GA4 request per invocation, avoiding the
    // 10-concurrent-request limit that causes 429s on parallel bursts.
    //
    // v48: When prevStartDate + prevEndDate are provided, also fetch the same
    // report set for the previous window and return under `previous` key.
    // Used for delta arrows on hero KPIs. Doubles GA4 calls when active but
    // is still bounded to sequential execution.
    if (multi) {
      const names = multi.split(',').map(s => s.trim()).filter(Boolean);
      const wantPrev = prevStartDate && prevEndDate;
      const cacheKey = `multi:${names.join(',')}:${startDate}:${endDate}:${wantPrev?prevStartDate+':'+prevEndDate:''}:${hotelId||''}:${excludeTest}`;
      if (_cache[cacheKey] && Date.now() - _cache[cacheKey].ts < CACHE_TTL) {
        res.status(200).json(_cache[cacheKey].data); return;
      }

      const token = await getAccessToken(serviceAccount);
      const current = {};
      const previous = {};
      // Fetch current-window reports first (sequential)
      for (const name of names) {
        try {
          const body = applyFilters(buildReportBody(name, startDate, endDate));
          current[name] = await runReport(token, body, 0);
        } catch (e) {
          current[name] = { error: e.message, rows: [] };
        }
      }
      // Then previous-window reports if requested
      if (wantPrev) {
        for (const name of names) {
          try {
            const body = applyFilters(buildReportBody(name, prevStartDate, prevEndDate));
            previous[name] = await runReport(token, body, 0);
          } catch (e) {
            previous[name] = { error: e.message, rows: [] };
          }
        }
      }
      // Backwards compatibility: if no prev requested, return flat shape.
      // If prev requested, wrap under {current, previous}.
      const result = wantPrev ? { current, previous } : current;
      _cache[cacheKey] = { data: result, ts: Date.now() };
      res.status(200).json(result); return;
    }

    // ── SINGLE REPORT MODE ──
    const cacheKey = `${report}:${startDate}:${endDate}:${hotelId||''}:${excludeTest}`;
    if (_cache[cacheKey] && Date.now() - _cache[cacheKey].ts < CACHE_TTL) {
      res.status(200).json(_cache[cacheKey].data); return;
    }

    const token = await getAccessToken(serviceAccount);
    let body = applyFilters(buildReportBody(report, startDate, endDate));

    const data = await runReport(token, body);
    _cache[cacheKey] = { data, ts: Date.now() };
    res.status(200).json(data);
  } catch (err) {
    console.error('GA4 function error:', err);
    res.status(500).json({ error: err.message });
  }
};
