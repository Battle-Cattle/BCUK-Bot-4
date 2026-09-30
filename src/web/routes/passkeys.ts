import { Router } from 'express';
import enrollmentCodeRouter from './passkeysEnrollmentCode';
import registrationRouter from './passkeysRegistration';
import loginRouter from './passkeysLogin';

// Passkey (WebAuthn) routes, mounted at /auth/passkey. Registration and deletion (signed-in,
// CSRF-protected) live in passkeysRegistration.ts, gated by the Discord-DM code from
// passkeysEnrollmentCode.ts; sign-in (no session yet) in passkeysLogin.ts;
// challenge handling and shared helpers in passkeysShared.ts.
const router = Router();
router.use(enrollmentCodeRouter);
router.use(registrationRouter);
router.use(loginRouter);

export { chooseUserHandle, sanitizeDeviceLabel } from './passkeysShared';
export default router;
