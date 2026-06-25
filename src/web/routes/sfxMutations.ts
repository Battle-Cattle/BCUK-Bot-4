import { Router } from 'express';
import sfxTriggerMutationsRouter from './sfxTriggerMutations';
import sfxFileMutationsRouter from './sfxFileMutations';
import sfxFileUploadRouter from './sfxFileUpload';
import sfxCategoryMutationsRouter from './sfxCategoryMutations';

// Aggregator for the SFX management endpoints. The handlers are split by domain
// (triggers / sound files / categories) across sibling routers, mirroring the
// commandMutations / commandAssignments split, then mounted together here.
// Sound-file upload has its own router (multer + magic-byte detection) separate
// from the lighter update/remove mutations, to keep per-file complexity down.
const router = Router();
router.use(sfxTriggerMutationsRouter);
router.use(sfxFileMutationsRouter);
router.use(sfxFileUploadRouter);
router.use(sfxCategoryMutationsRouter);

export default router;
