const WebSocketServer = require('websocket').server;
const https = require('http');
const { PassThrough, Transform } = require('stream');

function mt_system_channel_ws(connections) {
  const { post_message, on_got_outbound_to_system: on_message_for_system } = connections;
  const PORT = process.env.PORT || 8513;
  const ws_key = '000000gateway';
  const connection_timers = {};
  const waiting_connections = {};
  const connection_bus = {};
  const system_callbacks = {};
  let http_request_callback;
  let any_system_callback;

  const httpServer = https.createServer(function (request, response) {
    if (get_http_request_callback()) {
      http_request_callback(request, response);
    } else {
      response.statusCode = 200;
      response.write('You have reached the end of the internet');
      response.end();
    }
  });

  const ws_server = new WebSocketServer({
    autoAcceptConnections: false,
    httpServer,
  });

  function get_http_request_callback() {
    return http_request_callback;
  }

  /**
   * This determines if the resource requesting a connection has the correct key to connect
   * to the channel.
   * TODO: This should probably be user-defined, or allow the user to over-rule this logic
   * @param {String} resource The string representing the resource that is requesting a connection
   */
  function valid_resource_request(resource) {
    const [match_key, encoded_sys_name] = resource.split('/')
      .filter(function(item) {
        return !!item;
      });
    const system_name = encoded_sys_name && decodeURI(encoded_sys_name);

    if (match_key !== ws_key) {
      return false;
    }

    if (!system_name) {
      return false;
    }

    if (
      connection_bus[system_name] &&
      connection_bus[system_name].ws_cx &&
      connection_bus[system_name].ws_cx.connected
    ) {
      return false;
    }

    return system_name;
  }

  function get_ws_key() {
    return ws_key;
  }

  function on_message(system_name, cb) {
    if (typeof cb !== 'function') {
      throw new Error(`System callback requires a system name and a function`);
    }

    system_callbacks[system_name] = cb;
  }

  function on_message_from_any(cb) {
    if (!(typeof cb !== 'function' || cb instanceof Function)) {
      post_message(
        new Error('You must pass a callback to run when a message is received from any system')
      );
    }

    any_system_callback = cb;
  }

  function set_connection_timer(system_name) {
    if (connection_timers[system_name]) {
      clearTimeout(connection_timers[system_name]);
    }

    connection_timers[system_name] = setTimeout(function () {
      connection_bus[system_name].ws_cx.close();
      delete connection_bus[system_name];
    }, 120 * 60 * 1000); // 120 minutes;
  }

  function update_connected(system_name, ws_cx) {
    if (!connection_bus[system_name]) {
      const sys_duplex = new PassThrough();

      connection_bus[system_name] = { ws_cx, q: sys_duplex };

      sys_duplex.on('data', function(chunk) {
        const my_cx = connection_bus[system_name].ws_cx;

        if (my_cx && my_cx.connected) {
          my_cx.send(chunk.toString());
        } else {
          sys_duplex.pause();
          sys_duplex.unshift(chunk);
        }
      });

    } else if (ws_cx) {
      connection_bus[system_name].ws_cx = ws_cx;

      if (waiting_connections[system_name]) {
        waiting_connections[system_name]();
      }

      if (connection_bus[system_name].q.isPaused()) {
        connection_bus[system_name].q.resume();
      }
    }
  }

  /**
   * This method allows the user to call a one-time function when the indicated system connects
   * to the gateway.
   * @param {String} system_name The system we're waiting to hear is connected
   * @param {Function} cb One-time function to execute when this system connects
   */
  function await_connection(system_name, cb) {
    if (!system_name || typeof system_name !== 'string') {
      throw new Error(
        'await_connection takes a system name string as its first argument'
      );
    }

    if (typeof cb !== 'function') {
      throw new Error(
        'await_connection requires a callback function as its second argument'
      );
    }

    waiting_connections[system_name] = cb;
  }

  function on_http_request(cb) {
    if (typeof cb !== 'function') {
      throw new Error('on_http_request requires a function as its argument');
    }

    http_request_callback = cb;
  }

  function system_message_has_errors(message) {
    // TODO: Validate the passed message against the system websocket interface api.
    return false;
  }

  ws_server.on('request', function (incoming) {
    const { origin, resource } = incoming;
    const system_name = valid_resource_request(resource);

    if (!system_name) {
      incoming.reject();
      post_message(
        // TODO: This probably should be an event or warning to MT? A system attempted to connect
        // but was rejected by the gateway...?
        `${new Date()} : Connection from origin ${origin} rejected`
      );
    } else {
      const connection = incoming.accept(null, origin);

      connection.on('message', function(ws_message) {
        const { data, utf8Data } = ws_message;
        const message = data || utf8Data;

        return (
          // returning a value from an individual system callback or from any_system_callback will
          // prevent the lib from automatically sending the message to MT.
          (system_callbacks[system_name] && system_callbacks[system_name](message, system_name)) ||
          (any_system_callback && any_system_callback(message)) ||
          post_message(message)
        );
      });

      connection.on('error', function() {
        try {
          connection_bus[system_name].ws_cx.close();
        } catch (e) {
          connection_bus[system_name].ws_cx = undefined;
          postMessage(e);
        }
      });

      set_connection_timer(system_name);

      update_connected(system_name, connection);
    }
  });

  on_message_for_system(function(json_data) {
    const message_obj = JSON.parse(json_data);
    const system = message_obj.system || (message_obj.command && message_obj.command.system);

    if (!connection_bus[system]) {
      update_connected(system);
    }

    connection_bus[system].q.write(json_data);
  });

  // TODO: This should be configurable by the implementer. Also, we should probably log this more
  // responsibly than just to the console.
  httpServer.listen(PORT, function () {
    console.log(`The websocket server is listening on port ${PORT}`);
  });

  return {
    await_connection,
    get_ws_key,
    on_message,
    on_message_from_any,
    on_http_request,
    system_message_has_errors,
  };
}

module.exports = mt_system_channel_ws;
