import type { Task } from '@scaffoldbench/core';
import { airlineBaggageAuditTask } from './baggageAudit';
import { airlineCancellationsTask } from './cancellations';
import { airlineIrropsTask } from './irrops';
import { airlineWaiversTask } from './waivers';

export * from './baggageAudit';
export * from './cancellations';
export * from './common';
export * from './irrops';
export * from './waivers';

export const airlineExpertTasks: Task[] = [
  airlineIrropsTask,
  airlineWaiversTask,
  airlineCancellationsTask,
  airlineBaggageAuditTask,
];
