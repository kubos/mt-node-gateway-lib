const { Buffer } = require('buffer');
const WebSocket = require('websocket').w3cwebsocket;
const { command_update_fields } = require('./constants');

function major_tom_ws_channel({
  full_ws_url,
  on_got_inbound,
  on_got_outbound,
  post_message,
  receive_inbound,
  set_wait_time,
  trigger_inbound,
  wait_pause,
}) {
  // Define internal variables
  let handshook = false;
  let is_cx = false;
  let url = full_ws_url || '';
  let token;
  let channel_socket;
  let handle_message_from_mt;

  function connect() {
    try_connection();
  }

  function set_gateway_url(passed) {
    if (!passed && url && token) return;

    try {
      const match = new URL(passed || url);

      url = match.href;
      token = match.searchParams.get('gateway_token');
    } catch (err) {
      post_message(err, 'Could not set gateway url');
    }
  }

  function set_gateway_token(new_token) {
    token = new_token;
  }

  function send(str) {
    post_message(str);
  }

  function send_command_update(cmd_update) {
    const is_plain_object = typeof cmd_update === 'object' && !Array.isArray(cmd_update);
    const has_id = !Number.isNaN(Number(cmd_update.id));
    const has_udpate_field = !!command_update_fields.find(function(field) {
      return cmd_update[field];
    });

    if (is_plain_object && has_id && has_udpate_field) {
      return post_message({
        type: 'command_update',
        command: { ...cmd_update },
      });
    }

    return post_message(
      new Error(
        'Method send_command_update requires an object with an id and at least one updated field'
      )
    );
  }

  function send_events(events) {
    send_of_type('events')(events);
  }

  function send_measurements(measurements) {
    send_of_type('measurements')(measurements);
  }

  function send_file_list(file_list) {
    if (typeof file_list === 'string') {
      try {
        const parsed = JSON.parse(file_list);

        if (typeof parsed === 'object') {
          if (parsed.type === 'file_list') {
            return post_message(file_list);
          }

          return post_message({
            type: 'file_list',
            file_list: parsed,
          })
        }

        return post_message(file_list);
      } catch (e) {
        return post_message(e, `Could not understand sent file_list string ${file_list}`);
      }
    }

    if (file_list.type === 'file_list') {
      return post_message(file_list);
    }

    return post_message({
      type: 'file_list',
      file_list,
    });
  }

  function send_file_metadata(metadata) {
    if (typeof metadata === 'string') {
      try {
        const parsed = JSON.parse(metadata);

        if (parsed.type === 'file_metadata_update') {
          return post_message(metadata);
        }

        return post_message({
          type: 'file_metadata_update',
          downlinked_file: metadata,
        });
      } catch (e) {
        return mt_q.write(`Could not understand sent file_metadata_update string ${metadata}`, e);
      }
    }

    if (metadata.type === 'file_metadata_update') {
      return post_message(metadata);
    }

    return post_message({
      type: 'file_metadata_update',
      downlinked_file: metadata,
    });
  }

  function send_command_defs(definitions) {
    if (typeof definitions === 'string') {
      try {
        const parsed = JSON.parse(definitions);

        if (parsed.type === 'command_definitions_update') {
          return post_message(definitions);
        }

        return post_message({
          type: 'command_definitions_update',
          command_definitions: definitions,
        })
      } catch (e) {
        return mt_q.write(
          `Could not understand sent command_definitions string ${definitions}`,
          e
        );
      }
    }

    if (definitions.type === 'command_definitions_update') {
      return post_message(definitions);
    }

    return post_message({
      type: 'command_definitions_update',
      command_definitions: definitions,
    });
  }

  function is_connected() {
    return is_cx;
  }

  function on_message_from_mt(cb) {
    if (typeof cb !== 'function') {
      post_message(new Error('Message handler for message from Major Tom must be a function'));
    }

    handle_message_from_mt = cb;
    trigger_inbound();
  }

  function close() {
    if (channel_socket) {
      channel_socket.close();
    }
  }

  // Define internal functions
  function try_connection() {
    if (is_cx) {
      post_message('Connection attempted but gateway is already connected to Major Tom');
    } else if (url_is_complete()) {
      setup_channel_socket();
    } else {
      post_message(
        `Connection attempted but missing ${url || token ? (url && 'token') || 'url' : 'url and token'} `
      );
    }
  }

  function send_of_type(type) {
    return function(received) {
      if (typeof received === 'string') {
        // If we receive a string, we make a series of three evaluations & assumptions:
        // 1. If it parses to an object with a `received` property, we send the string we received.
        // 2. If it parses to an Array, we assume we got a JSON string of received, and wrap those
        //    in an object with a type: received property.
        // 3. If we got anything else really, we assume that it's a single measurement object, and put
        //    it into an array under the received prop of a formatted received object.
        try {
          const parsed = JSON.parse(received);

          if (parsed.type === type) {
            return post_message(received);
          }

          if (Array.isArray(parsed)) {
            return post_message({
              [type]: parsed,
              type,
            });
          }

          return post_message({
            [type]: [parsed],
            type,
          });
        } catch (error) {
          return post_message(error, `Could not understand sent ${type} string ${received}`);
        }
      }

      if (Array.isArray(received)) {
        return post_message({
          [type]: received,
          type,
        });
      }

      if (typeof received === 'object' && received.type === type) {
        return post_message(received);
      }

      return post_message(
        `Method send_${type} is specifically to send ${type} to Major Tom`,
        `Method send_${type} received a ${type} argument that was not in any expected format`
      );
    };
  }

  function url_is_complete() {
    set_gateway_url();

    return !!url && !!token;
  }

  function get_url() {
    return `${url}`;
  }

  function handle_rate_limit(data) {
    const { rate_limit } = data;
    const { rate, retry_after } = rate_limit;

    set_wait_time(rate);
    wait_pause(retry_after);

    post_message(
      new Error(`Major Tom rate limit exceeded: throttling to ${rate} messages per minute after waiting ${retry_after} seconds.`),
      'If you continue receiving these messages check your gateway settings'
    );
  }

  function receive_message_from_mt(message) {
    if (!handshook) {
      if (message.type !== 'hello') {
        post_message(
          new Error('Gateway is receiving messages from Major Tom but did not receive a handshake message.'),
          'Check connection and try re-starting the gateway connection; it appears a message may have been missed'
        );
      } else {
        handshook = true;
      }
    }

    if (message.type === 'rate_limit') {
      handle_rate_limit(message);
    }

    if (handle_message_from_mt) {
      return handle_message_from_mt(message);
    }

    post_message(message);
  }

  function setup_channel_socket() {
    if (channel_socket) {
      channel_socket.onmessage = channel_socket.onerror = channel_socket.onclose = null;
    }

    channel_socket = new WebSocket(get_url());

    is_cx = true;

    channel_socket.onmessage = function (inbound_msg) {
      receive_inbound(inbound_msg.data);
    };

    channel_socket.onerror = function(error) {
      is_cx = false;
      post_message(error, 'Channel socket connection experienced an error');
    };

    channel_socket.onclose = function (close_message) {
      is_cx = false;

      post_message(close_message, 'Channel socket connection was closed');

      // Wait 30 seconds on close to see if this was a remote restart
      setTimeout(try_connection, 30000);
    };

    on_got_outbound(function () {
      if (!is_cx) return false;

      return data => {
        let message_for_mt;

        if (data instanceof Buffer) {
          message_for_mt = data.toString();
        }

        channel_socket.send(message_for_mt || data);
      };
    });

    on_got_inbound(function () {
      return receive_message_from_mt;
    });
  }

  // Attempt to connect automatically if the invoked url has all needed elements
  if (url_is_complete()) {
    try_connection();
  }

  return {
    close,
    connect,
    set_gateway_url,
    set_gateway_token,
    send,
    send_command_update,
    send_measurements,
    send_events,
    send_command_defs,
    send_file_list,
    send_file_metadata,
    on_message_from_mt,
    is_connected,
  };
}

module.exports = major_tom_ws_channel;
