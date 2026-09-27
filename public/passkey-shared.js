/**
 * Shared helpers for the passkey (WebAuthn) pages. Loaded after
 * /vendor/simplewebauthn-browser.js, which defines window.SimpleWebAuthnBrowser.
 */
window.BCUKPasskey = (function () {
  /**
   * Resolves true when this browser/device can create and use a platform passkey
   * (fingerprint, face or device PIN).
   * @returns {Promise<boolean>}
   */
  async function isSupported() {
    if (!window.SimpleWebAuthnBrowser || !window.SimpleWebAuthnBrowser.browserSupportsWebAuthn()) return false;
    try {
      return await window.SimpleWebAuthnBrowser.platformAuthenticatorIsAvailable();
    } catch (_err) {
      return false;
    }
  }

  /**
   * POSTs JSON to a same-origin endpoint and parses the JSON reply.
   * @param {string} url - Endpoint path.
   * @param {object} body - Request body.
   * @param {string} [csrfToken] - Sent as X-CSRF-Token when given.
   * @returns {Promise<{ ok: boolean, status: number, data: any }>}
   */
  async function postJson(url, body, csrfToken) {
    var headers = { 'Content-Type': 'application/json' };
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
    var res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: headers,
      body: JSON.stringify(body),
    });
    var data = null;
    try {
      data = await res.json();
    } catch (_err) {
      data = null;
    }
    return { ok: res.ok, status: res.status, data: data };
  }

  /**
   * Guesses a friendly label for the current device from the user agent.
   * @returns {string}
   */
  function guessDeviceLabel() {
    var ua = navigator.userAgent || '';
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua)) return 'iPad';
    if (/Android/.test(ua)) return 'Android device';
    if (/Windows/.test(ua)) return 'Windows PC';
    if (/Mac OS X|Macintosh/.test(ua)) return 'Mac';
    if (/CrOS/.test(ua)) return 'Chromebook';
    if (/Linux/.test(ua)) return 'Linux PC';
    return 'Passkey';
  }

  return { isSupported: isSupported, postJson: postJson, guessDeviceLabel: guessDeviceLabel };
})();
