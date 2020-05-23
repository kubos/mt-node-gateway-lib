const ONE_SECOND = 1000;
const ONE_MINUTE = 60 * ONE_SECOND;


const mt_outbound_types = {
  command_update: true,
  measurements: true,
  event: true,
  command_definitions_update: true,
  file_list: true,
  file_metadata_update: true,
};

const command_update_fields = [
  'state', 'payload', 'status', 'output', 'errors',
  'progress_1_current', 'progress_1_max', 'progress_1_label',
  'progress_2_current', 'progress_2_max', 'progress_2_label',
];

module.exports = {
  ONE_MINUTE,
  ONE_SECOND,
  command_update_fields,
  mt_outbound_types,
};
