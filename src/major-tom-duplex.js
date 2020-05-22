const Stream = require('stream');
const { ONE_MINUTE, ONE_SECOND, mt_outbound_types, system_message_types } = require('./constants');
const { Duplex, PassThrough } = Stream;

const objectMode = true;
// This throttles outbound messages to a max of about 50 per second, which seems to run ok
let BASE_WAIT_TIME = 20;
// This allows us to adjust our wait time based on a rate_limit message from MT
let wait_time = BASE_WAIT_TIME;

class Outbound extends Duplex {
  constructor(opts) {
    super(opts);
    this.last_push = Date.now();
    this.data = [];
  }

  _write(chunk, encoding, callback) {
    this.data.push(chunk.toString());
    callback();
  }

  _read() {
    const right_now = Date.now();
    const diff = right_now - this.last_push;

    if (diff > wait_time) {
      this.last_push = right_now;
      this.push(this.data.shift());
    } else {
      setTimeout(() => {
        this.last_push = Date.now();
        this.push(this.data[0]);
        this.data = this.data.slice(1);
      }, wait_time - diff);
    }
  }
}

const outbound_q = new Outbound(); // Messages to MT
const internal_q = new PassThrough({ objectMode }); // Messages about the gateway for user interface
const inbound_q = new PassThrough({ objectMode }); // Messages from MT to the gateway
const system_q = new PassThrough({ objectMode }); // Messages from the gateway outbound to systems generally
const system_inbound_q = new PassThrough({ objectMode }); // Messages coming in from systems

function compose_internal_message_string(primary, info) {
  const get_message_string = obj => {
    if (typeof primary === 'string' || primary instanceof String) {
      return primary;
    }

    try {
      return JSON.stringify(primary);
    } catch (ignore) {
      if (typeof primary.toString === 'function' || primary.toString instanceof Function) {
        return primary.toString();
      }

      return 'Couldn\'t convert message to string';
    }
  }

  const is_error = primary instanceof Error;
  const internal_message = {
    type: 'gateway_internal_message',
    ...(is_error ? { error: primary.toString() } : {}),
    message: get_message_string(primary),
    info,
  };

  return JSON.stringify(internal_message);
}


function is_sendable_to_mt(message) {
  let message_obj = message;

  if (typeof message === 'string' || message instanceof String) {
    try {
      message_obj = JSON.parse(message);
    } catch (ignore) {
      return false;
    }
  }

  return mt_outbound_types[message_obj.type] ? JSON.stringify(message_obj) : false;
}

// TODO: This may need refinement: currently we check that the `type` property equals "command",
// and that a `system` property exists on the command.
function is_sendable_to_system(message) {
  let message_obj = message;

  if (typeof message === 'string' || message instanceof String) {
    try {
      message_obj = JSON.parse(message);
    } catch (ignore) {
      return false;
    }
  }

  const is_sendable = message_obj.type === 'command' &&
    message_obj.command &&
    !!message_obj.command.system;

  return is_sendable
    ? JSON.stringify(message_obj)
    : false;
}

function on_got_internal(callback) {
  internal_q.on('data', function(data) {
    callback(data);
  });
}

function on_got_outbound(should_send) {
  if (!(typeof should_send === 'function' || should_send instanceof Function)) {
    throw new Error('This method expects a function that returns a send callback when it's OK to send');
  }

  const [prev_listener] = outbound_q.rawListeners('readable');

  if (prev_listener) {
    outbound_q.removeListener('readable', prev_listener);
  }

  outbound_q.on('readable', function() {
    const send_cb = should_send();

    if (typeof send_cb === 'function') {
      send_cb(outbound_q.read());
    }
  });
}

function on_got_outbound_to_system(callback) {
  system_q.on('data', function(data) {
    callback(data);
  });
}

function on_got_inbound(ready_to_handle) {
  if (!(typeof ready_to_handle === 'function' || ready_to_handle instanceof Function)) {
    throw new Error('Pass a higher order function to on_got_outbound');
  }

  const [prev_listener] = inbound_q.rawListeners('data');
  const data_listener = function(chunk) {
    const inbound_handler = ready_to_handle();

    if (inbound_handler && typeof inbound_handler === 'function') {
      // If the handler is ready to handle the chunk, handle it
      inbound_handler(chunk);
    } else {
      // But if it's not, pause the stream, then put that chunk back on the tip of it
      inbound_q.pause();
      inbound_q.unshift(chunk);
    }
  };

  if (prev_listener) {
    inbound_q.removeListener('data', prev_listener);
  }

  inbound_q.on('data', data_listener);
}

function trigger_inbound() {
  inbound_q.resume();
}

function open(any_stream) {}

function pause(any_stream) {
  if (!any_stream || !any_stream.readableFlowing) return;

  any_stream.pause();
}

function receive_inbound(external_source) {
  const sources = {
    major_tom: inbound_q,
    system: system_inbound_q,
  };

  return function inbound_message_receiver(data) {
    let message_data = data;

    if (typeof data === 'string' || data instanceof String) {
      try {
        message_data = JSON.parse(data);
      } catch (parse_error) {
        write_to_queue(parse_error, data);
        return;
      }
    }

    if (data.data) {
      message_data = data.data;
    }

    const q_to_write = sources[external_source];

    if (!q_to_write) {
      write_to_queue(new Error('Did not understand message source'), message_data);
      return;
    }

    q_to_write.write(message_data);
  }
}

function post_message(primary, info) {
  const send_to_mt = is_sendable_to_mt(primary);
  const send_to_system = is_sendable_to_system(primary);

  if (send_to_mt) {
    outbound_q.write(send_to_mt);
    return;
  }

  if (send_to_system) {
    system_q.write(send_to_system);
    return;
  }

  write_to_queue(primary, info);
}

function write_to_queue(primary, info) {
  internal_q.write(compose_internal_message_string(primary, info));
}

function wait_pause(seconds) {
  const as_number = Number(seconds);

  if (Number.isFinite(as_number)) {
    const next_wait_time = as_number * ONE_SECOND;

    wait_time = next_wait_time;

    const return_to_baseline = setTimeout(() => {
      clearTimeout(return_to_baseline);
      wait_time = BASE_WAIT_TIME;
    }, next_wait_time + BASE_WAIT_TIME);
  }
}

function set_wait_time(per_minute) {
  const as_number = Number(per_minute);

  if (Number.isFinite(as_number)) {
    BASE_WAIT_TIME = Math.ceil(ONE_MINUTE / as_number);
  }
}

function mt_queues() {
  return {
    on_got_inbound,
    on_got_internal,
    on_got_outbound,
    on_got_outbound_to_system,
    post_message,
    receive_inbound: receive_inbound('major_tom'),
    receive_system: receive_inbound('system'),
    set_wait_time,
    trigger_inbound,
    wait_pause,
  };
}

module.exports = mt_queues;
