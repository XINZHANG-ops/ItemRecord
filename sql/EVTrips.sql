CREATE TEMP FUNCTION f_ExecutionTimeStamp() RETURNS TIMESTAMP AS ('{{ ds }}');
CREATE TEMP FUNCTION f_ExecutionDate() RETURNS DATE AS ('{{ ds }}');

WITH all_columns AS (
  SELECT
      DISTINCT
      CompanyGuid
    , 'EVTrips.Powertrain' AS ColumnName 
    , Powertrain AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.EVTrips }}.EVTrips`
  WHERE DATE(PipelineExecutionDate) BETWEEN f_ExecutionDate() AND f_ExecutionDate()
  AND Powertrain IS NOT NULL

UNION ALL

  SELECT
      DISTINCT
      CompanyGuid
    , 'EVTrips.Vin' AS ColumnName 
    , Vin AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.EVTrips }}.EVTrips`
  WHERE DATE(PipelineExecutionDate) BETWEEN f_ExecutionDate() AND f_ExecutionDate()
  AND Vin IS NOT NULL
) 
SELECT DISTINCT * from all_columns