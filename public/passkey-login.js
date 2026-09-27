/**
 * Login page: "Sign in with fingerprint" via a discoverable passkey.
 */
(function () {
  var button = document.getElementById('passkey-login');
  var wrapper = document.getElementById('passkey-login-wrapper');
  if (!button || !wrapper || !window.BCUKPasskey) return;

  /**
   * Sends the browser back to the login page with an error banner.
   * @param {string} code - Error code GET /auth/login understands.
   */
  function fail(code) {
    window.location.href = '/auth/login?error=' + encodeURIComponent(code);
  }

  /**
   * Runs the sign-in ceremony: fetch a challenge, have the authenticator sign it after
   * fingerprint/face/PIN verification, then let the server create the session.
   */
  async function signIn() {
    button.disabled = true;
    try {
      var optionsRes = await window.BCUKPasskey.postJson('/auth/passkey/login/options', {});
      if (!optionsRes.ok) {
        fail('passkey_failed');
        return;
      }

      var assertion;
      try {
        assertion = await window.SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: optionsRes.data });
      } catch (_err) {
        // The user cancelled the prompt — just let them try again.
        return;
      }

      var verifyRes = await window.BCUKPasskey.postJson('/auth/passkey/login/verify', { response: assertion });
      if (verifyRes.ok && verifyRes.data && verifyRes.data.redirect) {
        window.location.href = verifyRes.data.redirect;
      } else {
        fail((verifyRes.data && verifyRes.data.error) || 'passkey_failed');
      }
    } catch (_err) {
      fail('passkey_failed');
    } finally {
      button.disabled = false;
    }
  }

  window.BCUKPasskey.isSupported().then(function (supported) {
    if (!supported) return;
    wrapper.classList.remove('is-hidden');
    button.addEventListener('click', function () {
      void signIn();
    });
  });
})();
