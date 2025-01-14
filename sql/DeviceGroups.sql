CREATE TEMP FUNCTION f_ExecutionTimeStamp() RETURNS TIMESTAMP AS ('{{ ds }}');
CREATE TEMP FUNCTION f_ExecutionDate() RETURNS DATE AS ('{{ ds }}');

WITH all_columns AS (
  SELECT
      DISTINCT
      CompanyGuid
    , 'DeviceGroups.DeviceId' AS ColumnName 
    , DeviceId AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.DeviceGroups }}.DeviceGroups`
  WHERE DeviceId IS NOT NULL

UNION ALL

  SELECT
      DISTINCT
      CompanyGuid
    , 'DeviceGroups.GroupId' AS ColumnName 
    , GroupId AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.DeviceGroups }}.DeviceGroups`
  WHERE GroupId IS NOT NULL

UNION ALL

  SELECT
      DISTINCT
      CompanyGuid
    , 'DeviceGroups.GroupName' AS ColumnName 
    , GroupName AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.DeviceGroups }}.DeviceGroups`
  WHERE GroupName IS NOT NULL

UNION ALL

  SELECT
      DISTINCT
      CompanyGuid
    , 'DeviceGroups.SerialNo' AS ColumnName 
    , SerialNo AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.DeviceGroups }}.DeviceGroups`
  WHERE SerialNo IS NOT NULL
) 
SELECT DISTINCT * from all_columns