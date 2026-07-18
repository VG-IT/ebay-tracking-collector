(() => {
  if (window.__ebayTrackingCollectorLoaded) return;
  window.__ebayTrackingCollectorLoaded = true;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function text(el) {
    return (el?.textContent || '').trim();
  }

  function formatPurchaseDate(purchaseDate) {
    if (!purchaseDate) return null;
    const purchaseDateS = purchaseDate.includes('at')
      ? purchaseDate.split('at')[0].trim()
      : purchaseDate.trim();
    const parsed = new Date(purchaseDateS);
    if (Number.isNaN(parsed.getTime())) return null;
    const y = parsed.getFullYear();
    const m = String(parsed.getMonth() + 1).padStart(2, '0');
    const d = String(parsed.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function parseOrderTotal(raw) {
    if (!raw) return null;
    const match = String(raw).match(/\d+\.\d+/);
    return match ? Math.round(parseFloat(match[0]) * 100) / 100 : null;
  }

  function getOrderCards() {
    const scoped = document.querySelectorAll(
      "div.m-river__body div[name='ITEM_CONTAINER'] div.m-ph-card.m-order-card, div.m-river__body div[name='ITEM_CONTAINER'] div.m-order-card"
    );
    if (scoped.length) return Array.from(scoped);
    return Array.from(document.querySelectorAll('div.purchase div.m-order-card, div.m-ph-card.m-order-card, div.m-order-card'));
  }

  function getOrderFromCard(card) {
    const listId =
      card.querySelector('[input-listing-id]')?.getAttribute('input-listing-id') ||
      card.querySelector('.m-container-item-layout-row__body')?.getAttribute('input-listing-id') ||
      null;

    const notice = card.querySelector('span.section-notice__main') || card;
    const status = text(notice.querySelector('span[class*="primaryMessage"]'));

    const secondary = notice.querySelector('span[class*="secondaryMessage"]');
    let purchaseDate = null;
    let orderTotal = null;
    let orderNumber = null;

    if (secondary) {
      const groups = secondary.querySelectorAll(':scope > span');
      if (groups.length >= 1) {
        const dateSpans = groups[0].querySelectorAll(':scope > span');
        purchaseDate = formatPurchaseDate(text(dateSpans[1] || dateSpans[0]));
      }
      if (groups.length >= 2) {
        const totalSpans = groups[1].querySelectorAll(':scope > span');
        orderTotal = parseOrderTotal(text(totalSpans[1] || totalSpans[0]));
      }
      if (groups.length >= 3) {
        const numSpans = groups[2].querySelectorAll(':scope > span');
        orderNumber = text(numSpans[1] || numSpans[0]);
      }
    }

    if (!orderNumber) {
      const fallback = text(
        card.querySelector('span[class*="secondaryMessage"] > span:nth-of-type(3) > span:nth-of-type(2)')
      );
      orderNumber = fallback || null;
    }

    return {
      status: status || null,
      purchase_date: purchaseDate,
      order_total: orderTotal,
      order_number: orderNumber,
      pid: listId,
    };
  }

  function scrapeOrders(buyerEmail) {
    const orders = [];
    for (const card of getOrderCards()) {
      const order = getOrderFromCard(card);
      if (!order.order_number) continue;
      order.buyer_email = buyerEmail;
      orders.push(order);
    }
    console.log('[eBay Tracking Collector] scrapeOrders', {
      href: location.href,
      count: orders.length,
      orders,
    });
    return orders;
  }

  async function goNextPage() {
    const nextBtn = document.querySelector('button.pagination__next');
    if (!nextBtn || nextBtn.disabled || nextBtn.getAttribute('aria-disabled') === 'true') {
      return { hasNext: false };
    }
    const before = location.href;
    nextBtn.click();
    await sleep(3000);
    await waitForBody();
    return { hasNext: true, urlChanged: location.href !== before, url: location.href };
  }

  function waitForBody(timeout = 12000) {
    return new Promise((resolve, reject) => {
      if (document.body) return resolve(true);
      const started = Date.now();
      const timer = setInterval(() => {
        if (document.body) {
          clearInterval(timer);
          resolve(true);
        } else if (Date.now() - started > timeout) {
          clearInterval(timer);
          reject(new Error('body timeout'));
        }
      }, 100);
    });
  }

  function isLoginPage() {
    const href = location.href || '';
    const path = location.pathname || '';

    if (/signin\.ebay\.com/i.test(href)) return true;
    if (/\/signin/i.test(path)) return true;
    if (/cgi2?\.ebay\.com\/.*SignIn/i.test(href)) return true;

    const loginForm = document.querySelector(
      '#userid, #pass, #signin-continue-btn, #sgnBt, form#SignInForm, form[name="SignInForm"], input[name="userid"], input[name="pass"]'
    );
    if (loginForm) return true;

    const ug = document.querySelector('#gh-ug, .gh-identity, button[class*="gh-identity"]');
    if (ug && /sign\s*in/i.test(text(ug))) return true;

    return false;
  }

  function isLoggedIn() {
    return !isLoginPage();
  }

  function checkLimitExceeded() {
    const textContent = document.body?.innerText || '';
    return textContent.includes('exceeded the number of requests allowed in one day');
  }

  function xpathFirst(xpath, root = document) {
    const result = document.evaluate(xpath, root, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    return result.singleNodeValue;
  }

  function xpathText(xpath, root = document) {
    const node = xpathFirst(xpath, root);
    if (!node) return '';
    return (node.textContent || node.nodeValue || '').trim();
  }

  function scrapeOrderDetail() {
    if (checkLimitExceeded()) {
      console.warn('[eBay Tracking Collector] scrapeOrderDetail limit exceeded', {
        href: location.href,
      });
      return { limitExceeded: true };
    }

    const trackingDd = xpathFirst(
      "//div[@class='inner-tracking-box']//span[text()='Number']/ancestor::dt[1]/following-sibling::dd[1]"
    );
    const tracking = text(trackingDd) || null;

    const carrierDd = xpathFirst(
      "//span[text()='Carrier']/ancestor::dt[1]/following-sibling::dd[1]"
    );
    const carrier = text(carrierDd) || null;

    const addressNodes = document.evaluate(
      "//div[contains(@class, 'delivery-address-text')]//text()",
      document,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null
    );
    const addressParts = [];
    for (let i = 0; i < addressNodes.snapshotLength; i++) {
      const part = text(addressNodes.snapshotItem(i));
      if (part) addressParts.push(part);
    }
    const address = addressParts.join(' ') || null;

    let creditCardLastDigits = null;
    const cc = xpathText("//div[contains(@class, 'payment-instrument-description')]//span[@class='clipped']");
    if (cc) creditCardLastDigits = cc.split(' ').pop();

    let deliveredDate = null;
    const lastStep = xpathFirst("//div[@class='delivery-stepper']//div[@class='progress-stepper__items']/div[last()]");
    if (lastStep && /COMPLETED/i.test(lastStep.className || '')) {
      const deliveryMessage = text(
        lastStep.querySelector('.progress-stepper__text h4 .textual-display, .progress-stepper__text h4')
      );
      if (/delivered/i.test(deliveryMessage || '')) {
        deliveredDate = text(lastStep.querySelector('.progress-stepper__text > span.textual-display'));
      }
    }

    let purchaseDate = null;
    const purchaseRaw = xpathText("//div[@class='order-box']//div[contains(@class, 'order-info')]/div[2]//dd[1]");
    if (purchaseRaw) purchaseDate = formatPurchaseDate(purchaseRaw);

    const detail = {
      limitExceeded: false,
      tracking: tracking || null,
      carrier: carrier || null,
      address,
      credit_card_last_digits: creditCardLastDigits,
      purchase_date: purchaseDate,
      delivered_date: deliveredDate || null,
    };
    console.log('[eBay Tracking Collector] scrapeOrderDetail', {
      href: location.href,
      detail,
    });
    return detail;
  }

  async function closeLightbox() {
    for (let i = 0; i < 5; i++) {
      const buttons = document.querySelectorAll('button.lightbox-dialog__close');
      if (!buttons.length) return true;
      for (const button of buttons) {
        try {
          button.click();
        } catch (_) {
          /* ignore */
        }
      }
      await sleep(400);
      if (!document.querySelector('h2.lightbox-dialog__title')) return true;
    }
    return !document.querySelector('h2.lightbox-dialog__title');
  }

  async function waitForSelector(selector, timeout = 12000, root = document) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const el = root.querySelector(selector);
      if (el) return el;
      await sleep(200);
    }
    return null;
  }

  async function waitForIframeDocument(iframeEl, timeout = 12000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      try {
        const doc = iframeEl.contentDocument || iframeEl.contentWindow?.document;
        if (doc?.body && doc.readyState === 'complete') {
          // Also wait until body has meaningful content
          if ((doc.body.innerText || '').trim().length > 0 || doc.body.children.length > 0) {
            return doc;
          }
        }
      } catch (_) {
        /* cross-origin */
        return null;
      }
      await sleep(250);
    }
    try {
      return iframeEl.contentDocument || iframeEl.contentWindow?.document || null;
    } catch (_) {
      return null;
    }
  }

  async function waitForTrackingHistory(iframeDoc, timeout = 15000) {
    const historySelector =
      'div#tracking-package div.shipment-package-grey-container ol[class*="track-package-event-history"] > li';
    const toggleSelector =
      'div#tracking-package button.shipment-package-grey-flex-container-button div.tracking-status-icon-container';
    const packageSelector = 'div#tracking-package';

    // Wait for tracking package container first
    const pkg = await waitForSelector(packageSelector, Math.min(timeout, 10000), iframeDoc);
    if (!pkg) return null;

    let historyLi = await waitForSelector(historySelector, 7000, iframeDoc);
    if (historyLi) return historyLi;

    const toggle = await waitForSelector(toggleSelector, 3000, iframeDoc);
    if (toggle) {
      toggle.click();
      historyLi = await waitForSelector(historySelector, 7000, iframeDoc);
      if (historyLi) return historyLi;
    }

    // Last resort: poll a bit longer for late-rendered history
    const started = Date.now();
    while (Date.now() - started < 5000) {
      historyLi = iframeDoc.querySelector(historySelector);
      if (historyLi) return historyLi;
      const lateToggle = iframeDoc.querySelector(toggleSelector);
      if (lateToggle) {
        lateToggle.click();
        await sleep(500);
      }
      await sleep(300);
    }
    return null;
  }

  async function waitForTrackingText(historyLi, timeout = 5000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const link = historyLi.querySelector('a');
      const spans = historyLi.querySelectorAll('span');
      const candidate = text(link) || text(spans[1]) || text(spans[0]);
      if (candidate) return true;
      await sleep(200);
    }
    return false;
  }

  async function getTrackingFromOverlay(orderCard) {
    const trackBtn =
      orderCard.querySelector(
        'div[class*="m-item-card"] div[class*="container-item-col-cta__item"] > div.m-cta > a'
      ) || Array.from(orderCard.querySelectorAll('a')).find((a) => /track/i.test(a.textContent || ''));

    if (!trackBtn) return { noTrackButton: true };

    const trackText = text(trackBtn);
    if (!/track/i.test(trackText)) {
      return { needsOrderPage: true };
    }

    trackBtn.click();

    const title = await waitForSelector('h2.lightbox-dialog__title', 12000);
    if (!title) return { overlayFailed: true };

    const iframeEl = await waitForSelector('iframe#tracking-overlay-iframe', 10000);
    if (!iframeEl) {
      await closeLightbox();
      return { overlayFailed: true };
    }

    // Wait for iframe load event if still loading
    if (!iframeEl.contentDocument || iframeEl.contentDocument.readyState !== 'complete') {
      await Promise.race([
        new Promise((resolve) => {
          iframeEl.addEventListener('load', resolve, { once: true });
        }),
        sleep(8000),
      ]);
    }

    const iframeDoc = await waitForIframeDocument(iframeEl, 12000);
    if (!iframeDoc) {
      await closeLightbox();
      return { overlayFailed: true, crossOrigin: true };
    }

    // Give SPA content inside iframe a moment after document ready
    await sleep(800);

    const historyLi = await waitForTrackingHistory(iframeDoc, 15000);
    if (!historyLi) {
      console.warn('[eBay Tracking Collector] tracking history not loaded in overlay');
      await closeLightbox();
      return { noTracking: true };
    }

    await waitForTrackingText(historyLi, 5000);

    let tracking = null;
    let carrier = null;
    const link = historyLi.querySelector('a');
    if (link) {
      tracking = text(link);
      carrier = text(historyLi.querySelector('span'));
    } else {
      const spans = historyLi.querySelectorAll('span');
      if (spans.length >= 2) {
        carrier = text(spans[0]);
        tracking = text(spans[1]);
      } else if (spans.length === 1) {
        tracking = text(spans[0]);
      }
    }

    if (carrier) carrier = carrier.replace(':', '').trim();
    if (tracking) tracking = tracking.trim();

    console.log('[eBay Tracking Collector] overlay content ready', { tracking, carrier });

    await closeLightbox();
    await sleep(500);

    if (!tracking) return { noTracking: true };
    return { tracking, carrier };
  }

  async function findSearchInput() {
    const selectors = [
      'input[placeholder*="Search your purchases" i]',
      'input[aria-label*="Search your purchases" i]',
      'input[placeholder*="Search" i][type="search"]',
      'input[type="search"]',
      'input[name="search"]',
      'input[id*="search" i]',
      'input[aria-label*="Search" i]',
      'input[placeholder*="Search" i]',
    ];
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el && el.offsetParent !== null) return el;
    }
    return document.querySelector(selectors.join(', '));
  }

  function setInputValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function searchByOrderNumber(orderNumber) {
    const input = await findSearchInput();
    if (!input) {
      console.warn('[eBay Tracking Collector] search input not found');
      return { searched: false, reason: 'no_search_input', trackings: [], needsOrderPage: [orderNumber] };
    }

    input.focus();
    setInputValue(input, orderNumber);
    await sleep(300);

    const form = input.closest('form');
    const searchBtn =
      form?.querySelector('button[type="submit"], button[aria-label*="Search" i], button[title*="Search" i]') ||
      document.querySelector('button[aria-label*="Search" i], button[title*="Search purchases" i]');

    if (searchBtn) {
      searchBtn.click();
    } else {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })
      );
      input.dispatchEvent(
        new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })
      );
      if (form) form.requestSubmit?.() || form.submit?.();
    }

    await sleep(3500);
    await waitForBody();

    const pageOrders = pageOrderNumbers();
    console.log('[eBay Tracking Collector] searchByOrderNumber result page', {
      orderNumber,
      href: location.href,
      pageOrders,
    });

    const scraped = await scrapeTrackingsOnPage([orderNumber]);
    return {
      searched: true,
      orderNumber,
      pageOrders,
      ...scraped,
    };
  }

  async function scrapeTrackingsOnPage(orderNumbers) {
    const wanted = new Set(orderNumbers);
    const results = [];
    const needsOrderPage = [];

    for (const card of getOrderCards()) {
      const order = getOrderFromCard(card);
      const orderNumber = order.order_number;
      if (!orderNumber || !wanted.has(orderNumber)) continue;

      try {
        const extracted = await getTrackingFromOverlay(card);
        console.log('[eBay Tracking Collector] overlay tracking', {
          order_number: orderNumber,
          extracted,
        });
        if (extracted.needsOrderPage || extracted.noTrackButton) {
          needsOrderPage.push(orderNumber);
          continue;
        }
        if (extracted.tracking) {
          results.push({
            order_number: orderNumber,
            tracking: extracted.tracking,
            carrier: extracted.carrier || undefined,
          });
        }
      } catch (err) {
        console.warn('[eBay Tracking Collector] overlay tracking failed', {
          order_number: orderNumber,
          error: String(err?.message || err),
        });
        needsOrderPage.push(orderNumber);
      }
      await sleep(800);
    }

    const payload = { trackings: results, needsOrderPage };
    console.log('[eBay Tracking Collector] scrapeTrackingsOnPage', {
      href: location.href,
      wanted: orderNumbers.length,
      ...payload,
    });
    return payload;
  }

  function pageOrderNumbers() {
    return getOrderCards()
      .map((card) => getOrderFromCard(card).order_number)
      .filter(Boolean);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    (async () => {
      try {
        switch (message?.action) {
          case 'ping':
            sendResponse({ ok: true, href: location.href });
            break;
          case 'isLoggedIn':
            sendResponse({ ok: true, loggedIn: isLoggedIn() });
            break;
          case 'isLoginPage':
            sendResponse({ ok: true, isLoginPage: isLoginPage(), href: location.href });
            break;
          case 'scrapeOrders':
            await waitForBody();
            sendResponse({ ok: true, orders: scrapeOrders(message.buyerEmail) });
            break;
          case 'goNextPage':
            sendResponse({ ok: true, ...(await goNextPage()) });
            break;
          case 'scrapeTrackings':
            await waitForBody();
            sendResponse({
              ok: true,
              ...(await scrapeTrackingsOnPage(message.orderNumbers || [])),
              pageOrders: pageOrderNumbers(),
            });
            break;
          case 'searchByOrderNumber':
            await waitForBody();
            sendResponse({
              ok: true,
              ...(await searchByOrderNumber(message.orderNumber)),
            });
            break;
          case 'scrapeOrderDetail':
            await waitForBody();
            sendResponse({ ok: true, ...(scrapeOrderDetail()) });
            break;
          case 'checkLimitExceeded':
            sendResponse({ ok: true, limitExceeded: checkLimitExceeded() });
            break;
          default:
            sendResponse({ ok: false, error: `Unknown action: ${message?.action}` });
        }
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  });
})();
