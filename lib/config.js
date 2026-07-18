// Open this URL to decide login state: login page => not logged in, otherwise logged in.
export const LOGIN_CHECK_URL =
  'https://www.ebay.com/mye/myebay/purchase?page=1&moduleId=77827&mp=purchase-module-v2&type=v2&pg=purchase';

export const ORDER_URLS = {
  all: LOGIN_CHECK_URL,
  payment_failed:
    'https://www.ebay.com/mye/myebay/purchase?page=1&moduleId=122170&mp=purchase-module-v2&type=v2&pg=purchase',
  returns_and_canceled:
    'https://www.ebay.com/mye/myebay/purchase?page=1&moduleId=122166&mp=purchase-module-v2&type=v2&pg=purchase',
  shipped:
    'https://www.ebay.com/mye/myebay/purchase?page=1&moduleId=122169&mp=purchase-module-v2&type=v2&pg=purchase',
};
