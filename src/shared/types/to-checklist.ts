export type TOItemStatus = 'pass' | 'pending' | 'blocked';

export interface TOChecklistItem {
  id: string;
  category: 'coverage' | 'regression' | 'signoff';
  name: string;
  description: string;
  status: TOItemStatus;
  autoEvaluated: boolean;
  threshold?: number;
  actualValue?: number;
  details?: string;
}
