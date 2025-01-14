import os
import sys
import yaml
import airflow
import datetime
from typing import Dict
from pathlib import Path
from airflow.providers.google.cloud.operators.bigquery import (
    BigQueryInsertJobOperator
)
# from airflow.operators.dummy_operator import DummyOperator


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.append(SCRIPT_DIR)
dag_id = SCRIPT_DIR.split("/")[-1]


################
# Versioning
status_pipeline_version = 'v0.1.1'
status_model_version = '0.1.0'

def get_meta():
    os.path.splitext(os.path.basename(__file__))[0]
    op_region = os.environ["WOP_REGION"]
    op_stage = os.environ["WOP_STAGE"]
    op_regulation = os.getenv("WOP_REGULATION", 'commercial')
    return (op_region, op_stage, op_regulation)

def load_config(wop_region: str, wop_stage: str, wop_regulation: str) -> Dict:
    dag_file = Path(__file__)
    file_yaml = None
    if wop_regulation == "fedramp" and wop_region == "us":
        file_yaml = f"regional_config/region_{wop_region}_fedramp_{wop_stage}.yaml"  # noqa:F841
    else:
        file_yaml = f"regional_config/region_{wop_region}_{wop_stage}.yaml"
    with open(dag_file.parents[0] / file_yaml, "r") as f:
        return yaml.safe_load(f)

def main():
    op_region, op_stage, op_regulation = get_meta()
    params = load_config(op_region, op_stage, op_regulation)
    params["wop_region"] = op_region
    params["wop_stage"] = op_stage
    params["op_regulation"] = op_regulation
    doc_md = """
    **Author**: Xin Zhang
    **Email**: xinzhang@geotab.com
    **Purpose**: Create a lookup version for each table for ACE to lookup value columns  # noqa: E501

    The following metadata was generated automatically by
    [GitLab CI/CD](https://docs.gitlab.com/ee/ci/variables/predefined_variables.html):  # noqa: E501

    """.replace(
        "    ", ""
    ).strip()  # noqa e501
    # {load_gitlab_metadata('project-metadata.json')}

    dag_args = {
        'dag_id': dag_id,
        'doc_md': doc_md,
        'schedule_interval': '0 0 * * *',
        'max_active_runs': 1,
        'dagrun_timeout': datetime.timedelta(
            minutes=12*60
        ),  # datetime.timedelta(minutes=5 * 60),
        'template_searchpath': [f'/home/airflow/gcs/dags/{dag_id}/'],
        'catchup': True,
        'params': params,
        # Operators
        'default_args': {
            'start_date': datetime.datetime(2024, 1, 1),
            'owner': 'Ace Team, Xin Zhang',
            'email': params['email'],
            'depends_on_past': False,
            'retries': 1,
            'retry_delay': datetime.timedelta(seconds=300),
            'email_on_failure': True,
            'email_on_retry': False,
            # BigQueryOperator
            'write_disposition': 'WRITE_TRUNCATE',
            "use_legacy_sql": False,
            'priority': 'BATCH',  # INTERACTIVE
            'time_partitioning': {'type': 'DAY'}
            # 'end_date': datetime.datetime(2022, 12, 31)
        },
    }
    # dag_args = if_backfill_update(dag_args, "backfill.yaml")
    create_dag(dag_args)

def create_dag(dag_args):
    day_delay = 0
    ds_new = f"{{{{(execution_date - macros.dateutil.relativedelta.relativedelta(days={day_delay})).strftime('%Y%m%d')}}}}"  # noqa: E501
    
    op_region, op_stage, op_regulation = get_meta()
    data = load_config(op_region, op_stage, op_regulation)
    with airflow.DAG(**dag_args) as dag:
        # dummy_start = DummyOperator(task_id='start')
        # dummy_end = DummyOperator(task_id='end')
        all_tables = sorted(list(data['sources_tables'].keys()))
        jobs = [
            BigQueryInsertJobOperator(
            task_id=table,
            configuration={
                'query': {
                    'query': f'{{% include "sql/{table}.sql" %}}', 
                    'destinationTable': {
                        'projectId': "{{ params.target_project }}",
                        'datasetId': "{{ params.target_dataset }}",
                        'tableId': f"{table}${ds_new}",
                        # 'tableId': f"{table}",
                    },
                    'useLegacySql': False,
                    'writeDisposition': 'WRITE_TRUNCATE',
                }
            },
        )
            for table in all_tables
        ]
        join_job = BigQueryInsertJobOperator(
            task_id="combine_all_tables",
            configuration={
                'query': {
                    'query': '{% include "sql/LookUpRaw.sql" %}', 
                    'destinationTable': {
                        'projectId': "{{ params.target_project }}",
                        'datasetId': "{{ params.target_dataset }}",
                        'tableId': f"LookUpRaw${ds_new}",
                        # 'tableId': "LookUpRaw",
                    },
                    'useLegacySql': False,
                    'writeDisposition': 'WRITE_TRUNCATE',
                }
            },
        )

        cluster_job = BigQueryInsertJobOperator(
            task_id="cluster_guid",
            configuration={
                'query': {
                    'query': '{% include "sql/LookUpCluster.sql" %}',
                    'useLegacySql': False
                }
            }
        )
        
        
        # DAG Structure
        jobs >> join_job >> cluster_job
    globals()[dag.dag_id] = dag  # keep this

main()  # keep this
