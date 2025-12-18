# NOLTC Backend

Supabase backend for the New Orleans Lawn Tennis Club Court Registration System.

## Overview

This repository contains:
- Database schema and migrations (`supabase/migrations/`)
- Edge Functions (`supabase/functions/`)
- Architecture documentation (`docs/`)

## Setup

1. Install Supabase CLI
2. Copy `.env.example` to `.env` and fill in credentials
3. Run `supabase link` to connect to the project
4. Run `supabase db push` to apply migrations

## Related

- Frontend: https://github.com/tennis-registration-app/NOLTCsignup
