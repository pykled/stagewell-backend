-- Gmail Token Storage Table
CREATE TABLE IF NOT EXISTS gmail_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  email TEXT NOT NULL UNIQUE,
  access_token TEXT NOT NULL ENCRYPTED WITH (ALGORITHM = 'aes-256-gcm'),
  refresh_token TEXT ENCRYPTED WITH (ALGORITHM = 'aes-256-gcm'),
  token_expires_at TIMESTAMP WITH TIME ZONE,
  scopes TEXT[] DEFAULT ARRAY['gmail.readonly', 'gmail.modify'],
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_used_at TIMESTAMP WITH TIME ZONE
);

-- Index for quick lookup by user
CREATE INDEX idx_gmail_tokens_user_id ON gmail_tokens(user_id);
CREATE INDEX idx_gmail_tokens_email ON gmail_tokens(email);

-- Enable RLS (Row Level Security)
ALTER TABLE gmail_tokens ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Users can only see their own tokens
CREATE POLICY "Users can only view their own Gmail tokens"
  ON gmail_tokens
  FOR SELECT
  USING (auth.uid() = user_id);

-- RLS Policy: Users can only update their own tokens
CREATE POLICY "Users can only update their own Gmail tokens"
  ON gmail_tokens
  FOR UPDATE
  USING (auth.uid() = user_id);

-- RLS Policy: Users can only insert their own tokens
CREATE POLICY "Users can only insert their own Gmail tokens"
  ON gmail_tokens
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- RLS Policy: Users can only delete their own tokens
CREATE POLICY "Users can only delete their own Gmail tokens"
  ON gmail_tokens
  FOR DELETE
  USING (auth.uid() = user_id);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_gmail_tokens_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE PLPGSQL;

CREATE TRIGGER gmail_tokens_updated_at
  BEFORE UPDATE ON gmail_tokens
  FOR EACH ROW
  EXECUTE FUNCTION update_gmail_tokens_updated_at();
