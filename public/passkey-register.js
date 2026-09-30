/**
 * User Settings: "Add a passkey on this device" and passkey removal confirmation.
 */
(function () {
  var csrfToken = (document.body && document.body.dataset.csrfToken) || '';
  var addRow = document.getElementById('passkey-add-row');
  var addButton = document.getElementById('passkey-add');
  var unsupported = document.getElementById('passkey-unsupported');

  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.classList.contains('js-confirm-remove-passkey')) return;
    var label = form.dataset.passkeyLabel || 'this passkey';
    if (!window.confirm('Remove "' + label + '"? You will no longer be able to sign in with it.')) event.preventDefault();
  });

  if (!addRow || !addButton || !window.BCUKPasskey) return;

  /**
   * Sends the browser back to the settings page with a result code banner.
   * @param {'error'|'success'} kind - Query parameter to set.
   * @param {string} code - Result code the settings page understands.
   */
  function finish(kind, code) {
    window.location.href = '/user/settings?' + kind + '=' + encodeURIComponent(code);
  }

  /**
   * Handles the server asking for a fresh Discord login before a passkey can be added: offers to
   * sign in with Discord again, returning to this page afterwards.
   * @param {{ data?: { error?: string } }} res - Result from `BCUKPasskey.postJson`.
   * @returns {boolean} True if re-authentication was required (the caller should stop).
   */
  function needsReauth(res) {
    if (!res.data || res.data.error !== 'passkey_reauth_required') return false;
    if (window.confirm('For security, please sign in with Discord again before adding a passkey.')) {
      window.location.href = '/auth/discord?return=passkey';
    }
    return true;
  }

  /**
   * Runs the full registration ceremony: fetch options, prompt the authenticator
   * (fingerprint/face/PIN), then send the result back for verification.
   */
  async function registerPasskey() {
    var label = window.prompt('Name this passkey', window.BCUKPasskey.guessDeviceLabel());
    if (label === null) return;

    addButton.disabled = true;
    try {
      var optionsRes = await window.BCUKPasskey.postJson('/auth/passkey/register/options', {}, csrfToken);
      if (needsReauth(optionsRes)) return;
      if (!optionsRes.ok) {
        finish('error', (optionsRes.data && optionsRes.data.error) || 'passkey_register_failed');
        return;
      }

      var attestation;
      try {
        attestation = await window.SimpleWebAuthnBrowser.startRegistration({ optionsJSON: optionsRes.data });
      } catch (err) {
        // InvalidStateError: this authenticator already holds one of their passkeys. A cancelled or
        // dismissed prompt is ignored; any other failure is shown.
        if (err && err.name === 'InvalidStateError') finish('error', 'passkey_exists');
        else if (!window.BCUKPasskey.isUserCancellation(err)) finish('error', 'passkey_register_failed');
        return;
      }

      var verifyRes = await window.BCUKPasskey.postJson(
        '/auth/passkey/register/verify',
        { response: attestation, label: label },
        csrfToken
      );
      if (needsReauth(verifyRes)) return;
      if (verifyRes.ok) finish('success', 'passkey_added');
      else finish('error', (verifyRes.data && verifyRes.data.error) || 'passkey_register_failed');
    } catch (_err) {
      finish('error', 'passkey_register_failed');
    } finally {
      addButton.disabled = false;
    }
  }

  window.BCUKPasskey.isSupported().then(function (supported) {
    if (supported) {
      addRow.classList.remove('is-hidden');
      addButton.addEventListener('click', function () {
        void registerPasskey();
      });
    } else if (unsupported) {
      unsupported.classList.remove('is-hidden');
    }
  });
})();
