import { Router } from 'express';
import sfxRouter from './streamdeckSfx';
import voiceRouter from './streamdeckVoice';
import advancedCommandsRouter from './streamdeckAdvancedCommands';
import raffleRouter from './streamdeckRaffle';

const router = Router();
router.use(sfxRouter);
router.use(voiceRouter);
router.use(advancedCommandsRouter);
router.use(raffleRouter);

export default router;
