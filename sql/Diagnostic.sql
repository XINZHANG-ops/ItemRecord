WITH all_columns AS (
  SELECT
      DISTINCT
      'universal'               AS CompanyGuid
    , 'Diagnostic.DiagnosticId' AS ColumnName 
    , DiagnosticId              AS ColumnValue 
 FROM `{{ params.source_project }}.{{ params.sources_tables.Diagnostic }}.Diagnostic`
WHERE DiagnosticId IS NOT NULL
  AND NOT REGEXP_CONTAINS(DiagnosticId, r'-|_')
  AND REGEXP_CONTAINS(DiagnosticId, r'.*Id$')

UNION ALL

  SELECT
      DISTINCT
      'universal'                 AS CompanyGuid
    , 'Diagnostic.DiagnosticName' AS ColumnName 
    , DiagnosticName              AS ColumnValue 
 FROM `{{ params.source_project }}.{{ params.sources_tables.Diagnostic }}.Diagnostic`
WHERE DiagnosticName IS NOT NULL

) 
SELECT DISTINCT * from all_columns