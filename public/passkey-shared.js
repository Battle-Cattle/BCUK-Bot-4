/**
 * Shared helpers for the passkey (WebAuthn) pages. Loaded after
 * /vendor/simplewebauthn/index.umd.min.js, which defines window.SimpleWebAuthnBrowser.
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

  // First match wins, so more specific platforms come before the ones they overlap with.
  var DEVICE_LABELS = [
    [/iPhone/, 'iPhone'],
    [/iPad/, 'iPad'],
    [/Android/, 'Android device'],
    [/Windows/, 'Windows PC'],
    [/Mac OS X|Macintosh/, 'Mac'],
    [/CrOS/, 'Chromebook'],
    [/Linux/, 'Linux PC'],
  ];

  /**
   * Guesses a friendly label for the current device from the user agent.
   * @returns {string}
   */
  function guessDeviceLabel() {
    var ua = navigator.userAgent || '';
    var match = DEVICE_LABELS.find(function (entry) { return entry[0].test(ua); });
    return match ? match[1] : 'Passkey';
  }

  /**
   * True when a startRegistration/startAuthentication rejection just means the user backed out:
   * the library's own abort (ERROR_CEREMONY_ABORTED), or NotAllowedError, which browsers raise
   * when the prompt is dismissed or times out (deliberately indistinguishable, per the WebAuthn
   * spec). Anything else is a real failure worth showing.
   * @param {any} err - The rejection from the SimpleWebAuthn browser call.
   * @returns {boolean}
   */
  function isUserCancellation(err) {
    return !!err && (err.code === 'ERROR_CEREMONY_ABORTED' || err.name === 'NotAllowedError');
  }

  return {
    isSupported: isSupported,
    postJson: postJson,
    guessDeviceLabel: guessDeviceLabel,
    isUserCancellation: isUserCancellation,
  };
})();
