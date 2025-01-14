CREATE TEMP FUNCTION f_ExecutionTimeStamp() RETURNS TIMESTAMP AS ('{{ ds }}');
CREATE TEMP FUNCTION f_ExecutionDate() RETURNS DATE AS ('{{ ds }}');

WITH all_columns AS (
  SELECT
      DISTINCT
      CompanyGuid
    , 'StatusData.DeviceId' AS ColumnName 
    , DeviceId AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.StatusData }}.StatusData`
  WHERE TIMESTAMP_TRUNC(DateTime, DAY) BETWEEN f_ExecutionTimeStamp() AND f_ExecutionTimeStamp()
  AND DeviceId IS NOT NULL

UNION ALL

  SELECT
      DISTINCT
      CompanyGuid
    , 'StatusData.DiagnosticId' AS ColumnName 
    , DiagnosticId AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.StatusData }}.StatusData`
  WHERE TIMESTAMP_TRUNC(DateTime, DAY) BETWEEN f_ExecutionTimeStamp() AND f_ExecutionTimeStamp()
  AND DiagnosticId IS NOT NULL
) 
SELECT DISTINCT * from all_columns