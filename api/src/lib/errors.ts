// Stable error codes (spec 11.3): clients switch on `code`, never on message text.
export class ApiError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 415 | 422 | 429 | 500,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const unauthenticated = () => new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
export const forbidden = (msg = 'You are not allowed to do this.') => new ApiError(403, 'FORBIDDEN', msg);
export const notFound = (what = 'Resource') => new ApiError(404, 'NOT_FOUND', `${what} not found.`);
export const conflict = (code: string, msg: string, details?: unknown) => new ApiError(409, code, msg, details);
export const invalid = (msg: string, details?: unknown) => new ApiError(422, 'VALIDATION_FAILED', msg, details);
export const badRequest = (msg: string, details?: unknown) => new ApiError(400, 'BAD_REQUEST', msg, details);
