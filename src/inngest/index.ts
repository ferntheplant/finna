import { processExpenses } from './processExpenses';
import { categorizeExpense } from './categorizeExpense';
import logger from '../logger';

export const functions = [
  processExpenses,
  categorizeExpense,
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
