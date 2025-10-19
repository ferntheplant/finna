import { processExpenses } from './processExpenses';
import { categorizeExpense } from './categorizeExpense';
import { retryReviewCategorization } from './retryReviewCategorization';
import { retryPendingAfterCategoryCreation } from './retryPendingAfterCategoryCreation';
import { completeReviewedExpense } from './completeReviewedExpense';
import {
  trackRunCompletion,
  trackRunCompletionFromReview,
  trackRunCompletionFromFailure,
} from './trackRunCompletion';
import logger from '../logger';

export const functions = [
  processExpenses,
  categorizeExpense,
  retryReviewCategorization,
  retryPendingAfterCategoryCreation,
  completeReviewedExpense,
  trackRunCompletion,
  trackRunCompletionFromReview,
  trackRunCompletionFromFailure,
];

// Validate functions on initialization
logger.info({
  count: functions.length,
  functions: functions.map(f => ({
    id: f.id,
    name: f.name,
  }))
}, 'Registering Inngest functions');

export { inngest } from './client';
