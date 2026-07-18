import express from 'express';
import { loadData, askQuestion, askQuestionEval } from '../controllers/ragController';

const router = express.Router();

router.post('/load_data', loadData);
router.post('/ask', askQuestion);
router.post('/ask_eval', askQuestionEval);

export default router;
