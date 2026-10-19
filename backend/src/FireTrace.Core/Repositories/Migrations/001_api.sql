-- Estado da API: todos os recursos (organizações, viaturas, planos, cenários…) são documentos JSON numa só tabela.
CREATE TABLE IF NOT EXISTS documents (
  collection text NOT NULL,
  id text NOT NULL,
  body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection, id)
);

