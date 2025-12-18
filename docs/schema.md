# Database Schema

## Overview

The NOLTC backend uses PostgreSQL via Supabase with 15 tables organized into logical groups.

## Tables

### Core Reference Tables (Migration 001)

| Table | Purpose | Key Fields |
|-------|---------|------------|
| `accounts` | Billing accounts (~750) | member_number, account_name, status |
| `members` | Individual people (~2,500) | account_id, display_name, pin_hash |
| `courts` | 12 tennis courts | court_number, name, sort_order |
| `devices` | Kiosks, displays, admin, mobile | device_type, device_token |

### Sessions (Migration 002)

| Table | Purpose | Key Fields |
|-------|---------|------------|
| `sessions` | Court occupancy records (append-only) | court_id, session_type, started_at, scheduled_end_at |
| `session_participants` | Players in each session | session_id, member_id, guest_name, participant_type |

### Waitlist (Migration 003)

| Table | Purpose | Key Fields |
|-------|---------|------------|
| `waitlist` | Queue entries | group_type, position, status, joined_at |
| `waitlist_members` | Players in each waitlist group | waitlist_id, member_id, guest_name |

### Blocks (Migration 004)

| Table | Purpose | Key Fields |
|-------|---------|------------|
| `blocks` | Court reservations (lessons, clinics, maintenance, wet) | court_id, block_type, starts_at, ends_at |

### Transactions (Migration 005)

| Table | Purpose | Key Fields |
|-------|---------|------------|
| `transactions` | Financial records (append-only) | account_id, transaction_type, amount_cents |
| `exports` | Export job tracking | export_type, status, date_range_start/end |
| `export_items` | Links transactions to exports | export_id, transaction_id |

### Audit Log (Migration 006)

| Table | Purpose | Key Fields |
|-------|---------|------------|
| `audit_log` | All mutations logged (append-only) | action, entity_type, entity_id, outcome |

### System Settings (Migration 007)

| Table | Purpose | Key Fields |
|-------|---------|------------|
| `system_settings` | Key-value configuration | key, value |
| `operating_hours` | Weekly schedule | day_of_week, opens_at, closes_at |
| `operating_hours_overrides` | Holiday/special closures | date, is_closed, reason |

## Views (Migration 008)

| View | Purpose |
|------|---------|
| `active_sessions_view` | Current court occupancy for displays |
| `active_waitlist_view` | Current queue with wait times |
| `court_availability_view` | Court status (available/occupied/blocked) |

## Seed Data (Migration 009)

- 12 courts (Court 1-12)
- System settings: ball price, guest fees, session durations
- Operating hours: Mon-Fri 6:30-21:00, Sat-Sun 7:00-20:00
