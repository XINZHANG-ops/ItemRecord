CREATE SCHEMA IF NOT EXISTS `{{ params.target_project }}.{{ params.target_dataset }}`
  OPTIONS (
    description = 'The dataset of lookup tables for ACE.',
    labels = [("clearance","2"), ("classification", "int"), ("zone", "{{ params.zone }}")],
    location = '{{ params.op_region }}');
