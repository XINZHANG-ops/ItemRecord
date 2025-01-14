CREATE TEMP FUNCTION f_ExecutionTimeStamp() RETURNS TIMESTAMP AS ('{{ ds }}');
CREATE TEMP FUNCTION f_ExecutionDate() RETURNS DATE AS ('{{ ds }}');

WITH all_columns AS (
  SELECT
      DISTINCT
      CompanyGuid
    , 'FleetSafety_Daily.ClusterDescription' AS ColumnName 
    , ClusterDescription AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.FleetSafety_Daily }}.FleetSafety_Daily`
  WHERE DATE(UTC_Date) BETWEEN f_ExecutionDate() AND f_ExecutionDate()
  AND ClusterDescription IS NOT NULL
) 
SELECT DISTINCT * from all_columns