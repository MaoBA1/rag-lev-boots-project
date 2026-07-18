import { Request, Response } from 'express';
import { ask, askWithContext, loadAllData } from '../services/ragService';

export const loadData = async (_: Request, res: Response): Promise<void> => {
  try {
    await loadAllData();
    res.status(200).json({ ok: true });
  } catch (error) {
    res.status(500).json({
      answer: '',
      error: 'Failed to load data',
    });
  }
};

export const askQuestion = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { userQuestion } = req.body || {};
    if (!userQuestion) {
      res.status(400).json({
        answer: '',
        error: 'You must provide the userQuestion',
      });
      return;
    }

    const answer = await ask(userQuestion);
    res.status(200).json({ answer });
  } catch (error) {
    res.status(500).json({
      answer: '',
      error: 'Something went wrong, please try again later.',
    });
  }
};

// Eval-only endpoint: also returns the retrieved chunks, so external eval
// tooling (e.g. the Python ragas harness) can score faithfulness/context
// precision/recall against what retrieval actually returned. Not used by
// the production UI.
export const askQuestionEval = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { userQuestion } = req.body || {};
    if (!userQuestion) {
      res.status(400).json({
        answer: '',
        retrievedChunks: [],
        error: 'You must provide the userQuestion',
      });
      return;
    }

    const { answer, retrievedChunks } = await askWithContext(userQuestion);
    res.status(200).json({ answer, retrievedChunks });
  } catch (error) {
    res.status(500).json({
      answer: '',
      retrievedChunks: [],
      error: 'Something went wrong, please try again later.',
    });
  }
};
