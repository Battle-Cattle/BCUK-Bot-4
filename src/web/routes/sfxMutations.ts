import { Router } from 'express';
import sfxTriggerMutationsRouter from './sfxTriggerMutations';
import sfxFileMutationsRouter from './sfxFileMutations';
import sfxCategoryMutationsRouter from './sfxCategoryMutations';

// Aggregator for the SFX management endpoints. The handlers are split by domain
// (triggers / sound files / categories) across sibling routers, mirroring the
// commandMutations / commandAssignments split, then mounted together here.
const router = Router();
router.use(sfxTriggerMutationsRouter);
router.use(sfxFileMutationsRouter);
router.use(sfxCategoryMutationsRouter);

export default router;
