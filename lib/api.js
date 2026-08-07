const ENDPOINT = 'https://fulfill.everymarket.com';
const LOG_ENDPOINT = 'https://logging.everymarket.com/api/v1/logs';
const LOG_API_TOKEN =
  '7dfbd1c8a4e2453d9b2b569f37ce8b1c3c09e89157b7268cc60b6a4e35a68c51';

function maskTokenInUrl(url) {
  try {
    const u = new URL(url);
    if (u.searchParams.has('token')) {
      u.searchParams.set('token', '***');
    }
    return u.toString();
  } catch (_) {
    return String(url).replace(/([?&]token=)[^&]*/gi, '$1***');
  }
}

async function sendRemoteLog(log) {
  try {
    await fetch(LOG_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Log-Source': 'frontend',
        Authorization: `Bearer ${LOG_API_TOKEN}`,
      },
      body: JSON.stringify({
        ...log,
        logged_at: new Date().toISOString(),
      }),
    });
  } catch (err) {
    console.warn('[eBay Tracking Collector] sendRemoteLog failed', err);
  }
}

export class EbayOrderService {
  constructor(token) {
    this.token = token;
  }

  async getOrders(account, filters = 'no_tracking', startDate = null, endDate = null) {
    const url = new URL(`${ENDPOINT}/api/v2/ebay_orders`);
    url.searchParams.set('token', this.token);
    url.searchParams.set('email', account);
    url.searchParams.set('filter', filters);
    if (startDate) url.searchParams.set('start_date', startDate);
    if (endDate) url.searchParams.set('end_date', endDate);

    const request = {
      method: 'GET',
      url: maskTokenInUrl(url.toString()),
      params: { email: account, filter: filters, startDate, endDate },
    };
    console.log('[eBay Tracking Collector] API getOrders request', request);

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch (_) {
      body = text;
    }

    console.log('[eBay Tracking Collector] API getOrders response', {
      status: response.status,
      ok: response.ok,
      body,
    });

    if (!response.ok) {
      throw new Error(`getOrders failed: ${response.status}`);
    }

    // Merge explicit collection requests (server also merges into no_tracking).
    try {
      const requested = await this.getPendingCollectionOrders(account);
      if (requested?.length) {
        const byNumber = new Map(
          (Array.isArray(body) ? body : []).map((order) => [order.order_number, order]),
        );
        for (const req of requested) {
          const orderNumber = req.order_number || req.buy_order_number;
          if (!orderNumber || byNumber.has(orderNumber)) continue;
          byNumber.set(orderNumber, {
            order_number: orderNumber,
            buyer_email: req.buy_account || account,
            status: 'Collection requested',
            tracking: null,
          });
        }
        body = Array.from(byNumber.values());
      }
    } catch (err) {
      console.warn('[eBay Tracking Collector] getPendingCollectionOrders failed', err);
    }

    return body;
  }

  async getPendingCollectionOrders(account) {
    const url = new URL(`${ENDPOINT}/api/v2/order_collection_requests`);
    url.searchParams.set('token', this.token);
    url.searchParams.set('account', account);
    url.searchParams.set('marketplace', 'ebay');
    url.searchParams.set('status', 'pending');

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`getPendingCollectionOrders failed: ${response.status}`);
    }
    const body = await response.json();
    return Array.isArray(body) ? body : [];
  }

  async saveOrders(orders) {
    const url = `${ENDPOINT}/api/v2/ebay_orders/batch_create?token=${encodeURIComponent(this.token)}`;
    const payload = { ebay_orders: orders };
    const orderCount = orders?.length || 0;

    console.log('[eBay Tracking Collector] API saveOrders request', {
      method: 'POST',
      url: maskTokenInUrl(url),
      count: orderCount,
      payload,
    });

    let ok = false;
    let body = null;
    let status = 0;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      status = response.status;
      const text = await response.text();
      try {
        body = text ? JSON.parse(text) : null;
      } catch (_) {
        body = text;
      }
      ok = response.ok;

      console.log('[eBay Tracking Collector] API saveOrders response', {
        status: response.status,
        ok: response.ok,
        body,
      });
    } catch (err) {
      console.error('[eBay Tracking Collector] saveOrders network error', err);
      await sendRemoteLog({
        source: 'ebay-order',
        level: 'error',
        message: 'Sync failed',
        metadata: {
          order_count: orderCount,
          result: { ok: false, error: String(err?.message || err) },
        },
      });
      throw err;
    }

    await sendRemoteLog({
      source: 'ebay-order',
      level: ok ? 'info' : 'error',
      message: ok ? 'Synced orders' : 'Sync failed',
      metadata: {
        order_count: orderCount,
        result: ok
          ? { ok: true, data: body }
          : { ok: false, status, error: `HTTP ${status}` },
      },
    });

    if (!ok) {
      throw new Error(`saveOrders failed: ${status}`);
    }
    return body;
  }

  async sendClickLog(email) {
    if (!email) return;
    try {
      const url = `${ENDPOINT}/api/v2/plugin_click_logs?token=${encodeURIComponent(this.token)}`;
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
    } catch (err) {
      console.warn('[eBay Tracking Collector] sendClickLog failed', err);
    }
  }
}
