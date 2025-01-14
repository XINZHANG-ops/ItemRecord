CREATE TEMP FUNCTION f_ExecutionTimeStamp() RETURNS TIMESTAMP AS ('{{ ds }}');
CREATE TEMP FUNCTION f_ExecutionDate() RETURNS DATE AS ('{{ ds }}');

WITH all_columns AS (
  SELECT
      DISTINCT
      CompanyGuid
    , 'VehicleKPI_Hourly.DeviceId' AS ColumnName 
    , DeviceId AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.VehicleKPI_Hourly }}.VehicleKPI_Hourly`
  WHERE TIMESTAMP_TRUNC(UTC_Hour, DAY) BETWEEN f_ExecutionTimeStamp() AND f_ExecutionTimeStamp()
  AND DeviceId IS NOT NULL

UNION ALL

  SELECT
      DISTINCT
      CompanyGuid
    , 'VehicleKPI_Hourly.Device_Health' AS ColumnName 
    , Device_Health AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.VehicleKPI_Hourly }}.VehicleKPI_Hourly`
  WHERE TIMESTAMP_TRUNC(UTC_Hour, DAY) BETWEEN f_ExecutionTimeStamp() AND f_ExecutionTimeStamp()
  AND Device_Health IS NOT NULL

UNION ALL

  SELECT
      DISTINCT
      CompanyGuid
    , 'VehicleKPI_Hourly.SerialNo' AS ColumnName 
    , SerialNo AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.VehicleKPI_Hourly }}.VehicleKPI_Hourly`
  WHERE TIMESTAMP_TRUNC(UTC_Hour, DAY) BETWEEN f_ExecutionTimeStamp() AND f_ExecutionTimeStamp()
  AND SerialNo IS NOT NULL

UNION ALL

  SELECT
      DISTINCT
      CompanyGuid
    , 'VehicleKPI_Hourly.Vin' AS ColumnName 
    , Vin AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.VehicleKPI_Hourly }}.VehicleKPI_Hourly`
  WHERE TIMESTAMP_TRUNC(UTC_Hour, DAY) BETWEEN f_ExecutionTimeStamp() AND f_ExecutionTimeStamp()
  AND Vin IS NOT NULL
) 
SELECT DISTINCT * from all_columns