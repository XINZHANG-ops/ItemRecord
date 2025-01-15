import yaml
from pathlib import Path
from google.cloud import bigquery
import os
from jinja2 import Environment, FileSystemLoader


class SqlTemplate:
    def __init__(self, sql_file, bq_client, params, setup_scripts_directory):
        """Initiates variables

        Args:
            sql_file (str): absolute file path
            bq_client (_type_): BQ client object
            params (_type_): json config for rendering SQL files
        """
        self.sql_file = sql_file
        self.bq_client = bq_client
        self.params = params
        self.setup_scripts_directory = setup_scripts_directory

    # Template and release
    def generate_template(self, **kwargs):
        """Generates rendered sql by substituting jinja variables and/or expressions

        Returns:
            str: rendered sql file
        """
        if self.sql_file == "" or self.sql_file is None:
            raise Exception("Invalid sql path")

        filename = os.path.basename(self.sql_file)
        parent = os.path.dirname(self.sql_file)
        file_loader = FileSystemLoader(parent)
        env = Environment(loader=file_loader)

        template = env.get_template(filename)
        params = {**self.params, **kwargs}
        output = template.render(params=params)

        return output

    # Deploy to BQ
    def execute(self, dry_run: bool = False, **kwargs):
        """Executes sql statment on BigQuery

        Returns:
            RowIterator: RowIterator
        """
        sql = self.generate_template(**kwargs)
        if dry_run:
            print(sql)
            print('-'*50)
        else:
            job = self.bq_client.query(sql)
            # wait for completion
            return job.result()

    def get_file_list(self):
        """Iterates recursively to find all sql files and returns file list in order:
            create_datasets, create_tables, create_views, update_tables

        Returns:
            PosixPath: List of files in the directory
        """

        file_list = []
        create_datasets_files = []
        create_table_files = []
        create_view_files = []
        update_files = []

        # add create datasets list at the top
        for file in self.setup_scripts_directory.rglob("*.sql"):
            if "create_dataset" in file.name:
                create_datasets_files.append(file.resolve())
            elif "create_table" in file.name:
                create_table_files.append(file.resolve())
            elif "create_view" in file.name:
                create_view_files.append(file.resolve())
            else:
                update_files.append(file.resolve())
        # file list in order
        # datasets -> Tables -> views -> update column, table metadata
        file_list = create_datasets_files
        file_list.extend(create_table_files)
        file_list.extend(create_view_files)
        file_list.extend(update_files)

        return file_list


def setup_tables(op_stage, op_region, op_regulation):
    """Renders and create data objects in BigQuery using regional configs

    Args:
        op_stage (str): This provides environment type, either production or staging
        op_region (str): This porvides region info where data resides
        op_regulation (str): This provides whether the dag is running in commercial or FedRAMP
    """  # noqa: E501
    current_directory = Path(__file__).parent.resolve()
    params = {}
    if op_region.lower() == 'northamerica-northeast1':
        file_op_region = 'ca'
    else:
        file_op_region = op_region
    if op_regulation == "fedramp":
        file_yaml = f"region_{file_op_region}_fedramp_{op_stage}.yaml"
        # queries will run against this project
        params['project'] = (
            'geotab-fedramp-dna-test' if op_stage == 'staging' else ''
        )  # prod project
    else:
        file_yaml = f"region_{file_op_region}_{op_stage}.yaml"
        # queries will run against this project
        params['project'] = (
            'geotab-dna-test' if op_stage == 'staging' else 'geotab-dna-prod'
        )

    absolute_file_path = current_directory / "regional_config" / file_yaml
    with open(absolute_file_path, "r") as f:
        config = yaml.safe_load(f)

    params = {**params, **config}
    params["dag_id"] = "genai_column_lookup"
    params["op_region"] = op_region
    params["op_stage"] = op_stage
    params['op_regulation'] = op_regulation

    with bigquery.Client(project=params['project'], location=wop_region) as client:
        # absolute path to setup script
        setup_scripts_directory = current_directory / "setup"

        # dummy file for obj creation
        file_path = ""

        # get SQLTemplate
        custom_sql_templater = SqlTemplate(
            file_path, client, params, setup_scripts_directory
        )

        # get file list in order
        current_working_directory = custom_sql_templater.get_file_list()

        # for template_file in setup_scripts_directory.rglob('create_table.sql'):
        for template_file in current_working_directory:
            print(template_file)
            # update file path with actual file
            custom_sql_templater.sql_file = template_file
            if "dataset" in str(template_file):
                # create the dataset
                templated_sql = custom_sql_templater.generate_template()
                # run scripts in BQ
                job_result = custom_sql_templater.execute(dry_run=True)
                print(job_result)
            elif "intermediate" in str(template_file):
                # create intermediate tables
                intermediate_tables = list(params['sources_tables'].keys()) + ['LookUpRaw']
                for table_name in intermediate_tables:
                    templated_sql = custom_sql_templater.generate_template(dry_run=True,table_name=table_name)
                    job_result = custom_sql_templater.execute(table_name=table_name)
                    print(job_result)
            else:
                # create final lookup table
                templated_sql = custom_sql_templater.generate_template()
                # run scripts in BQ
                job_result = custom_sql_templater.execute(dry_run=True)
                print(job_result)



if __name__ == "__main__":

    # get region, stage from env variables
    wop_region = os.getenv('WOP_REGION')
    wop_region = "us" # us, eu, northamerica-northeast1

    wop_stage = os.getenv('WOP_STAGE')
    wop_stage = "staging"

    wop_regulation = os.getenv('WOP_REGULATION')
    wop_regulation = "COMMERCIAL"

    if wop_region and wop_stage and wop_regulation:
        setup_tables(
            op_stage=wop_stage, op_region=wop_region, op_regulation=wop_regulation
        )
    else:
        print('check op variables ')
