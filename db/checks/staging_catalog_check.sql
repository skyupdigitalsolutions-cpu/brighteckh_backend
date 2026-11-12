-- BRIGHTECH BR01-05 | READ-ONLY STAGING CATALOG SMOKE CHECK
-- Run AFTER a fresh combined staging install. This script does not alter any data.
SELECT object_name, to_regclass('public.'||object_name) AS found_table
FROM (VALUES
 ('legal_entities'),('service_jobs'),('customers'),('assemblies'),
 ('br03_material_requests'),('br03_inspection_report_versions'),
 ('br04_customer_quotes'),('br04_customer_quote_revisions'),
 ('br04_customer_quote_lines'),('br04_rfqs'),('br04_rfq_versions'),
 ('br05_quote_revision_refs'),('br05_quote_lines'),('br05_customer_orders'),
 ('br05_job_authorisations'),('br05_stock_rechecks'),('br05_job_releases'),
 ('br05_material_reservations'),('br05_supplier_po_release_intents')
) t(object_name)
ORDER BY object_name;
SELECT tgrelid::regclass::text AS table_name, tgname AS trigger_name
FROM pg_trigger
WHERE NOT tgisinternal AND tgname LIKE 'brcm_%'
ORDER BY 1,2;
SELECT proname AS function_name FROM pg_proc WHERE proname LIKE 'brcm_%' ORDER BY 1;
-- Cannot establish business-rule correctness; run 28 manual/integration tests in workbook.
