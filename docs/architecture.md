# Architecture

## Overview
Backend-authoritative system using Supabase.

## Principles
- Edge Functions are the ONLY mutation path
- Clients read via RLS-protected views
- Immutable history (append-only sessions and transactions)
- All mutations logged to audit_log

(To be expanded)
