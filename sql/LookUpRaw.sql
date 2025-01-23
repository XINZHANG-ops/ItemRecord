CREATE TEMP FUNCTION
f_ExecutionTimeStamp()
RETURNS TIMESTAMP AS ('{{ ds }}');

WITH t_all_tables AS (
  SELECT CompanyGuid, ColumnName, ColumnValue 
    FROM `{{ params.target_project }}.{{ params.target_dataset }}.Diagnostic`
    WHERE TIMESTAMP_TRUNC(_PARTITIONTIME, DAY) = f_ExecutionTimeStamp()
UNION ALL 
  SELECT CompanyGuid, ColumnName, ColumnValue 
    FROM `{{ params.target_project }}.{{ params.target_dataset }}.DeviceGroups`
    WHERE TIMESTAMP_TRUNC(_PARTITIONTIME, DAY) = f_ExecutionTimeStamp()
UNION ALL 
  SELECT CompanyGuid, ColumnName, ColumnValue 
    FROM `{{ params.target_project }}.{{ params.target_dataset }}.FleetSafety_Daily`
    WHERE TIMESTAMP_TRUNC(_PARTITIONTIME, DAY) = f_ExecutionTimeStamp()
UNION ALL 
  SELECT CompanyGuid, ColumnName, ColumnValue 
    FROM `{{ params.target_project }}.{{ params.target_dataset }}.LatestVehicleMetadata`
    WHERE TIMESTAMP_TRUNC(_PARTITIONTIME, DAY) = f_ExecutionTimeStamp()
UNION ALL 
  SELECT CompanyGuid, ColumnName, ColumnValue 
    FROM `{{ params.target_project }}.{{ params.target_dataset }}.MaintenanceIssues_Daily`
    WHERE TIMESTAMP_TRUNC(_PARTITIONTIME, DAY) = f_ExecutionTimeStamp()
UNION ALL 
  SELECT CompanyGuid, ColumnName, ColumnValue 
    FROM `{{ params.target_project }}.{{ params.target_dataset }}.VehicleKPI_Daily`
    WHERE TIMESTAMP_TRUNC(_PARTITIONTIME, DAY) = f_ExecutionTimeStamp()
UNION ALL 
  SELECT CompanyGuid, ColumnName, ColumnValue 
    FROM `{{ params.target_project }}.{{ params.target_dataset }}.VehicleKPI_Hourly`
    WHERE TIMESTAMP_TRUNC(_PARTITIONTIME, DAY) = f_ExecutionTimeStamp()
UNION ALL 
  SELECT CompanyGuid, ColumnName, ColumnValue 
    FROM `{{ params.target_project }}.{{ params.target_dataset }}.VehicleSafety_Daily`
    WHERE TIMESTAMP_TRUNC(_PARTITIONTIME, DAY) = f_ExecutionTimeStamp()
UNION ALL 
  SELECT CompanyGuid, ColumnName, ColumnValue 
    FROM `{{ params.target_project }}.{{ params.target_dataset }}.DailyEVSA`
    WHERE TIMESTAMP_TRUNC(_PARTITIONTIME, DAY) = f_ExecutionTimeStamp()
UNION ALL 
  SELECT CompanyGuid, ColumnName, ColumnValue 
    FROM `{{ params.target_project }}.{{ params.target_dataset }}.EVChargeWindows`
    WHERE TIMESTAMP_TRUNC(_PARTITIONTIME, DAY) = f_ExecutionTimeStamp()
UNION ALL 
  SELECT CompanyGuid, ColumnName, ColumnValue 
    FROM `{{ params.target_project }}.{{ params.target_dataset }}.EVCharges`
    WHERE TIMESTAMP_TRUNC(_PARTITIONTIME, DAY) = f_ExecutionTimeStamp()
UNION ALL 
  SELECT CompanyGuid, ColumnName, ColumnValue 
    FROM `{{ params.target_project }}.{{ params.target_dataset }}.EVIdentification`
    WHERE TIMESTAMP_TRUNC(_PARTITIONTIME, DAY) = f_ExecutionTimeStamp()
UNION ALL 
  SELECT CompanyGuid, ColumnName, ColumnValue 
    FROM `{{ params.target_project }}.{{ params.target_dataset }}.EVTrips`
    WHERE TIMESTAMP_TRUNC(_PARTITIONTIME, DAY) = f_ExecutionTimeStamp()
UNION ALL 
  SELECT CompanyGuid, ColumnName, ColumnValue 
    FROM `{{ params.target_project }}.{{ params.target_dataset }}.Exceptions`
    WHERE TIMESTAMP_TRUNC(_PARTITIONTIME, DAY) = f_ExecutionTimeStamp()
UNION ALL 
  SELECT CompanyGuid, ColumnName, ColumnValue 
    FROM `{{ params.target_project }}.{{ params.target_dataset }}.FaultData`
    WHERE TIMESTAMP_TRUNC(_PARTITIONTIME, DAY) = f_ExecutionTimeStamp()
UNION ALL 
  SELECT CompanyGuid, ColumnName, ColumnValue 
    FROM `{{ params.target_project }}.{{ params.target_dataset }}.GpsLogs`
    WHERE TIMESTAMP_TRUNC(_PARTITIONTIME, DAY) = f_ExecutionTimeStamp()
UNION ALL 
  SELECT CompanyGuid, ColumnName, ColumnValue 
    FROM `{{ params.target_project }}.{{ params.target_dataset }}.Rule`
    WHERE TIMESTAMP_TRUNC(_PARTITIONTIME, DAY) = f_ExecutionTimeStamp()
UNION ALL 
  SELECT CompanyGuid, ColumnName, ColumnValue 
    FROM `{{ params.target_project }}.{{ params.target_dataset }}.StatusData`
    WHERE TIMESTAMP_TRUNC(_PARTITIONTIME, DAY) = f_ExecutionTimeStamp()
UNION ALL 
  SELECT CompanyGuid, ColumnName, ColumnValue 
    FROM `{{ params.target_project }}.{{ params.target_dataset }}.Trip`
    WHERE TIMESTAMP_TRUNC(_PARTITIONTIME, DAY) = f_ExecutionTimeStamp()
UNION ALL 
  SELECT CompanyGuid, ColumnName, ColumnValue 
    FROM `{{ params.target_project }}.{{ params.target_dataset }}.Zones`
    WHERE TIMESTAMP_TRUNC(_PARTITIONTIME, DAY) = f_ExecutionTimeStamp()

)

, incoming_data AS (
    SELECT DISTINCT CompanyGuid, ColumnName, ColumnValue FROM t_all_tables
)

, previous_data AS (
    SELECT CompanyGuid, ColumnName, ColumnValue 
    FROM `{{ params.target_project }}.{{ params.target_dataset }}.LookUpRaw`
    WHERE TIMESTAMP_TRUNC(_PARTITIONTIME, DAY) <= f_ExecutionTimeStamp()
)

SELECT CompanyGuid, ColumnName, ColumnValue
  FROM incoming_data
EXCEPT DISTINCT
SELECT CompanyGuid, ColumnName, ColumnValue
  FROM previous_data;