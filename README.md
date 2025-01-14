# The reason why there is the sepreate dag for ca
since airflow do not have settings for ca, only us and eu, thus we need to put ca and us dag both under us.
but since the dag is named by repo name, thus we need to create a sepreate repo for ca.

# Start
run `python dag_pre_release.py` locally in the root dir
this will create the dataset and tables based on setup/sql
and first need to switch its region mannully under dag_pre_release.py for line 157 to do for us or eu

## TODO
add generate sql codes under this repo as well for easier maintenance. 

# write_to_gbq
This DAG is meant to serve as the standard template when initializing a new DAG. This new template implements several best practices not found in the current standard template, such as
- using sensors
- incorporating assertions via an ASSERT statement as well as via an Airflow check operator
- organizing tasks via TaskGroups
- parametrizing table names and emails through YAML files
- including documentation via the doc_md parameter
- creating tables and updating table metadata via a one-time setup script

## Useful Links

- [Airflow & DAG Best Practices and Standards doc](https://docs.google.com/document/d/1j-w94Ty4jXIkJnfD6lOLQRo0SFbSL1Pof-bM9X2oRNE/edit?usp=sharing)
- [Current standard DAG template](https://git.geotab.com/data-pipelines/templates/dna_dag_template)
### Automated Deployment
- [Automated Deployment Guide](https://git.geotab.com/data-pipelines/dataops_protected/dataops-runner-templates/-/tree/v1?ref_type=heads#user-guide)
- [Tutorial for refactoring existing projects for GitLab Runner](https://docs.google.com/presentation/d/1M24-nF3DbGJRHMdXa_PkNaodANGmxryh7Dy0mJ8sBaQ/edit?usp=drive_link)


