DROP TRIGGER IF EXISTS trg_callback_tokens_immutable ON callback_tokens;
DROP FUNCTION IF EXISTS reject_callback_token_mutation();
DROP INDEX IF EXISTS ix_callback_tokens_gate;
DROP TABLE IF EXISTS callback_tokens;
