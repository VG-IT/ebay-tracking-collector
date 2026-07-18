const ENDPOINT = 'https://fulfill.everymarket.com';

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
    return body;
  }

  async saveOrders(orders) {
    const url = `${ENDPOINT}/api/v2/ebay_orders/batch_create?token=${encodeURIComponent(this.token)}`;
    const payload = { ebay_orders: orders };

    console.log('[eBay Tracking Collector] API saveOrders request', {
      method: 'POST',
      url: maskTokenInUrl(url),
      count: orders?.length || 0,
      payload,
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch (_) {
      body = text;
    }

    console.log('[eBay Tracking Collector] API saveOrders response', {
      status: response.status,
      ok: response.ok,
      body,
    });

    if (!response.ok) {
      throw new Error(`saveOrders failed: ${response.status}`);
    }
    return body;
  }
}
