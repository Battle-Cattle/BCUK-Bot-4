-- Performance indexes for command-lookup hot paths.
-- Re-runnable: each block checks information_schema before creating the index.

-- idx_cc_trigger on custom_command(trigger_string)
SET @exists = (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name   = 'custom_command'
    AND index_name   = 'idx_cc_trigger'
);
SET @sql = IF(@exists = 0,
  'CREATE INDEX idx_cc_trigger ON custom_command(trigger_string)',
  'SELECT ''idx_cc_trigger already exists'''
);
PREPARE _stmt FROM @sql;
EXECUTE _stmt;
DEALLOCATE PREPARE _stmt;

-- idx_counter_trigger on counter(trigger_command)
SET @exists = (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name   = 'counter'
    AND index_name   = 'idx_counter_trigger'
);
SET @sql = IF(@exists = 0,
  'CREATE INDEX idx_counter_trigger ON counter(trigger_command)',
  'SELECT ''idx_counter_trigger already exists'''
);
PREPARE _stmt FROM @sql;
EXECUTE _stmt;
DEALLOCATE PREPARE _stmt;

-- idx_counter_check on counter(check_command)
SET @exists = (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name   = 'counter'
    AND index_name   = 'idx_counter_check'
);
SET @sql = IF(@exists = 0,
  'CREATE INDEX idx_counter_check ON counter(check_command)',
  'SELECT ''idx_counter_check already exists'''
);
PREPARE _stmt FROM @sql;
EXECUTE _stmt;
DEALLOCATE PREPARE _stmt;
