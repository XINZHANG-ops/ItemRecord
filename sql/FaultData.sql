CREATE TEMP FUNCTION f_ExecutionTimeStamp() RETURNS TIMESTAMP AS ('{{ ds }}');
CREATE TEMP FUNCTION f_ExecutionDate() RETURNS DATE AS ('{{ ds }}');

WITH all_columns AS (
  SELECT
      DISTINCT
      CompanyGuid
    , 'FaultData.DeviceId' AS ColumnName 
    , DeviceId AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.FaultData }}.FaultData`
  WHERE TIMESTAMP_TRUNC(StreamDateTime, DAY) BETWEEN f_ExecutionTimeStamp() AND f_ExecutionTimeStamp()
  AND DeviceId IS NOT NULL

UNION ALL

  SELECT
      DISTINCT
      CompanyGuid
    , 'FaultData.DiagnosticId' AS ColumnName 
    , DiagnosticId AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.FaultData }}.FaultData`
  WHERE TIMESTAMP_TRUNC(StreamDateTime, DAY) BETWEEN f_ExecutionTimeStamp() AND f_ExecutionTimeStamp()
  AND DiagnosticId IS NOT NULL
) 
SELECT DISTINCT * from all_columns