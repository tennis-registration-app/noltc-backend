/**
 * Input validation helpers for Edge Functions
 */

import { END_REASONS, WAITLIST_STATUSES, GROUP_TYPES } from './constants.ts';

export type ValidationError = {
  field: string;
  message: string;
};

/**
 * Require a string field
 */
export function requireString(
  body: Record<string, unknown>,
  key: string
): string | ValidationError {
  const value = body[key];
  if (typeof value !== 'string' || value.trim() === '') {
    return { field: key, message: `${key} is required and must be a non-empty string` };
  }
  return value;
}

/**
 * Require a UUID field
 */
export function requireUuid(
  body: Record<string, unknown>,
  key: string
): string | ValidationError {
  const value = body[key];
  if (typeof value !== 'string') {
    return { field: key, message: `${key} is required and must be a string` };
  }
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(value)) {
    return { field: key, message: `${key} must be a valid UUID` };
  }
  return value;
}

/**
 * Require an enum field
 */
export function requireEnum<T extends readonly string[]>(
  body: Record<string, unknown>,
  key: string,
  allowed: T
): T[number] | ValidationError {
  const value = body[key];
  if (typeof value !== 'string' || !allowed.includes(value as T[number])) {
    return {
      field: key,
      message: `${key} must be one of: ${allowed.join(', ')}`,
    };
  }
  return value as T[number];
}

/**
 * Require an array field
 */
export function requireArray(
  body: Record<string, unknown>,
  key: string
): unknown[] | ValidationError {
  const value = body[key];
  if (!Array.isArray(value)) {
    return { field: key, message: `${key} is required and must be an array` };
  }
  return value;
}

/**
 * Optional string field
 */
export function optionalString(
  body: Record<string, unknown>,
  key: string,
  defaultValue: string = ''
): string {
  const value = body[key];
  if (typeof value === 'string') {
    return value;
  }
  return defaultValue;
}

/**
 * Check if result is a validation error
 */
export function isValidationError(result: unknown): result is ValidationError {
  return typeof result === 'object' && result !== null && 'field' in result && 'message' in result;
}

/**
 * Validate end reason
 */
export function requireEndReason(body: Record<string, unknown>, key: string = 'end_reason') {
  return requireEnum(body, key, END_REASONS);
}

/**
 * Validate group type
 */
export function requireGroupType(body: Record<string, unknown>, key: string = 'group_type') {
  return requireEnum(body, key, GROUP_TYPES);
}
