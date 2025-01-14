CREATE TEMP FUNCTION f_ExecutionTimeStamp() RETURNS TIMESTAMP AS ('{{ ds }}');
CREATE TEMP FUNCTION f_ExecutionDate() RETURNS DATE AS ('{{ ds }}');

WITH all_columns AS (
  SELECT
      DISTINCT
      CompanyGuid
    , 'MaintenanceIssues_Daily.DeviceId' AS ColumnName 
    , DeviceId AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.MaintenanceIssues_Daily }}.MaintenanceIssues_Daily`
  WHERE DATE(UTC_Date) BETWEEN f_ExecutionDate() AND f_ExecutionDate()
  AND DeviceId IS NOT NULL

UNION ALL

  SELECT
      DISTINCT
      CompanyGuid
    , 'MaintenanceIssues_Daily.IssueType' AS ColumnName 
    , IssueType AS ColumnValue 
  FROM `{{ params.source_project }}.{{ params.sources_tables.MaintenanceIssues_Daily }}.MaintenanceIssues_Daily`
  WHERE DATE(UTC_Date) BETWEEN f_ExecutionDate() AND f_ExecutionDate()
  AND IssueType IS NOT NULL
) 
SELECT DISTINCT * from all_columns