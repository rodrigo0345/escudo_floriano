import { http } from '../httpClient';
import { fetchAllPages } from '../pagination';
import type { ActionPriority, ActionStatus, Page, PlanStatus, TaskItem } from '../types';

export interface ActionQueryParams {
  planStatus?: PlanStatus;
  status?: ActionStatus;
  type?: string;
  organizationId?: string;
  priority?: ActionPriority;
  limit?: number;
  cursor?: string;
}

export const actionsApi = {
  list: async (params: ActionQueryParams = {}): Promise<Page<TaskItem>> => {
    const { data } = await http.get<Page<TaskItem>>('/actions', { params });
    return data;
  },

  all: (params: Omit<ActionQueryParams, 'limit' | 'cursor'> = {}): Promise<TaskItem[]> =>
    fetchAllPages<TaskItem>('/actions', params as Record<string, string>),
};
