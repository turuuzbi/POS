-- Raise append-only violations as P0001 (raise_exception) instead of
-- 23001 (restrict_violation): Prisma maps 23xxx codes to foreign-key errors,
-- which hid the real reason in application logs.
CREATE OR REPLACE FUNCTION pos_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only: % on "%" is not allowed', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'P0001',
          HINT = 'Record a correction (void, refund or reversal entry) instead.';
END;
$$;
