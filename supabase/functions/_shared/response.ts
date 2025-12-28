/**
 * Standardized response envelope helpers
 *
 * All Edge Functions should use these for consistent response shapes.
 */

/**
 * Create a success response
 */
export function successResponse<T>(data: T, serverNow?: string): Response {
  const now = serverNow || new Date().toISOString();
  return new Response(
    JSON.stringify({
      ok: true,
      serverNow: now,
      ...data,
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}

/**
 * Create an error response
 */
export function errorResponse(
  code: string,
  message: string,
  serverNow?: string,
  status: number = 400
): Response {
  const now = serverNow || new Date().toISOString();
  return new Response(
    JSON.stringify({
      ok: false,
      code,
      message,
      serverNow: now,
    }),
    {
      status,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}

/**
 * Create a 404 not found response
 */
export function notFoundResponse(message: string, serverNow?: string): Response {
  return errorResponse('not_found', message, serverNow, 404);
}

/**
 * Create a 409 conflict response
 */
export function conflictResponse(code: string, message: string, serverNow?: string): Response {
  return errorResponse(code, message, serverNow, 409);
}

/**
 * Create a 500 internal error response
 */
export function internalErrorResponse(message: string, serverNow?: string): Response {
  return errorResponse('internal_error', message, serverNow, 500);
}
