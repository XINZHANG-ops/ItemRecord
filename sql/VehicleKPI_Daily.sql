CREATE TEMP FUNCTION f_ExecutionTimeStamp() RETURNS TIMESTAMP AS ('{{ ds }}');
CREATE TEMP FUNCTION f_ExecutionDate() RETURNS DATE AS ('{{ ds }}');

WITH all_columns AS (
  SELECT
      DISTINCT
      CompanyGuid
    , 'VehicleKPI_Daily.DeviceId' AS ColumnName 
    , DeviceId AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.VehicleKPI_Daily }}.VehicleKPI_Daily`
  WHERE DATE(UTC_Date) BETWEEN f_ExecutionDate() AND f_ExecutionDate()
  AND DeviceId IS NOT NULL

UNION ALL

  SELECT
      DISTINCT
      CompanyGuid
    , 'VehicleKPI_Daily.Device_Health' AS ColumnName 
    , Device_Health AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.VehicleKPI_Daily }}.VehicleKPI_Daily`
  WHERE DATE(UTC_Date) BETWEEN f_ExecutionDate() AND f_ExecutionDate()
  AND Device_Health IS NOT NULL

UNION ALL

  SELECT
      DISTINCT
      CompanyGuid
    , 'VehicleKPI_Daily.SerialNo' AS ColumnName 
    , SerialNo AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.VehicleKPI_Daily }}.VehicleKPI_Daily`
  WHERE DATE(UTC_Date) BETWEEN f_ExecutionDate() AND f_ExecutionDate()
  AND SerialNo IS NOT NULL

UNION ALL

  SELECT
      DISTINCT
      CompanyGuid
    , 'VehicleKPI_Daily.Vin' AS ColumnName 
    , Vin AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.VehicleKPI_Daily }}.VehicleKPI_Daily`
  WHERE DATE(UTC_Date) BETWEEN f_ExecutionDate() AND f_ExecutionDate()
  AND Vin IS NOT NULL
) 
SELECT DISTINCT * from all_columns