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
   * Returns the error code from a `BCUKPasskey.postJson` result, if any.
   * @param {{ data?: { error?: string } }} res - Result from `BCUKPasskey.postJson`.
   * @returns {string|undefined} The server's error code.
   */
  function errorOf(res) {
    return res.data && res.data.error;
  }

  /**
   * Asks the server to DM the user a one-time confirmation code. A "code sent recently" response
   * counts as success: the code they already received is still usable.
   * @returns {Promise<boolean>} True if the user should now be asked for the code; false if the
   *   flow ended (redirected for re-authentication or an error banner shown).
   */
  async function requestDiscordCode() {
    var codeRes = await window.BCUKPasskey.postJson('/auth/passkey/register/code', {}, csrfToken);
    if (needsReauth(codeRes)) return false;
    var failed = !codeRes.ok && errorOf(codeRes) !== 'passkey_code_throttled';
    if (failed) finish('error', errorOf(codeRes) || 'passkey_register_failed');
    return !failed;
  }

  /**
   * Turns a final `/register/options` response into the options to use, or ends the flow.
   * @param {{ ok: boolean, data?: object }} optionsRes - Result from `BCUKPasskey.postJson`.
   * @returns {object|null} The successful response, or null if the flow ended.
   */
  function optionsOrFinish(optionsRes) {
    if (needsReauth(optionsRes)) return null;
    if (optionsRes.ok) return optionsRes;
    finish('error', errorOf(optionsRes) || 'passkey_register_failed');
    return null;
  }

  /**
   * Has the bot DM a one-time confirmation code, asks the user to type it in, and exchanges it
   * for registration options. A mistyped code can be re-entered (the server limits attempts).
   * @returns {Promise<object|null>} The successful options response, or null if the flow ended
   *   (cancelled, redirected, or an error banner shown).
   */
  async function confirmWithDiscordCode() {
    if (!(await requestDiscordCode())) return null;
    var message = 'Enter the 6-digit confirmation code the bot just sent you in a Discord DM.';
    for (;;) {
      var code = window.prompt(message, '');
      if (code === null) return null;
      var optionsRes = await window.BCUKPasskey.postJson(
        '/auth/passkey/register/options',
        { code: code.replace(/\s+/g, '') },
        csrfToken
      );
      if (errorOf(optionsRes) !== 'passkey_code_invalid') return optionsOrFinish(optionsRes);
      message = 'That code was incorrect. Enter the 6-digit code from your Discord DM.';
    }
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
      var optionsRes = await confirmWithDiscordCode();
      if (!optionsRes) return;

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
