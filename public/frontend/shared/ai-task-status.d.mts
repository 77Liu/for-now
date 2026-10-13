export const WAITING_FOR_USER_MODEL_STATUS: string;
export const WAITING_FOR_USER_MODEL_MESSAGE: string;
export function isPendingAiTaskStatus(status: string): boolean;
export function isWaitingForUserModelTask(task: { status?: string } | null | undefined): boolean;
export function pendingAiTaskMessage(task: { status?: string } | null | undefined, runningMessage: string): string;
