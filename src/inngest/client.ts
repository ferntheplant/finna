import { Inngest } from 'inngest';
import { schemas } from './types';
import { inngestLogger } from '../logger';
import logger from '../logger';

// Read Inngest configuration from environment
const eventKey = process.env.INNGEST_EVENT_KEY;
const baseURL = process.env.INNGEST_BASE_URL;
const isDev = process.env.INNGEST_DEV !== '0'; // Set to false for self-hosted/production

logger.info({
  id: 'finna-expense-app',
  eventKey: eventKey ? `${eventKey.substring(0, 10)}...` : 'not set',
  baseURL: baseURL || 'default (Inngest Cloud)',
  isDev,
}, 'Configuring Inngest client');

export const inngest = new Inngest({
  id: 'finna-expense-app',
  schemas,
  logger: inngestLogger,
  eventKey,
  baseURL,
  isDev,
});
