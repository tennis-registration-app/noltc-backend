# ADR-005: One Stored Procedure Per Migration File

## Status
Accepted

## Context

The Supabase CLI (`supabase db push`) uses a prepared-statement parser that splits migration files on semicolons. When a migration file contains multiple `$$`-quoted PL/pgSQL function bodies, the parser misidentifies the statement boundaries and raises `SQLSTATE 42601: cannot insert multiple commands into a prepared statement`. This affects all tested CLI versions including 2.84.10 and is an unresolved upstream bug.

The original baseline migration (`00000000000000_baseline.sql`) mixed table DDL and stored procedure definitions in a single file, which triggered this bug whenever `supabase db push` was run.

## Decision

Each stored procedure is defined in its own dedicated migration file. The `LANGUAGE plpgsql` clause is placed after the closing `$$` on the same line (`$$ LANGUAGE plpgsql`) rather than on a separate line, which avoids certain parser edge cases. New migrations that add or modify stored procedures must follow this convention.

## Consequences

**Benefits:**
- `supabase db push` reliably applies table DDL migrations (no PL/pgSQL in those files)
- Each function's history is independently traceable in `git log`
- Reduces the blast radius of a failed migration push

**Trade-offs:**
- More migration files than strictly necessary
- The baseline file still exists with the original mixed content — it cannot be modified without resetting migration history. A future contractor can resolve this by splitting it, but it is not blocking
- Migrations containing stored procedures must still be applied via the Supabase Dashboard SQL Editor as a workaround until the CLI bug is resolved upstream
