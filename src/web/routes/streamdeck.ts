import { Router } from 'express';
import sfxRouter from './streamdeckSfx';
import voiceRouter from './streamdeckVoice';

const router = Router();
router.use(sfxRouter);
router.use(voiceRouter);

export default router;
