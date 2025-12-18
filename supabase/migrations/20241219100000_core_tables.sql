-- Core reference tables: accounts, members, courts, devices

-- Accounts (billing accounts, ~750)
CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_number text UNIQUE NOT NULL,
  account_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_accounts_member_number ON accounts(member_number);
CREATE INDEX idx_accounts_status ON accounts(status);

-- Members (individual people, ~2,500)
CREATE TABLE members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  display_name text NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  pin_hash text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_members_account_id ON members(account_id);
CREATE INDEX idx_members_display_name ON members(display_name);
CREATE INDEX idx_members_status ON members(status);

-- Courts (12 courts)
CREATE TABLE courts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  court_number integer UNIQUE NOT NULL CHECK (court_number > 0),
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_courts_sort_order ON courts(sort_order);

-- Devices (kiosk, passive displays, admin, mobile)
CREATE TABLE devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_type text NOT NULL CHECK (device_type IN ('kiosk', 'passive_display', 'admin', 'mobile')),
  device_name text NOT NULL,
  device_token text UNIQUE NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  last_seen_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_devices_device_type ON devices(device_type);
CREATE INDEX idx_devices_device_token ON devices(device_token);

-- Trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_accounts_updated_at BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_members_updated_at BEFORE UPDATE ON members
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
