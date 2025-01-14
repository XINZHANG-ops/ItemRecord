CREATE TEMP FUNCTION f_ExecutionTimeStamp() RETURNS TIMESTAMP AS ('{{ ds }}');
CREATE TEMP FUNCTION f_ExecutionDate() RETURNS DATE AS ('{{ ds }}');

WITH all_columns AS (
  SELECT
      DISTINCT
      CompanyGuid
    , 'LatestVehicleMetadata.DeviceId' AS ColumnName 
    , DeviceId AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.LatestVehicleMetadata }}.LatestVehicleMetadata`
  WHERE DeviceId IS NOT NULL

UNION ALL

  SELECT
      DISTINCT
      CompanyGuid
    , 'LatestVehicleMetadata.DeviceName' AS ColumnName 
    , DeviceName AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.LatestVehicleMetadata }}.LatestVehicleMetadata`
  WHERE DeviceName IS NOT NULL

UNION ALL

  SELECT
      DISTINCT
      CompanyGuid
    , 'LatestVehicleMetadata.Device_Health' AS ColumnName 
    , Device_Health AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.LatestVehicleMetadata }}.LatestVehicleMetadata`
  WHERE Device_Health IS NOT NULL

UNION ALL

  SELECT
      DISTINCT
      CompanyGuid
    , 'LatestVehicleMetadata.FuelType' AS ColumnName 
    , FuelType AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.LatestVehicleMetadata }}.LatestVehicleMetadata`
  WHERE FuelType IS NOT NULL

UNION ALL

  SELECT
      DISTINCT
      CompanyGuid
    , 'LatestVehicleMetadata.Manufacturer' AS ColumnName 
    , Manufacturer AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.LatestVehicleMetadata }}.LatestVehicleMetadata`
  WHERE Manufacturer IS NOT NULL

UNION ALL

  SELECT
      DISTINCT
      CompanyGuid
    , 'LatestVehicleMetadata.Model' AS ColumnName 
    , Model AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.LatestVehicleMetadata }}.LatestVehicleMetadata`
  WHERE Model IS NOT NULL

UNION ALL

  SELECT
      DISTINCT
      CompanyGuid
    , 'LatestVehicleMetadata.SerialNo' AS ColumnName 
    , SerialNo AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.LatestVehicleMetadata }}.LatestVehicleMetadata`
  WHERE SerialNo IS NOT NULL

UNION ALL

  SELECT
      DISTINCT
      CompanyGuid
    , 'LatestVehicleMetadata.VehicleType' AS ColumnName 
    , VehicleType AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.LatestVehicleMetadata }}.LatestVehicleMetadata`
  WHERE VehicleType IS NOT NULL

UNION ALL

  SELECT
      DISTINCT
      CompanyGuid
    , 'LatestVehicleMetadata.Vin' AS ColumnName 
    , Vin AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.LatestVehicleMetadata }}.LatestVehicleMetadata`
  WHERE Vin IS NOT NULL

UNION ALL

  SELECT
      DISTINCT
      CompanyGuid
    , 'LatestVehicleMetadata.VocationName' AS ColumnName 
    , VocationName AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.LatestVehicleMetadata }}.LatestVehicleMetadata`
  WHERE VocationName IS NOT NULL

UNION ALL

  SELECT
      DISTINCT
      CompanyGuid
    , 'LatestVehicleMetadata.Year' AS ColumnName 
    , Year AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.LatestVehicleMetadata }}.LatestVehicleMetadata`
  WHERE Year IS NOT NULL
) 
SELECT DISTINCT * from all_columns