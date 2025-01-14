CREATE TEMP FUNCTION f_ExecutionTimeStamp() RETURNS TIMESTAMP AS ('{{ ds }}');
CREATE TEMP FUNCTION f_ExecutionDate() RETURNS DATE AS ('{{ ds }}');

WITH all_columns AS (
  SELECT
      DISTINCT
      CompanyGuid
    , 'Rule.RuleId' AS ColumnName 
    , RuleId AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.Rule }}.Rule`
  WHERE TIMESTAMP_TRUNC(StreamDateTime, DAY) BETWEEN f_ExecutionTimeStamp() AND f_ExecutionTimeStamp()
  AND RuleId IS NOT NULL

UNION ALL

  SELECT
      DISTINCT
      CompanyGuid
    , 'Rule.RuleName' AS ColumnName 
    , RuleName AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.Rule }}.Rule`
  WHERE TIMESTAMP_TRUNC(StreamDateTime, DAY) BETWEEN f_ExecutionTimeStamp() AND f_ExecutionTimeStamp()
  AND RuleName IS NOT NULL
) 
SELECT DISTINCT * from all_columns