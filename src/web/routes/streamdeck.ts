import { Router } from 'express';
import sfxRouter from './streamdeckSfx';
import voiceRouter from './streamdeckVoice';
import advancedCommandsRouter from './streamdeckAdvancedCommands';

const router = Router();
router.use(sfxRouter);
router.use(voiceRouter);
router.use(advancedCommandsRouter);

export default router;
