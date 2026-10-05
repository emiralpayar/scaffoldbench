import type { Task } from '@scaffoldbench/core';
import { ecommerceBackordersTask } from './backorders';
import { ecommerceInboxTask } from './inbox';
import { ecommerceReturnsTask } from './returns';

export * from './backorders';
export * from './common';
export * from './inbox';
export * from './returns';

export const ecommerceExpertTasks: Task[] = [
  ecommerceBackordersTask,
  ecommerceReturnsTask,
  ecommerceInboxTask,
];
