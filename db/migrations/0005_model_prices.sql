-- 0005 · model_prices — 单价表（唯一成本事实源）
-- 事实源：docs/facts/database-schema.md §2.5
-- 不可变：否 —— 但只增行、不改行（MP-2）；调价靠 effective_from 区分

CREATE TABLE model_prices (
  id                  uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  model_provider_id   uuid           NOT NULL REFERENCES model_providers (id) ON DELETE CASCADE,
  model_id            text           NOT NULL,
  display_name        text           NOT NULL,
  input_price_per_1k  numeric(18,8)  NOT NULL,
  output_price_per_1k numeric(18,8)  NOT NULL,
  currency            text           NOT NULL DEFAULT 'CNY',
  effective_from      timestamptz    NOT NULL DEFAULT now(),
  created_at          timestamptz    NOT NULL DEFAULT now(),

  CONSTRAINT ux_model_prices_provider_model_from
    UNIQUE (model_provider_id, model_id, effective_from),
  CONSTRAINT ck_model_prices_input  CHECK (input_price_per_1k  >= 0),
  CONSTRAINT ck_model_prices_output CHECK (output_price_per_1k >= 0)
);

CREATE INDEX ix_model_prices_lookup
  ON model_prices (model_provider_id, model_id, effective_from DESC);
