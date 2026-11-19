export type ApiErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNPROCESSABLE_ENTITY'
  | 'RATE_LIMITED'
  | 'COST_BUDGET_EXCEEDED'
  | 'INTERNAL_ERROR'
  | 'SERVICE_UNAVAILABLE';

export interface ApiErrorDetails {
  [key: string]: unknown;
}

export interface ApiErrorBody {
  code: ApiErrorCode;
  message: string;
  requestId?: string;
  version?: string;
  details?: ApiErrorDetails;
}

export interface CostBudgetExceededDetails extends ApiErrorDetails {
  cost: number;
  limit: number;
  windowMs: number;
  retryAfter: number;
}

export interface CostBudgetExceededErrorBody extends ApiErrorBody {
  code: 'COST_BUDGET_EXCEEDED';
  details: CostBudgetExceededDetails;
}

export interface ApiErrorResponse {
  error: ApiErrorBody;
}

export interface CostBudgetExceededErrorResponse {
  error: CostBudgetExceededErrorBody;
}

export class ApiError extends Error {
  public readonly code: ApiErrorCode;
  public readonly status: number;
  public readonly details?: ApiErrorDetails;

  constructor(code: ApiErrorCode, message: string, status: number, details?: ApiErrorDetails) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }

  toBody(requestId?: string, version?: string): ApiErrorBody {
    const body: ApiErrorBody = {
      code: this.code,
      message: this.message,
    };
    if (requestId !== undefined) {
      body.requestId = requestId;
    }
    if (version !== undefined) {
      body.version = version;
    }
    if (this.details !== undefined) {
      body.details = this.details;
    }
    return body;
  }

  toResponse(requestId?: string, version?: string): ApiErrorResponse {
    return { error: this.toBody(requestId, version) };
  }
}

export class CostBudgetExceededError extends ApiError {
  constructor(
    message: string,
    details: CostBudgetExceededDetails,
    status = 429,
  ) {
    super('COST_BUDGET_EXCEEDED', message, status, details);
    this.name = 'CostBudgetExceededError';
  }

  override toBody(requestId?: string, version?: string): CostBudgetExceededErrorBody {
    return super.toBody(requestId, version) as CostBudgetExceededErrorBody;
  }

  override toResponse(requestId?: string, version?: string): CostBudgetExceededErrorResponse {
    return { error: this.toBody(requestId, version) };
  }
}

export function isCostBudgetExceededErrorBody(
  body: ApiErrorBody,
): body is CostBudgetExceededErrorBody {
  return body.code === 'COST_BUDGET_EXCEEDED';
}