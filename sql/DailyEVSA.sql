CREATE TEMP FUNCTION f_ExecutionTimeStamp() RETURNS TIMESTAMP AS ('{{ ds }}');
CREATE TEMP FUNCTION f_ExecutionDate() RETURNS DATE AS ('{{ ds }}');

WITH all_columns AS (
  SELECT
      DISTINCT
      CompanyGuid
    , 'DailyEVSA.VehicleType' AS ColumnName 
    , VehicleType AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.DailyEVSA }}.DailyEVSA`
  WHERE DATE(LocalDate) BETWEEN f_ExecutionDate() AND f_ExecutionDate()
  AND VehicleType IS NOT NULL

UNION ALL

  SELECT
      DISTINCT
      CompanyGuid
    , 'DailyEVSA.Vin' AS ColumnName 
    , Vin AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.DailyEVSA }}.DailyEVSA`
  WHERE DATE(LocalDate) BETWEEN f_ExecutionDate() AND f_ExecutionDate()
  AND Vin IS NOT NULL
) 
SELECT DISTINCT * from all_columns