CREATE TEMP FUNCTION f_ExecutionTimeStamp() RETURNS TIMESTAMP AS ('{{ ds }}');
CREATE TEMP FUNCTION f_ExecutionDate() RETURNS DATE AS ('{{ ds }}');

WITH all_columns AS (
  SELECT
      DISTINCT
      CompanyGuid
    , 'Exceptions.ExceptionId' AS ColumnName 
    , ExceptionId AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.Exceptions }}.Exceptions`
  WHERE TIMESTAMP_TRUNC(ActiveFrom, DAY) BETWEEN f_ExecutionTimeStamp() AND f_ExecutionTimeStamp()
  AND ExceptionId IS NOT NULL

UNION ALL

  SELECT
      DISTINCT
      CompanyGuid
    , 'Exceptions.DeviceId' AS ColumnName 
    , DeviceId AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.Exceptions }}.Exceptions`
  WHERE TIMESTAMP_TRUNC(ActiveFrom, DAY) BETWEEN f_ExecutionTimeStamp() AND f_ExecutionTimeStamp()
  AND DeviceId IS NOT NULL

UNION ALL

  SELECT
      DISTINCT
      CompanyGuid
    , 'Exceptions.RuleName' AS ColumnName 
    , RuleName AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.Exceptions }}.Exceptions`
  WHERE TIMESTAMP_TRUNC(ActiveFrom, DAY) BETWEEN f_ExecutionTimeStamp() AND f_ExecutionTimeStamp()
  AND RuleName IS NOT NULL

UNION ALL

  SELECT
      DISTINCT
      CompanyGuid
    , 'Exceptions.RuleId' AS ColumnName 
    , RuleId AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.Exceptions }}.Exceptions`
  WHERE TIMESTAMP_TRUNC(ActiveFrom, DAY) BETWEEN f_ExecutionTimeStamp() AND f_ExecutionTimeStamp()
  AND RuleId IS NOT NULL

UNION ALL

  SELECT
      DISTINCT
      CompanyGuid
    , 'Exceptions.Diagnostic' AS ColumnName 
    , Diagnostic AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.Exceptions }}.Exceptions`
  WHERE TIMESTAMP_TRUNC(ActiveFrom, DAY) BETWEEN f_ExecutionTimeStamp() AND f_ExecutionTimeStamp()
  AND Diagnostic IS NOT NULL
) 
SELECT DISTINCT * from all_columns