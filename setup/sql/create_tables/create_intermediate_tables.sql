CREATE TABLE IF NOT EXISTS `{{ params.target_project }}.{{ params.target_dataset }}.{{ params.table_name }}`
  (
  CompanyGuid STRING OPTIONS(description="A universally unique id representing the database in mygeotab"),
  ColumnName STRING OPTIONS(description="The column name where the column value belongs to"),
  ColumnValue STRING OPTIONS(description="The original value of the column"),
)
PARTITION BY DATE(_PARTITIONTIME)
OPTIONS(
  require_partition_filter = FALSE,
 labels=[
    STRUCT("dag-owner", "planet-generative-ai"),
    STRUCT("frequency", "daily"), 
    STRUCT("classification", "int"), 
    STRUCT("dag_id","planet_lookup_entity"),
    STRUCT("clearance", "1")
    ]
);