const mt_ws_channel = require('./src/mt-ws-channel');
const mt_rest_channel = require('./src/mt-rest-channel');
const mt_system_channel = require('./src/mt-system-channel');
const mt_duplex = require('./src/major-tom-duplex');

const {
  on_got_inbound,
  on_got_internal,
  on_got_outbound,
  on_got_outbound_to_system,
  post_message,
  receive_inbound,
  set_wait_time,
  trigger_inbound,
  wait_pause,
} = mt_duplex();


function mt_node_gateway() {
  let ws_channel;
  let rest_channel;
  let system_channel;

  /**
   * Connect the gateway library to Major Tom
   * @param {String} ws_connect_host The WebSocket host for your Major Tom instance
   * @param {String} token The Major Tom Gateway token
   * @param {String} [username] The basic auth user name
   * @param {String} [password] The basic auth password
   */
  function connect_to_mt(ws_connect_host, token, username, password) {
    const ws_regex = /^ws(s?):\/\//;

    if (ws_connect_host.search(ws_regex) !== 0) {
      throw new Error(
        'Connect to major tom with a host that includes a valid websocket protocol'
      );
    }

    const ws_host = (username && password)
      ? ws_connect_host.replace(ws_regex, `ws$1://${username}:${password}@`)
      : ws_connect_host;

    const full_ws_url =
      `${ws_host}/gateway_api/v1.0?gateway_token=${token}`;

    // Invoke ws channel with fully formed websocket url
    ws_channel = mt_ws_channel({
      full_ws_url,
      on_got_inbound,
      on_got_outbound,
      post_message,
      receive_inbound,
      set_wait_time,
      trigger_inbound,
      wait_pause,
    });
    // Invoke rest channel with the protocol + auth? & hostname, token, and post_message handling
    rest_channel = mt_rest_channel(
      ws_host.replace(ws_regex, 'http$1://'),
      token,
      post_message,
    );
  }

  /**
   * Initializes the connection beteween the gateway and the systems interface
   */
  function open_system_channel() {
    system_channel = mt_system_channel({ on_got_outbound_to_system, post_message });
  }

  /**
   * Pass a callback function to be run by the gateway whenever a message is received from Major
   * Tom. The message will be a JavaScript object.
   * @param {Function} cb Handler for receiving a message from Major Tom; receives an object
   */
  function on_mt_message(cb) {
    ws_channel.on_message_from_mt(cb);
  }

  /**
   * Callback for handling messages from the gateway library.
   * @param {Function} cb Handler for a message from the gateway library
   */
  function on_gateway_message(cb) {
    on_got_internal(cb);
  }

  /**
   * This handler can be used to specify different code to run based on receiving a message from a
   * specific system; alternatively, the user can use the `on_any_system_message` and then divert
   * messages based on the `system` property of the message received.
   * @param {String} system_name The name or identifier of a system
   * @param {Function} cb Handler for a message coming from a particular system
   */
  function on_system_message(system_name, cb) {
    system_channel.on_message(system_name, cb);
  }

  /**
   * Retrieve the connection key required for a system to connect to the gateway library over the
   * WebSocket system interface.
   * @returns {String}
   */
  function get_system_cx_key() {
    if (system_channel) {
      return system_channel.get_ws_key();
    }

    return ''
  }

  /**
   * Send a message to Major Tom
   * @param {Object|JSON} msg A message to Major Tom, must have an expected type, can be JSON or object
   */
  function to_mt(msg) {
    post_message(msg);
  }

  /**
   * This allows specific code to run when a system re-connects to the gateway. Doesn't need to be
   * used for messages, as those are automatically streamed to a queue and will be sent as soon as
   * the system connects.
   * @param {String} system_name The name or identifier of a system
   * @param {Function} cb The handler to run when the passed system re-connects
   */
  function on_system_connected(system_name, cb) {
    if (!system_name || typeof system_name !== 'string') {
      return post_message(
        new Error(
          'on_system_connected requires a system name or identifier string as its first argument'
        )
      );
    }

    if (typeof cb !== 'function') {
      return post_message(
        new Error(
          'on_system_connected requires a callback function as the second argument'
        )
      );
    }

    if (system_channel) {
      system_channel.await_connection(system_name, cb);
    }
  }

  /**
   * Closes the gateway library's WebSocket connection to Major Tom
   */
  function disconnect_from_mt() {
    if (ws_channel) ws_channel.close();
  }

  /**
   * Download the file found at the passed download path to the gateway. When this operation is
   * finished, the handler(s) passed to `on_file_download` will be called. See Major Tom Gateway
   * Documentation under "Downloading StagedFiles from Major Tom" for more details.
   * @param {String} download_path The path where the file is stored in Major Tom
   */
  function download_file_from_mt(download_path) {
    if (rest_channel) {
      rest_channel.download_file_from_mt(download_path)
    }
  }

  /**
   * Check to see if the gateway library is connected to Major Tom.
   * @returns {Boolean}
   */
  function is_connected_to_mt() {
    return (ws_channel && ws_channel.is_connected());
  }

  /**
   * Pass success and optional failure handlers for when the gateway library has finished
   * downloading a file from where it is stored in Major Tom.
   * @param {Function} success Download success handler, receives two params:
   * @param {Function} [failure] The handler for when the file download fails
   */
  function on_file_download(success, failure) {
    if (rest_channel) {
      rest_channel.handle_file_download(success, failure);
    }
  }

  /**
   * Pass success and optional failure handlers for when the gateway library has finished
   * uploading a file from the gateway to Major Tom.
   * @param {Function} success Download success handler, receives two params:
   * @param {Function} [failure] The handler for when the file download fails
   */
  function on_file_upload(success, failure) {
    if (rest_channel) {
      rest_channel.handle_file_upload(success, failure);
    }
  }

  /**
   * Allow code to be run when an HTTP(S) connection is attempted at the local WebSocket port
   * where we expect systems to connect.
   * @param {Function} cb Code to run when an http connection is attempted on the WebSocket port; receives request and response params
   */
  function on_http_request(cb) {
    if (system_channel) {
      system_channel.on_http_request(cb);
    }
  }

  /**
   * Command to upload a file in the form of a nodeJS Buffer to Major Tom.
   * @param {Buffer} File The file to upload to Major Tom, as a nodeJS Buffer
   * @param {String} file_name The file name or identifier
   * @param {String} system_name The system name or identifier
   */
  function upload_file_to_mt(File, file_name, system_name) {
    if (rest_channel) {
      rest_channel.upload_file_to_mt(File, file_name, system_name);
    }
  }

  /**
   * Pass a callback to this function that will run when any system sends a message to the gateway.
   * The callback will receive a JSON-formatted string that will have an identifying `type`
   * property. If the callback returns a value, the library's automatic behavior of attempting to
   * pass valid messages on to Major Tom will _not_ occur.
   * @param {Function} cb A function to run when any system sends a message to the gateway.
   */
  function on_any_system_message(cb) {
    system_channel.on_message_from_any(cb);
  }

  /**
   * Send a message of either JSON or a plain object to a system. Systems only run from commands, so
   * the object or JSON needs to have a `command` property, which is an object, and that `command`
   * object also must have a `system` property identifying the particular system where this command
   * should be sent.
   * @param {JSON|Object} message The message to send to a system, requiring a `system` property
   */
  function send_to_system(message) {
    const has_errors = system_channel.system_message_has_errors(message);

    if (has_errors) {
      return post_message(
        new Error('Message sent to system needs to be in correct format'),
        has_errors
      );
    }

    post_message(message);
  }

  return {
    connect_to_mt,
    disconnect_from_mt,
    download_file_from_mt,
    get_system_cx_key,
    is_connected_to_mt,
    on_file_download,
    on_file_upload,
    on_http_request,
    on_mt_message,
    on_gateway_message,
    on_system_connected,
    on_system_message,
    on_any_system_message,
    open_system_channel,
    send_to_system,
    to_mt,
    upload_file_to_mt,
  };
}

module.exports = mt_node_gateway;
