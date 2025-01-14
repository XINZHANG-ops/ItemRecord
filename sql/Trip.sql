CREATE TEMP FUNCTION f_ExecutionTimeStamp() RETURNS TIMESTAMP AS ('{{ ds }}');
CREATE TEMP FUNCTION f_ExecutionDate() RETURNS DATE AS ('{{ ds }}');

WITH all_columns AS (
  SELECT
      DISTINCT
      CompanyGuid
    , 'Trip.DeviceId' AS ColumnName 
    , DeviceId AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.Trip }}.Trip`
  WHERE TIMESTAMP_TRUNC(Start, DAY) BETWEEN f_ExecutionTimeStamp() AND f_ExecutionTimeStamp()
  AND DeviceId IS NOT NULL

UNION ALL

  SELECT
      DISTINCT
      CompanyGuid
    , 'Trip.DriverId' AS ColumnName 
    , DriverId AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.Trip }}.Trip`
  WHERE TIMESTAMP_TRUNC(Start, DAY) BETWEEN f_ExecutionTimeStamp() AND f_ExecutionTimeStamp()
  AND DriverId IS NOT NULL
) 
SELECT DISTINCT * from all_columns