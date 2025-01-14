CREATE TEMP FUNCTION f_ExecutionTimeStamp() RETURNS TIMESTAMP AS ('{{ ds }}');
CREATE TEMP FUNCTION f_ExecutionDate() RETURNS DATE AS ('{{ ds }}');

WITH all_columns AS (
  SELECT
      DISTINCT
      CompanyGuid
    , 'EVIdentification.Powertrain' AS ColumnName 
    , Powertrain AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.EVIdentification }}.EVIdentification`
  WHERE DATE(PartitionDate) BETWEEN f_ExecutionDate() AND f_ExecutionDate()
  AND Powertrain IS NOT NULL

UNION ALL

  SELECT
      DISTINCT
      CompanyGuid
    , 'EVIdentification.SerialNo' AS ColumnName 
    , SerialNo AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.EVIdentification }}.EVIdentification`
  WHERE DATE(PartitionDate) BETWEEN f_ExecutionDate() AND f_ExecutionDate()
  AND SerialNo IS NOT NULL

UNION ALL

  SELECT
      DISTINCT
      CompanyGuid
    , 'EVIdentification.VIN' AS ColumnName 
    , VIN AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.EVIdentification }}.EVIdentification`
  WHERE DATE(PartitionDate) BETWEEN f_ExecutionDate() AND f_ExecutionDate()
  AND VIN IS NOT NULL
) 
SELECT DISTINCT * from all_columns