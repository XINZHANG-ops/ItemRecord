CREATE TEMP FUNCTION f_ExecutionTimeStamp() RETURNS TIMESTAMP AS ('{{ ds }}');
CREATE TEMP FUNCTION f_ExecutionDate() RETURNS DATE AS ('{{ ds }}');

WITH all_columns AS (
  SELECT
      DISTINCT
      CompanyGuid
    , 'Zones.ZoneId' AS ColumnName 
    , ZoneId AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.Zones }}.Zones`
  WHERE ZoneId IS NOT NULL

UNION ALL

  SELECT
      DISTINCT
      CompanyGuid
    , 'Zones.ZoneName' AS ColumnName 
    , ZoneName AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.Zones }}.Zones`
  WHERE ZoneName IS NOT NULL

UNION ALL

  SELECT
      DISTINCT
      CompanyGuid
    , 'Zones.ZoneTypes' AS ColumnName 
    , ZoneTypes AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.Zones }}.Zones`
  WHERE ZoneTypes IS NOT NULL
) 
SELECT DISTINCT * from all_columns