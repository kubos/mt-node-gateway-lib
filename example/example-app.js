const chalk = require('chalk');
const app = require('../index.js');

function example_gateway(host, token, username, password) {
  /**
   * This object can be used to identify which commands we want to handle locally on the gateway.
   */
  const manageOnGateway = { downlink_file: true };
  const interceptTypes = { file_chunk: true };
  const gatewayIsManaging = {};

  /**
   * This object is for working with files, where we'll store the Arrays of bytes while they're
   * being downlinked from a system.
   */
  const workingFiles = {};

  /**
   * A utility method for sending to Major Tom, and logging the message being sent in the console.
   * @param {Object} obj Object in correct format for sending to Major Tom
   */
  const gatewayToMajorTom = obj => {
    const message = JSON.stringify(obj);
    gateway.to_mt(message);
    console.log(chalk.magentaBright('FROM GATEWAY TO MAJOR TOM:\n'), message);
  };

  /**
   * We define a method to both pass the message along to the system, and also update Major Tom that
   * we've started preparing the command on the gateway.
   * @param {Object} msg The message object received from Major Tom
   */
  const sendToSystem = msg => {
    // We received a message of type `command`, but we want to send Major Tom a message of type
    // `command_update`, so we locate the command object inside the message and add the new state.
    const { command } = msg;

    gatewayToMajorTom({
      type: 'command_update',
      command: { ...command, state: 'preparing_on_gateway' },
    });

    gateway.send_to_system(msg);
  };

  /**
   * Method for handling the `downlink_file` command; specifically we will add the command id to our
   * hash of commands being actively managed, and send the message along to the system.
   * @param {Object} msg The message containing the `downlink_file` command received from Major Tom
   */
  const manageDownlinkFile = msg => {
    const { command = {} } = msg;
    const { id } = command;

    gatewayIsManaging[id] = true;
    sendToSystem(msg);
  };

  // Here are two small methods used for success and failure handlers for the file upload operation:
  const uploadSuccess = id => () => {
    gatewayToMajorTom({
      type: 'command_update',
      command: { id, state: 'completed' },
    });
    delete gatewayIsManaging[id];
  };

  const uploadFailure = id => error => {
    gatewayToMajorTom({
      type: 'command_update',
      command: { id, state: 'failed', errors: [error.toString()] },
    });
    delete gatewayIsManaging[id];
  };

  /**
   * We define a handler when the system tells us it's sending us just a chunk of a file. We use the
   * workingFiles object to keep track of the arrays of bytes we're receiving in the chunk property
   * of the object sent from the system.
   * @param {Object} obj The message object received from the system
   */
  const handleFileChunk = obj => {
    const { chunk, system, file_name, command_id } = obj;
    const fileKey = `_n${system}_${file_name}`.replace(/-/g, '#');

    // Our systems API tells us that a message of type `file_chunk` where the `chunk` property has
    // the value "complete" indicates that the system has finished sending the bytes of the file.
    if (chunk === 'complete') {
      // since we know it's complete, we'll let Major Tom know that the system has finished, and
      // we're now doing some work on the gateway. Then we'll set the success and failure handlers
      // on the upload operation. Then we'll convert the Array of bytes into a Buffer and send it to
      // Major Tom.
      gatewayToMajorTom({
        type: 'command_update',
        command: {
          id: command_id,
          state: 'processing_on_gateway',
          status: 'Uploading file to Major Tom over REST'
        },
      });

      gateway.on_file_upload(uploadSuccess(command_id), uploadFailure(command_id));
      gateway.upload_file_to_mt(Buffer.concat(workingFiles[fileKey]), file_name, system);

      // We'll delete the Array locally.
      delete workingFiles[fileKey];

      // And this indicates we're done.
      return;
    }

    // If we're not done, concatenate the existing Array we've saved locally with the chunk we
    // received from the system.
    workingFiles[fileKey] = [...(workingFiles[fileKey] || []), Uint8Array.from(chunk)];
  };

  const interceptFromSystem = msg => {
    const { type, command = {} } = msg;
    const incomingId = msg.id || msg.command_id || (msg.command && msg.command.id);
    const alreadyManaging = gatewayIsManaging[incomingId];

    if (alreadyManaging && command.state === 'processing_on_gateway') {
      return true;
    }

    if (interceptTypes[type]) return true;

    return false;
  };

  /**
   * This is a placeholder method where we could execute local functions based on the command types
   * we define above that we want to run code here on the gateway before sending anywhere else.
   * @param {Object} msg The command object from Major Tom
   */
  const manageCommandOnGateway = msg => {
    const { command: { type } } = msg;

    if (type === 'downlink_file') {
      return manageDownlinkFile(msg);
    }
  };

  const manageReceivedFromSystem = msg => {
    const { type } = msg;

    if (type === 'file_chunk') {
      return handleFileChunk(msg);
    }
  };

  /**
   * We define a method where we handle incoming messages from Major Tom, diverting them to be
   * handled locally on the gateway, sent on to system, or simply logged here at the gateway.
   * @param {Object} msg The message object from Major Tom
   */
  const handleMessageFromMT = msg => {
    const { command = {}, type } = msg;

    console.log(chalk.green('FROM MAJOR TOM:\n'), JSON.stringify(msg));

    if (type === 'command') {
      if (manageOnGateway[command.type]) {
        return manageCommandOnGateway(msg);
      }

      sendToSystem(msg);
    }

    // Returning true indicates to the library that we're handling the messaging from the gateway to
    // the systems, and we don't want the library to automatically pass messages along to the system
    // without checking with us first.
    return true;
  };

  /**
   * We define a method to receive the messages from the systems over the WebSocket API, where we
   * can handle those messages based on local logic. This method returns a Boolean because we want
   * to interrupt the default behavior of the gateway library that will pass a message from a system
   * straight on to Major Tom without allowing for any local processing or evaluation.
   * @param {String} message The JSON formatted string we'll receive from the WebSocket API
   * @returns {Boolean|Undefined}
   */
  const handleMesageFromSystem = message => {
    const msg = JSON.parse(message);
    const { command = {}, type } = msg;
    const { id, state: state_from_sat } = command;

    // Our WebSocket API tells us that if the system is downlinking a file through that API, it will
    // inform us of that by setting the `type` property of the message to the string "file_chunk"
    if (interceptFromSystem(msg)) {
      return manageReceivedFromSystem(msg);
    }

    // Otherwise send the message along to Major Tom, and log it.
    gateway.to_mt(message);
    console.log(chalk.blue('FROM SYSTEMS:\n'), message);

    // We also know from our WebSocket API that when the system sends us a message with the state
    // of "processing_on_gateway", we know the system has finished it's work.
    if (id && state_from_sat === 'processing_on_gateway') {
      // With this simple gateway, we'll just update Major Tom that the command has completed.
      // However, we could also do some other local logic if needed here.
      gatewayToMajorTom({
        type: 'command_update',
        command: { id, state: 'completed' },
      });
    }

    return true;
  };

  const handleGatewayDebug = message => {
    console.log(chalk.yellow('GATEWAY LOG:\n'), message);
  };

  // Set up the gateway itself
  const gateway = app();

  // This opens the WebSocket connection to Major Tom, and also gives the REST conection the
  // connection information it will need to make REST calls to Major Tom, used for file upload and
  // download.
  gateway.connect_to_mt(host, token, username, password);

  // This opens the gateway library's WebSocket channel which gives us some shorthands for
  // interacting with systems over this library's WebSocket API. However, the user can configure and
  // use their own implementation for transmitting messages from their gateway to their systems.
  gateway.open_system_channel();

  // Attach our specific handlers for when we get messages from MT, from a system, or a gateway log
  gateway.on_mt_message(handleMessageFromMT);
  gateway.on_any_system_message(handleMesageFromSystem);
  gateway.on_gateway_message(handleGatewayDebug);

  return gateway;
}

const args = [...process.argv.slice(2)];
const hostAndToken = [
  args[0] || 'wss://app.majortom.cloud',
  process.env.GATEWAY_TOKEN || args[1],
];

example_gateway(...[...hostAndToken, ...args.slice(2)]);
