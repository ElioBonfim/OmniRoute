-- The home topology polls provider metrics every three seconds. Keep its
-- lifetime aggregate and latest-status lookups off the wide call_logs rows,
-- including the logical-call filter and deterministic timestamp/id ordering.
CREATE INDEX IF NOT EXISTS idx_cl_provider_metrics_cover ON call_logs(
  provider, timestamp DESC, id DESC, status, duration, error_summary, request_type
);
