CREATE TEMP FUNCTION f_ExecutionTimeStamp() RETURNS TIMESTAMP AS ('{{ ds }}');
CREATE TEMP FUNCTION f_ExecutionDate() RETURNS DATE AS ('{{ ds }}');

WITH all_columns AS (
  SELECT
      DISTINCT
      CompanyGuid
    , 'EVCharges.Powertrain' AS ColumnName 
    , Powertrain AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.EVCharges }}.EVCharges`
  WHERE TIMESTAMP_TRUNC(ChargeStartTime, DAY) BETWEEN f_ExecutionTimeStamp() AND f_ExecutionTimeStamp()
  AND Powertrain IS NOT NULL

UNION ALL

  SELECT
      DISTINCT
      CompanyGuid
    , 'EVCharges.VIN' AS ColumnName 
    , VIN AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.EVCharges }}.EVCharges`
  WHERE TIMESTAMP_TRUNC(ChargeStartTime, DAY) BETWEEN f_ExecutionTimeStamp() AND f_ExecutionTimeStamp()
  AND VIN IS NOT NULL
) 
SELECT DISTINCT * from all_columns