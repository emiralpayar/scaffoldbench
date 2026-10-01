import type { Task } from '@arena/core';
import { supportAccessTask } from './access';
import { supportIncidentTask } from './incident';
import { supportTriageTask } from './triage';

export * from './access';
export * from './common';
export * from './incident';
export * from './triage';

export const supportExpertTasks: Task[] = [supportTriageTask, supportIncidentTask, supportAccessTask];
