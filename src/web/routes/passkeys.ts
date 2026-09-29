import { Router } from 'express';
import registrationRouter from './passkeysRegistration';
import loginRouter from './passkeysLogin';

// Passkey (WebAuthn) routes, mounted at /auth/passkey. Registration and deletion (signed-in,
// CSRF-protected) live in passkeysRegistration.ts; sign-in (no session yet) in passkeysLogin.ts;
// challenge handling and shared helpers in passkeysShared.ts.
const router = Router();
router.use(registrationRouter);
router.use(loginRouter);

export { chooseUserHandle, sanitizeDeviceLabel } from './passkeysShared';
export default router;
