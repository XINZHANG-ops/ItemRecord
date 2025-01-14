CREATE TEMP FUNCTION
f_ExecutionTimeStamp()
RETURNS TIMESTAMP AS ('{{ ds }}');

CREATE OR REPLACE TABLE `{{ params.target_project }}.{{ params.target_dataset }}.LookUpCluster`
CLUSTER BY CompanyGuid
AS
SELECT DISTINCT * FROM `{{ params.target_project }}.{{ params.target_dataset }}.LookUpRaw`
WHERE TIMESTAMP_TRUNC(_PARTITIONTIME, DAY) <= f_ExecutionTimeStamp();