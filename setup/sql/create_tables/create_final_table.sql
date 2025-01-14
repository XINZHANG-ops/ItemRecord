--cluster guid
CREATE TABLE `{{ params.target_project }}.{{ params.target_dataset }}.LookUpCluster`
(
  CompanyGuid STRING,
  ColumnName STRING,
  ColumnValue STRING
)
CLUSTER BY CompanyGuid;
